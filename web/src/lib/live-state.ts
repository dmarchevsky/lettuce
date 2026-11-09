/**
 * The live-state rules of a conversation, kept apart from the React that holds
 * the state they decide.
 *
 * What the transcript looks like lives in `lib/messages.ts`: pure, tested. What
 * stayed inside `use-conversation` were three small decisions about the
 * live-only state the app-server stores nowhere — whether a status frame may move
 * the working indicator, whether it survives a turn boundary, and when the stall
 * watchdog is due to ask the app-server what it believes. One of the three was
 * written twice and held together by a comment, which is the whole argument for
 * pulling them out: these are the rules a lost or reordered frame trips over, and
 * none of them needs a DOM to test.
 */

/** How long past the stall warning the probe waits before asking (see `stallProbeDue`). */
export const STALL_PROBE_GRACE_MS = 15_000;

/**
 * How long the queue must hold an item before the strip may show it.
 * One tuned constant: raise it if a flash survives, lower it if a real
 * queue feels late (see `queueRevealDecision`).
 */
export const QUEUE_REVEAL_GRACE_MS = 400;

/** The hidden strip's items: one frozen empty, so hiding never re-renders. */
export const QUEUE_HIDDEN: readonly { paused: boolean; id: string }[] = [];

/**
 * The force-send seam. Esc aborts a turn and its replacement is sent behind the
 * abort, and through that gap the app-server's own frames say "not processing"
 * while the replacement's start frames can arrive before the aborted turn's
 * `turn_finished`. So while the seam is open only a frame that says *busy* may
 * move the indicator, and the seam closes at `turn_finished` and nowhere else.
 *
 * Two frame kinds carry the seam (`update_device_status`, `update_loop_status`),
 * which is why the rule is one function: two copies agreed only because a
 * comment pointed from one to the other.
 */
export function seamAllowsFlip(expectResentTurn: boolean, busy: boolean): boolean {
  return !expectResentTurn || busy;
}

/**
 * Whether the working indicator survives one turn's end. A ready queued item
 * means the pump starts the next turn the moment this one unwinds, so the dots
 * must not blink off in between; items parked by an interrupt are paused and
 * will not start, so they do not hold it on.
 */
export function indicatorStaysOn(queue: readonly { paused: boolean }[]): boolean {
  return queue.some((item) => !item.paused);
}

/**
 * Whether the queue strip reveals itself, hides, or waits.
 *
 * The listener enqueues *every* inbound message — even the send that starts
 * an idle agent — and drains it immediately, so the snapshots arrive as
 * non-empty-then-empty within a frame pair: the strip would flash a Steer
 * pill for a queue that never waited. So a strip reveals only once the queue
 * has held an item continuously for `QUEUE_REVEAL_GRACE_MS`. A paused item
 * reveals at once: a parked queue is persistent state — the Resume verb must
 * be reachable — and pausing always happens long after the client learned of
 * the items, so that branch can never serve a flash.
 *
 * `revealed` is what the strip currently shows, `sinceMs` when the raw queue
 * went non-empty, `nowMs` the same clock (`performance.now`). The decision is
 * pure because the race it settles is frame timing, not layout: the caller
 * keeps the clock and the timer, exactly as it runs the force-send seam.
 */
export function queueRevealDecision(
  queue: readonly { paused: boolean }[],
  revealed: boolean,
  sinceMs: number | null,
  nowMs: number,
): "hide" | "show" | "arm" | "keep" {
  if (queue.length === 0) return revealed ? "hide" : "keep";
  if (queue.some((item) => item.paused)) return "show";
  if (revealed) return "keep";
  return sinceMs !== null && nowMs - sinceMs >= QUEUE_REVEAL_GRACE_MS ? "show" : "arm";
}

/**
 * Whether a revealed strip's items are stale: the queue mutated while shown
 * (a second send, an edit, a delete), and the chips must be rewritten to the
 * live list rather than frozen at reveal time.
 */
export function queueShownIsStale(
  queue: readonly { id: string }[],
  shown: readonly { id: string }[],
): boolean {
  return queue.length !== shown.length || queue.some((item, i) => shown[i]?.id !== item.id);
}

/**
 * Whether the stall watchdog asks the app-server for its opinion right now.
 *
 * Once per turn (the caller clears `probed` when `processing` goes false), never
 * while an abort is in flight, and only after the warning would already be
 * showing — a client-side stranding then self-heals seconds after the warning
 * would appear, while a genuinely hung turn is reported truthfully and keeps it.
 */
export function stallProbeDue(input: {
  probed: boolean;
  stopping: boolean;
  lastActivityAt: number | null;
  now: number;
  stallAfterMs: number;
}): boolean {
  if (input.probed || input.stopping || input.lastActivityAt === null) return false;
  return input.now - input.lastActivityAt >= input.stallAfterMs + STALL_PROBE_GRACE_MS;
}
