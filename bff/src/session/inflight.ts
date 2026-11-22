/**
 * The journal of what this BFF forwarded upstream and never got an answer for.
 *
 * The BFF owns the one permanent upstream socket, and when that socket drops everything it had just
 * written is gone: the browser waits out its own request timeout for an answer that will never arrive,
 * and a message typed in that window disappears while its bubble stays on screen pretending otherwise.
 * Upstream solved the same problem for its own outbound requests in letta-code #5761 — reconnect, re-send
 * the identical command because the listener de-dupes it, and if even that is unconfirmed say "may not
 * have been delivered" instead of "failed". This is that pattern for the browser's requests.
 *
 * Two facts the whole design rests on, both from upstream source:
 *
 * - An `input` is de-duped by its **`client_message_id`**, not by its `request_id`
 *   (`letta-code/src/websocket/listener/input-disposition.ts` — the identity is
 *   `{domain: "input", id: clientMessageId}` and the ledger key is runtime + that id). A repeat under the
 *   same id is admitted as a duplicate and the turn is not run twice, which is what licenses re-sending a
 *   user message at all. It is also why a re-send must reuse the id rather than mint a fresh one.
 * - Nothing de-dupes a command that has no such key. Re-applying a `write_file` or a rename the server may
 *   already have applied is worse than telling the caller the outcome is unknown, so those are never
 *   re-sent — they are only reported.
 */

/** What a journaled request is allowed to do when the connection comes back. */
export type InFlightKind =
  /** Safe to send again: an idempotent read, or an `input` the listener will de-dupe. */
  | "retry"
  /** Must not be sent again; its outcome is simply unknown, and the caller is told so. */
  | "uncertain";

export interface InFlightEntry {
  /** The BFF-issued id the answer will come back under. Also the browser's key in `pendingRequests`. */
  requestId: string;
  /** The id the browser asked with, for reporting the outcome back to it. */
  originalId: string;
  sessionId: string;
  /** Conversation scope, when the command carried one. Only for the tally in the log. */
  scopeKey: string | null;
  /** The exact frame that went out, re-sent verbatim so the ids stay identical. Only kept when it can
   * still be re-sent: an `uncertain` entry can never be written again, and its frame is where a
   * `write_file` body or an `input`'s inline images would sit in memory for nothing. */
  frame?: Record<string, unknown> & { type: string };
  kind: InFlightKind;
  sentAt: number;
  /** Set once the frame has been re-sent; a second drop makes it uncertain, never re-sent twice. */
  resent?: boolean;
}

/** What one reconnect pass should do, split the way the caller must report it. */
export interface ReconnectPass {
  /** Frames to write again, in the order they were first sent. */
  resend: InFlightEntry[];
  /** Requests whose outcome is unknown: report them, do not re-send. Includes the expired ones. */
  report: InFlightEntry[];
  /** How many of `report` are in it only because they grew too old to replay. */
  expired: number;
}

/**
 * Commands whose answer is safe to wait for twice. A read of state that has already been read is a no-op
 * whatever the server does with the duplicate, so these are re-sent even though nothing de-dupes them.
 */
const IDEMPOTENT_TYPES = new Set([
  "read_file",
  "get_tree",
  "grep_in_files",
  // Deliberately not `list_memory`: its answer is a chunk stream that the registry merges into one
  // accumulator, so a re-send under the same id appends a second copy of every entry to the first copy.
  "agent_list",
  "conversation_list",
  "conversation_messages_list",
  "sync",
]);

/**
 * Decide what a forwarded command may do after a reconnect.
 *
 * `input` is the interesting case: it is only re-sent when the message carries the `client_message_id`
 * the listener de-dupes on, and that id is what the caller must keep for the re-send. Anything unlisted
 * here is a mutation or a command whose duplicate behavior is unproven, so it is reported, not retried.
 */
export function classify(command: Record<string, unknown>): InFlightKind | null {
  if (IDEMPOTENT_TYPES.has(command.type as string)) return "retry";
  if (command.type === "input" && hasClientMessageId(command)) return "retry";
  // A command with no request_id cannot be answered to its caller, so it is not journaled at all.
  if (typeof command.request_id !== "string") return null;
  return "uncertain";
}

/** Whether every user message in an `input` payload carries a de-dupable `client_message_id`. */
function hasClientMessageId(command: Record<string, unknown>): boolean {
  const payload = command.payload as { kind?: unknown; messages?: unknown } | undefined;
  if (!payload || payload.kind !== "create_message" || !Array.isArray(payload.messages))
    return false;
  return (
    payload.messages.length > 0 &&
    payload.messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        typeof (message as { client_message_id?: unknown }).client_message_id === "string",
    )
  );
}

/**
 * How long an entry is worth re-sending. Past this the asking tab has already given up — its own request
 * timeout is shorter than the worst reconnect this is meant to survive — and a command applied late is
 * worse than one that is lost, so it is dropped rather than replayed.
 */
export const INFLIGHT_TTL_MS = 25_000;

/**
 * Ceiling on journaled requests, across every session. Same reasoning as the per-session pending bound
 * it sits beside: upstream does not always answer, and an unbounded journal would grow for the life of the
 * process. Oldest goes first, which is also the least likely to be wanted.
 */
export const MAX_INFLIGHT = 500;

/**
 * Insertion-ordered map of unacked requests, with the classification and the reconnect split kept next to
 * the data they describe. Pure bookkeeping: it never touches a socket, so it is testable on its own.
 */
export class InFlightJournal {
  private readonly entries = new Map<string, InFlightEntry>();

  get size(): number {
    return this.entries.size;
  }

  record(entry: InFlightEntry): void {
    this.entries.set(entry.requestId, entry);
    while (this.entries.size > MAX_INFLIGHT) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** A request that answered, or whose session is gone, is no longer anyone's to retry. */
  settle(requestId: string): void {
    this.entries.delete(requestId);
  }

  settleSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(id);
    }
  }

  get(requestId: string): InFlightEntry | undefined {
    return this.entries.get(requestId);
  }

  /**
   * Split what is journaled into what to re-send and what to report.
   *
   * Everything leaves the journal here: a re-sent frame is re-recorded by the caller only if it is written
   * again, and a reported request is never raised twice. That is also what keeps a second reconnect from
   * turning one request into two re-sends.
   *
   * An entry older than the TTL goes to `expired` rather than either: the tab that asked has moved on, and
   * replaying a stale command under a dead request id produces an answer nobody is listening for.
   */
  takeForReconnect(now: number, ttlMs = INFLIGHT_TTL_MS): ReconnectPass {
    const resend: InFlightEntry[] = [];
    const report: InFlightEntry[] = [];
    let expired = 0;
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.requestId);
      // Too old to replay — the asking tab has given up and a stale command applied late is worse than
      // one lost — but it is still worth telling the tab that the outcome is unknown, which is what
      // `expired` counts rather than dropping silently.
      if (now - entry.sentAt > ttlMs) {
        expired += 1;
        report.push(entry);
      } else if (entry.resent || entry.kind !== "retry" || !entry.frame) {
        // Already re-sent once (upstream's one-retry rule), or never re-sends: the outcome is unknown.
        report.push(entry);
      } else {
        resend.push(entry);
      }
    }
    return { resend, report, expired };
  }
}
