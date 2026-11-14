import { randomUUID } from "node:crypto";
import type {
  AbortMessageResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey, parseScopeKey } from "./buffer.ts";
import type { WatchdogUpstream } from "./context-watchdog.ts";
import { readUsageStatistics } from "./turn-usage.ts";

/**
 * Per-agent step limits, enforced by the BFF.
 *
 * letta-code has its own cap — `execution_settings.max_turns` on
 * `runtime_start`, checked by `finishTurnIfMaxTurnsReached`
 * (`src/websocket/listener/turn-max-turns.ts`) — but it fits this deployment
 * badly. It rides the per-conversation runtime a browser starts, so cron- and
 * Telegram-fired turns would run uncapped; a runtime that carries execution
 * settings is no longer evicted while a connection is subscribed to it, and the
 * BFF's one connection is subscribed to everything; and it replaces the shell
 * environment's `MEMORY_DIR` and parent-agent variables.
 *
 * Every scope's frames already pass through the BFF's permanent connection,
 * whoever started the turn. So the BFF counts each turn's steps (one
 * `usage_statistics` delta per model call) and, once the agent's limit is
 * reached by a step that asked for tools, stops the turn with `abort_message`.
 * The count is the watchdog's own, not `TurnUsageLog`'s: that log forgets the
 * turn in flight at every compaction, and a turn long enough to compact is the
 * one a limit exists for. Upstream's local executor emits a step's tool calls
 * (`approval_request_message`) before its usage (`provider-turn-executor.ts`),
 * so the step's intent is known when it is counted. The abort lands while that
 * step's tools run; the turn then finishes `cancelled` without sending the next
 * model request, and the interrupted tool results are queued ahead of the next
 * input. A step that answered without tools ends the turn by itself and is left
 * alone, so a final answer is never turned into an error.
 *
 * `abort_message` is the user's Stop, and two of its side effects are not what
 * upstream's own cap does, so the watchdog undoes them: it parks the queued
 * user messages (`queueRuntime.pause()` in `control-inputs.ts`), which a
 * `resume_queue` releases once the stopped turn has finished, and it emits an
 * "Interrupted" status line, which is dropped for the run this BFF stopped. The
 * abort carries the turn's `run_id` when the stream showed one, so upstream
 * never applies it to a turn that replaced the one at its limit.
 *
 * The abort cannot interrupt a model call already running (Stop's own limit —
 * docs/upstream-notes.md#stop-cancellation-call-chain): when a step's tools
 * finish before the abort arrives, the next call's prefill still runs and the
 * turn ends at its first chunk.
 *
 * `translate` then reports the stop the way upstream's cap would: the stopped
 * turn's `cancelled` finish becomes `max_steps` with an error, preceded by a
 * terminal `loop_error` delta carrying the same text. Everything downstream —
 * the live transcript, `TurnErrorLog` (so a reload still shows it), the push
 * watcher (so an unwatched cron turn still says why) — reads those as it reads
 * upstream's own. Only a stop the app-server confirmed (`aborted: true`) is
 * rewritten: when the user's Stop got there first, ours finds nothing to abort
 * and the finish stays the user's.
 *
 * Subagent frames are skipped like `TurnUsageLog` skips them: a subagent's steps
 * are not the parent's, and subagents keep upstream's own `--max-turns`.
 */

/** Conversations remembered at once; the least recently active is dropped first. */
const STEP_LIMIT_SCOPES = 200;

interface Stop {
  steps: number;
  limit: number;
  runId: string | null;
  /** The app-server said this abort interrupted the turn. */
  confirmed: boolean;
}

interface ScopeState {
  /** Model calls in the turn in flight. */
  steps: number;
  /** Whether the step in progress asked for a tool call. */
  wantsTools: boolean;
  /** The turn's run, from its own deltas, when the stream carried one. */
  runId: string | null;
  /** Set when this BFF stopped the turn in flight; cleared at its finish. */
  stop: Stop | null;
}

export function stepLimitMessage(steps: number, limit: number): string {
  return `Model call limit reached (${steps}/${limit} calls)`;
}

type Delta = {
  message_type?: unknown;
  message?: unknown;
  run_id?: unknown;
};

export class StepLimitWatchdog {
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly deps: {
      /** The agent's limit, or null for none. Read at every step, so a change applies at once. */
      limitFor: (agentId: string) => number | null;
      upstream: WatchdogUpstream;
      log: (message: string) => void;
      now?: () => Date;
    },
  ) {}

  /**
   * The frames to deliver in place of `frame`. Run before anything else sees
   * the frame, so every consumer reads the rewritten finish.
   */
  translate(frame: WsProtocolMessage): WsProtocolMessage[] {
    if ((frame as { subagent_id?: unknown }).subagent_id) return [frame];
    const key = frameScopeKey(frame);
    const stop = key ? this.scopes.get(key)?.stop : null;
    if (!stop) return [frame];

    if (frame.type === "stream_delta") {
      // The abort's own "Interrupted" line: the turn was stopped by its limit,
      // not by anyone pressing Stop, and the notice below says so.
      const delta = (frame as { delta?: Delta }).delta;
      const isInterrupted = delta?.message_type === "status" && delta.message === "Interrupted";
      const sameRun = !stop.runId || !delta?.run_id || delta.run_id === stop.runId;
      return isInterrupted && sameRun ? [] : [frame];
    }

    if (frame.type !== "turn_finished" || frame.stop_reason !== "cancelled" || !stop.confirmed) {
      return [frame];
    }
    const message = stepLimitMessage(stop.steps, stop.limit);
    // Upstream's own cap emits this through `emitLoopErrorNotice`
    // (`recoverable-notices.ts`); the shape is its `createLifecycleMessageBase`
    // plus the notice fields. The envelope's `event_seq`/`idempotency_key` are
    // upstream's per-connection bookkeeping, which nothing here reads.
    const loopError = {
      type: "stream_delta",
      runtime: frame.runtime,
      delta: {
        id: `step-limit-${frame.turn_id}`,
        date: this.now().toISOString(),
        message_type: "loop_error",
        ...(frame.run_id ? { run_id: frame.run_id } : {}),
        message,
        stop_reason: "max_steps",
        is_terminal: true,
      },
    } as unknown as WsProtocolMessage;
    return [loopError, { ...frame, stop_reason: "max_steps", error: message }];
  }

  /** Count steps and stop a turn at its agent's limit. */
  observe(frame: WsProtocolMessage): void {
    if ((frame as { subagent_id?: unknown }).subagent_id) return;
    const key = frameScopeKey(frame);
    if (!key) return;

    if (frame.type === "turn_finished") {
      const stop = this.scopes.get(key)?.stop;
      this.scopes.delete(key);
      if (stop?.confirmed) void this.resumeQueue(key);
      return;
    }
    if (frame.type !== "stream_delta") return;
    const delta = (frame as { delta?: Delta }).delta;
    if (!delta) return;
    const messageType = delta.message_type;

    if (messageType === "approval_request_message" || messageType === "tool_call_message") {
      const state = this.touch(key);
      state.wantsTools = true;
      if (typeof delta.run_id === "string") state.runId = delta.run_id;
      return;
    }
    if (messageType === "retry" || messageType === "loop_error") {
      // A failed or retried step never reached its usage; whatever it asked
      // for is not what the step that replaces it will ask for.
      const state = this.scopes.get(key);
      if (state) state.wantsTools = false;
      return;
    }
    if (messageType !== "usage_statistics") return;

    const counted = readUsageStatistics(delta)?.steps ?? 0;
    if (counted === 0) return;
    const state = this.touch(key);
    state.steps += counted;
    if (typeof delta.run_id === "string") state.runId = delta.run_id;
    const wantsTools = state.wantsTools;
    state.wantsTools = false;
    if (!wantsTools || state.stop) return;

    const [agentId, conversationId] = parseScopeKey(key);
    const limit = this.deps.limitFor(agentId);
    if (limit === null || state.steps < limit) return;

    state.stop = { steps: state.steps, limit, runId: state.runId, confirmed: false };
    void this.abort(key, agentId, conversationId, state.stop);
  }

  private async abort(
    key: string,
    agentId: string,
    conversationId: string,
    stop: Stop,
  ): Promise<void> {
    const at = `${conversationId} at ${stop.steps}/${stop.limit} steps`;
    const forget = () => {
      const state = this.scopes.get(key);
      if (state?.stop === stop) state.stop = null;
    };
    try {
      const response = await this.deps.upstream.request<AbortMessageResponseMessage>(
        {
          type: "abort_message",
          request_id: `bff-step-limit-${randomUUID()}`,
          runtime: { agent_id: agentId, conversation_id: conversationId },
          ...(stop.runId ? { run_id: stop.runId } : {}),
        },
        10_000,
      );
      if (response.success === false || response.aborted === false) {
        // The turn ended first, the user's Stop got there first, or the runtime
        // is gone: there is no cancelled finish of ours to report.
        forget();
        this.deps.log(
          `step limit: nothing to stop in ${at}${response.error ? ` (${response.error})` : ""}`,
        );
        return;
      }
      stop.confirmed = true;
      // The turn may have finished while the answer was on its way, taking the
      // scope's state with it; the queue the abort parked still needs releasing.
      if (this.scopes.get(key)?.stop !== stop) void this.resumeQueue(key);
      this.deps.log(`step limit: stopped ${at}`);
    } catch (error) {
      forget();
      this.deps.log(
        `step limit: could not stop ${at}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Release the user messages the abort parked, as upstream's own cap never parks them. */
  private async resumeQueue(key: string): Promise<void> {
    const [agentId, conversationId] = parseScopeKey(key);
    try {
      await this.deps.upstream.request(
        {
          type: "resume_queue",
          request_id: `bff-step-limit-resume-${randomUUID()}`,
          runtime: { agent_id: agentId, conversation_id: conversationId },
        },
        10_000,
      );
    } catch (error) {
      this.deps.log(
        `step limit: could not resume the queue of ${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private touch(key: string): ScopeState {
    const state = this.scopes.get(key) ?? { steps: 0, wantsTools: false, runId: null, stop: null };
    // Re-insert so Map order tracks recency; the oldest scope is evicted first.
    this.scopes.delete(key);
    this.scopes.set(key, state);
    while (this.scopes.size > STEP_LIMIT_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined) break;
      this.scopes.delete(oldest);
    }
    return state;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}
