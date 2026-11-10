import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

/**
 * Which live-only frames a state replay re-primes, and which the BFF therefore
 * has to keep in order to answer a repeat start without one.
 *
 * These are the three the web client reads for `processing`, the queue and the
 * status pill (`use-conversation.ts`): the app-server stores none of them, so a
 * conversation opened without its replay would show a turn that ended, or miss
 * one that is running. The BFF routes all three anyway, so keeping the newest of
 * each costs three objects per conversation and buys the whole replay.
 */
const LIVE_STATE_FRAMES = new Set(["update_device_status", "update_queue", "update_loop_status"]);

/**
 * How long a remembered `is_processing: true` stays believable.
 *
 * A running turn keeps the frames coming; a minute of silence with the flag set
 * means either a frame was lost or the turn is wedged, and in both cases the
 * answer worth giving the browser is the app-server's, not the BFF's copy. Same
 * threshold the web client's stall watchdog uses (`web/src/lib/working.ts`), so
 * the two agree on when "quiet" stops meaning "idle".
 */
export const STALE_AFTER_MS = 60_000;

/** Conversations remembered at once; the least recently seen is dropped first. */
export const CACHE_SCOPES = 200;

/**
 * The fields a cached answer may stand in for.
 *
 * A plain conversation open sends exactly these. Anything else on the command —
 * a permission `mode`, `execution_settings`, `external_tools`, `create_agent`,
 * `skill_sources`, a teleport id — is a different question than "is this
 * runtime up?", and only the app-server can answer it, so an unknown field
 * forwards. Listing the allowed set rather than the known-bad ones is the point:
 * a field added upstream later is refused until someone says otherwise here.
 */
const CACHEABLE_FIELDS = new Set([
  "type",
  "request_id",
  "agent_id",
  "conversation_id",
  "cwd",
  "wait_for_replay",
]);

/** What a start is answered for: the conversation, and the `cwd` it was started at. */
export interface StartScope {
  scopeKey: string;
  /** Normalized so an absent `cwd` and `cwd: null` are two different answers. */
  cwd: string;
}

/**
 * The start this cache can answer for, or null when only upstream can.
 *
 * Pure, so the rule that keeps a cached answer honest is testable without a
 * connection — and the refusals are the interesting half.
 */
export function startScopeOf(
  command: Record<string, unknown>,
  scopeKeyOf: (agentId: string, conversationId: string) => string,
): StartScope | null {
  for (const key of Object.keys(command)) {
    if (!CACHEABLE_FIELDS.has(key)) return null;
  }
  if (command.wait_for_replay !== true) return null;
  const agentId = command.agent_id;
  const conversationId = command.conversation_id;
  if (typeof agentId !== "string" || typeof conversationId !== "string") return null;
  const cwd = command.cwd;
  if (cwd !== undefined && cwd !== null && typeof cwd !== "string") return null;
  return {
    scopeKey: scopeKeyOf(agentId, conversationId),
    // `undefined` (omitted) and `null` (reset to the listener's boot directory)
    // are different requests, so neither may be answered with the other.
    cwd: cwd === undefined ? "(omitted)" : (cwd ?? "(null)"),
  };
}

interface RememberedStart {
  /** The `cwd` the start that was answered with was made at. */
  cwd: string;
  /** The upstream connection this start belongs to — see `Registry.generation`. */
  generation: number;
  /** Newest of each live-state frame seen since the start, keyed by frame type. */
  readonly frames: Map<string, WsProtocolMessage>;
  /** When the newest of those frames was seen, in `now()` terms. */
  at: number;
}

/**
 * Conversations whose runtime this BFF connection has started, with the live
 * state last seen for each.
 *
 * The permanent upstream connection already has these runtimes up and
 * subscribed, so a browser re-opening a conversation is asking for something
 * whose answer the BFF has been routing all along. Answering it locally is the
 * whole point: upstream resolves a `wait_for_replay` start only after re-emitting
 * state, which costs about 3.5 s of main-thread `fsync` during which the
 * app-server answers nobody else (prod: dmarchevsky/lettuce#114).
 *
 * Everything here is scoped to the current connection and is forgotten on a
 * reconnect, because after one the app-server may have restarted and nothing
 * upstream is known to be running.
 */
export class RuntimeStartCache {
  private readonly scopes = new Map<string, RememberedStart>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A start upstream answered with success: this conversation is up at `cwd`. */
  remember(scopeKey: string, cwd: string, generation: number): void {
    let entry = this.scopes.get(scopeKey);
    if (!entry) {
      entry = { cwd, generation, frames: new Map(), at: this.now() };
      this.scopes.set(scopeKey, entry);
    } else {
      // Re-insert so Map order tracks recency; the least seen scope evicts first.
      this.scopes.delete(scopeKey);
      entry.cwd = cwd;
      entry.generation = generation;
      this.scopes.set(scopeKey, entry);
    }
    if (this.scopes.size > CACHE_SCOPES) {
      const oldest = this.scopes.keys().next();
      if (!oldest.done) this.scopes.delete(oldest.value);
    }
  }

  /** Keep the newest live-state frame, which is what a cached answer replays. */
  noteFrame(scopeKey: string, frame: WsProtocolMessage): void {
    const entry = this.scopes.get(scopeKey);
    if (!entry || !LIVE_STATE_FRAMES.has(frame.type)) return;
    entry.frames.set(frame.type, frame);
    entry.at = this.now();
  }

  /** A turn failed: the runtime's state is no longer something to vouch for. */
  forget(scopeKey: string): void {
    this.scopes.delete(scopeKey);
  }

  /** The connection is gone: nothing upstream is known to be running. */
  clear(): void {
    this.scopes.clear();
  }

  /**
   * The frames to hand a browser instead of its replay, or null to forward.
   *
   * Null is the safe answer as often as it is the slow one, so each reason is
   * its own line: a different `cwd` starts a different runtime; a foreign
   * generation is a different connection; no frames would answer a question
   * about live state by saying nothing; and a minute-silent `is_processing` is a
   * claim, not an observation.
   */
  replayFor(
    scopeKey: string,
    cwd: string,
    generation: number,
    staleAfterMs = STALE_AFTER_MS,
  ): WsProtocolMessage[] | null {
    const entry = this.scopes.get(scopeKey);
    if (!entry) return null;
    if (entry.generation !== generation || entry.cwd !== cwd) return null;
    if (entry.frames.size === 0) return null;
    if (this.processingOf(entry) && this.now() - entry.at > staleAfterMs) return null;
    return [
      entry.frames.get("update_device_status"),
      entry.frames.get("update_loop_status"),
      entry.frames.get("update_queue"),
    ].filter((frame): frame is WsProtocolMessage => frame !== undefined);
  }

  /** The app-server's own `is_processing` for the conversation, as last heard. */
  private processingOf(entry: RememberedStart): boolean {
    const status = entry.frames.get("update_device_status") as
      | { device_status?: { is_processing?: unknown } }
      | undefined;
    return status?.device_status?.is_processing === true;
  }

  /** How many conversations are remembered; for tests and the BFF's own log. */
  get size(): number {
    return this.scopes.size;
  }
}
