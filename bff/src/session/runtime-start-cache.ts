import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

/**
 * The frames a state replay re-emits, which the BFF therefore has to keep in
 * order to answer a repeat start without one.
 *
 * These are the four `emitStateSync` re-emits and the web client reads its live
 * state from (`use-conversation.ts`): the app-server stores none of them, so a
 * conversation opened without its replay would show a turn that ended, miss one
 * that is running, or lose a running subagent's progress. The BFF routes all four
 * anyway, so keeping the newest of each costs four objects per conversation and
 * stands in for the replay.
 */
const LIVE_STATE_FRAMES = new Set([
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

/**
 * How long a replayed "busy" stays believable.
 *
 * A running turn keeps frames coming; a minute of silence with a busy claim
 * means a frame was lost or the turn is wedged, and in both cases the answer the
 * browser deserves is the app-server's, not the BFF's copy. Same threshold the
 * web client's stall watchdog uses (`web/src/lib/working.ts`), so the two agree
 * on when "quiet" stops meaning "idle".
 */
export const STALE_AFTER_MS = 60_000;

/** Conversations remembered at once; the least recently seen is dropped first. */
export const CACHE_SCOPES = 200;

/**
 * The fields a cached answer may stand in for.
 *
 * A plain conversation open sends exactly these. Anything else on the command —
 * a permission `mode`, `execution_settings`, `external_tools`, `create_agent`,
 * `skill_sources`, a teleport id — is a different question than "is this runtime
 * up?", and only the app-server can answer it, so an unknown field forwards.
 * Listing the allowed set rather than the known-bad ones is the point: a field
 * added upstream later is refused until someone says otherwise here.
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
  /** Normalized so an absent `cwd` and `null` are two different answers. */
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
  if (command.type !== "runtime_start") return null;
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

interface RememberedScope {
  /** The connection these frames belong to — see `Registry.generation`. */
  generation: number;
  /** Newest of each live-state frame seen, keyed by frame type. */
  readonly frames: Map<string, WsProtocolMessage>;
  /** When the newest of those frames was seen, in `now()` terms. */
  at: number;
  /** Set by `remember`: what the successful start asked for, or null until then. */
  start: { cwd: string } | null;
}

/**
 * Conversations this BFF connection has started, with the live state last seen
 * for each.
 *
 * The permanent upstream connection already has these runtimes up and subscribed,
 * so a browser re-opening a conversation is asking something whose answer the BFF
 * has been routing all along. Answering it locally is the whole point: upstream
 * resolves a `wait_for_replay` start only after re-emitting state, which costs
 * about 3.5 s of main-thread `fsync` during which the app-server answers nobody
 * else (prod: dmarchevsky/lettuce#114).
 *
 * Two things about upstream shape everything here. The replay runs *before* the
 * response, so the frames of a start's own replay arrive before this cache knows
 * the start succeeded — hence a scope is remembered the moment a frame mentions
 * it, and a start only marks it. And an idle runtime is evicted when its turn
 * ends (`evictConversationRuntimeIfIdle`, at the end of every turn), and lettuce
 * sends neither `workspace_sandbox` nor `execution_settings`, so nothing holds
 * it up: the end of a turn means the runtime is gone and everything the replay
 * would have owed — approvals still waiting, a turn finished unseen — goes with
 * it. So `turn_finished` forgets the conversation, answered or not.
 *
 * Everything here is scoped to the current connection and cleared on a reconnect,
 * because after one the app-server may have restarted and nothing upstream is
 * known to be running.
 */
export class RuntimeStartCache {
  private readonly scopes = new Map<string, RememberedScope>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Keep the newest live-state frame, whether or not this conversation has been
   * started in this connection yet: a start's own replay lands here first.
   */
  noteFrame(scopeKey: string, frame: WsProtocolMessage, generation: number): void {
    if (!LIVE_STATE_FRAMES.has(frame.type)) return;
    const entry = this.ensure(scopeKey);
    if (entry.generation !== generation) {
      // A frame from before a reconnect is not this connection's state.
      entry.generation = generation;
      entry.frames.clear();
      entry.start = null;
    }
    entry.frames.set(frame.type, frame);
    entry.at = this.now();
  }

  /**
   * A start upstream answered with success — or rather a start the BFF has just
   * forwarded, since its replay arrives before its response does.
   */
  remember(scopeKey: string, cwd: string, generation: number): void {
    const entry = this.ensure(scopeKey);
    if (entry.generation !== generation) {
      entry.generation = generation;
      entry.frames.clear();
    }
    entry.start = { cwd };
    // Re-insert so Map order tracks recency; the least seen scope evicts first.
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, entry);
  }

  /**
   * Nothing is known about this conversation any more — its turn ended, upstream
   * evicted the idle runtime with it, an approval is waiting on a human, or the
   * start was refused. Forwarding is always the safe answer.
   */
  forget(scopeKey: string): void {
    this.scopes.delete(scopeKey);
  }

  /**
   * An approval asked here is waiting on a human, and the replay a skipped start
   * would have re-emitted the very card they have to click (`replayPending
   * ApprovalRequestsToConnection` is part of it). So an unanswered approval
   * makes the conversation unanswerable — answering would show a turn "working"
   * with nothing to approve, which is worse than slow.
   *
   * It is a `forget` rather than a flag: the approval may be answered from another
   * device, or expire, with nothing on this connection to say so, and a forwarded
   * start re-remembers the conversation as soon as it is worth remembering again.
   */
  askApproval(scopeKey: string): void {
    this.scopes.delete(scopeKey);
  }

  /** The connection is gone: nothing upstream is known to be running. */
  clear(): void {
    this.scopes.clear();
  }

  /**
   * The frames to hand a browser instead of its replay, or null to forward.
   *
   * Null is the safe answer as often as it is the slow one, so each reason is its
   * own line: a scope never started in this connection; a foreign generation; a
   * different `cwd`, which is a different runtime; no frames, which would answer
   * a question about live state by saying nothing; and a busy claim nobody has
   * refreshed for `STALE_AFTER_MS`, which is a claim rather than an observation.
   */
  replayFor(scopeKey: string, cwd: string, generation: number): WsProtocolMessage[] | null {
    const entry = this.scopes.get(scopeKey);
    if (!entry || !entry.start) return null;
    if (entry.generation !== generation || entry.start.cwd !== cwd) return null;
    if (entry.frames.size === 0) return null;
    if (this.busyOf(entry) && this.now() - entry.at > STALE_AFTER_MS) return null;
    // Same order `emitStateSync` uses, so a cached answer reads like the replay.
    return [
      entry.frames.get("update_device_status"),
      entry.frames.get("update_loop_status"),
      entry.frames.get("update_queue"),
      entry.frames.get("update_subagent_state"),
    ].filter((frame): frame is WsProtocolMessage => frame !== undefined);
  }

  /** Either of the two frames that can claim work, claiming it. */
  private busyOf(entry: RememberedScope): boolean {
    const status = entry.frames.get("update_device_status") as
      | { device_status?: { is_processing?: unknown } }
      | undefined;
    if (status?.device_status?.is_processing === true) return true;
    const loop = entry.frames.get("update_loop_status") as
      | { loop_status?: { status?: unknown } }
      | undefined;
    const loopStatus = loop?.loop_status?.status;
    return typeof loopStatus === "string" && loopStatus !== "WAITING_ON_INPUT";
  }

  private ensure(scopeKey: string): RememberedScope {
    let entry = this.scopes.get(scopeKey);
    if (!entry) {
      entry = {
        generation: -1,
        frames: new Map(),
        at: this.now(),
        start: null,
      };
      this.scopes.set(scopeKey, entry);
      if (this.scopes.size > CACHE_SCOPES) {
        const oldest = this.scopes.keys().next();
        if (!oldest.done) this.scopes.delete(oldest.value);
      }
    }
    return entry;
  }

  /** How many conversations are remembered; for tests and the BFF's own log. */
  get size(): number {
    return this.scopes.size;
  }
}
