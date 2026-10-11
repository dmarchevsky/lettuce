/**
 * The phone's Back button closes the top modal, not the app.
 *
 * Every open overlay owns one browser-history entry. Back pops it (popstate)
 * and the top overlay closes. An overlay closed on screen instead leaves its
 * entry behind; that "stale" entry is removed with a deferred `history.back()`
 * whose popstate is ignored — deferred, because an overlay often replaces
 * another in the same render ("New agent" closes the switcher and opens the
 * agent editor), and the new one simply takes over the stale entry.
 *
 * An overlay whose close returns `false` cannot be dismissed (an approval
 * prompt): Back is swallowed and its entry re-pushed, so the app neither
 * closes the prompt nor exits underneath it.
 */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  back(): void;
}

/** A truthy return tells the stack the Back press was used. `void` stays in the
 * union because callers hand over state setters — `() => setMenuFor(null)` —
 * which return nothing, and dropping it would refuse them at the call site. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is what accepts `() => setMenuFor(null)` as a close handler; boolean | undefined alone refuses it.
export type Close = () => boolean | void;

const MARKER = { lettaOverlay: true };

export class BackStack {
  private readonly entries: { close: Close }[] = [];
  /** History entries whose overlay was closed on screen, not yet removed. */
  private stale = 0;
  /** popstate events this class caused itself. */
  private ignore = 0;

  constructor(
    private readonly history: HistoryLike,
    private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {}

  get depth(): number {
    return this.entries.length;
  }

  /** Register an open overlay; the returned function is called when it goes away. */
  open(close: Close): () => void {
    const entry = { close };
    this.entries.push(entry);
    if (this.stale > 0) this.stale -= 1;
    else this.history.pushState(MARKER, "");
    return () => {
      const index = this.entries.indexOf(entry);
      if (index === -1) return; // Back already removed it.
      this.entries.splice(index, 1);
      this.stale += 1;
      this.defer(() => {
        if (this.stale === 0) return; // Reused by an overlay that opened meanwhile.
        this.stale -= 1;
        this.ignore += 1;
        this.history.back();
      });
    };
  }

  onPopState(): void {
    if (this.ignore > 0) {
      this.ignore -= 1;
      return;
    }
    if (this.stale > 0) {
      // Back landed on an entry whose overlay is already gone; it is consumed.
      this.stale -= 1;
      return;
    }
    const top = this.entries.pop();
    if (!top) return;
    if (top.close() === false) {
      this.entries.push(top);
      this.history.pushState(MARKER, "");
    }
  }
}
