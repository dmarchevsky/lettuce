import { randomUUID } from "node:crypto";
import type {
  AgentRetrieveResponseMessage,
  ConversationCompactResponseMessage,
  ConversationRetrieveResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey, parseScopeKey } from "./buffer.ts";
import type { TurnUsageLog } from "./turn-usage.ts";

/**
 * The BFF's own compaction trigger, for the case letta-code's own cannot see.
 *
 * letta-code compacts on context pressure at `window − min(16 384, 20 %)`
 * (`provider-turn-executor.ts`), and that window is the agent's or
 * conversation's `context_window_limit` — which for an `openai-compatible`
 * endpoint is a number the operator typed, not one anybody probed. Two things
 * go wrong and both end the same way, with the turn dying and nothing
 * summarised:
 *
 *  - The declared window is bigger than what the server serves, so the
 *    provider refuses the request long before the trigger (a llama.cpp slot is
 *    often half what the model's card claims).
 *  - The reserve is smaller than the model's max output, so even with an
 *    exactly-declared window the engine runs out first: a request is refused
 *    at `n_ctx − max_tokens`, and 16 384 < 32 768.
 *
 * We cannot patch upstream, and we cannot probe an opaque proxy, so the watchdog
 * reads what the provider actually reported: the `context_tokens` of the last
 * step against the declared window, and the wording of the error when the
 * provider refused outright. Either one is enough to compact the conversation
 * through letta-code's own `conversation_compact`, which is the same verb
 * `/compact` drives.
 *
 * Off with `CONTEXT_WATCHDOG_RATIO=0`. Default 0.9 — deliberately earlier than
 * upstream's trigger, which is the point: whichever fires first, the
 * conversation survives the turn that filled it.
 */
export const DEFAULT_CONTEXT_WATCHDOG_RATIO = 0.9;

/** Seconds of silence after one compaction before the same conversation may compact again. */
export const CONTEXT_COMPACT_COOLDOWN_MS = 60_000;

/** Conversations remembered between turns; the least recently seen goes first. */
const WATCHDOG_SCOPES = 200;

/** How long a resolved `context_window_limit` is trusted before it is re-read. */
const LIMIT_TTL_MS = 60_000;

/**
 * What a context-exhausted provider sounds like.
 *
 * Ours, not letta-code's: its own classifier (`context-window-overflow.ts`)
 * matches `"exceeds the context"`, which is not how llama.cpp writes it
 * (`"the request exceeds the available context size, try increasing it"`), so
 * on the engines this deployment runs the last recovery path never fires.
 * Lowercased substring matches, kept narrow on purpose: `"slot"` alone would
 * catch unrelated scheduler noise.
 */
const CONTEXT_EXHAUSTION_MARKERS = [
  "exceeds the available context",
  "exceeds the context",
  "exceeds the available context size",
  "context length",
  "context window",
  "context_length_exceeded",
  "context_size",
  "too many tokens",
  "prompt is too long",
  "input is too long",
  "maximum context",
  "n_ctx",
  "reduce the length",
  "request_too_large",
];

export function isContextExhaustionError(text: string): boolean {
  const haystack = text.toLowerCase();
  return CONTEXT_EXHAUSTION_MARKERS.some((marker) => haystack.includes(marker));
}

/** The window upstream would use for this scope, read the way the client reads it. */
export function effectiveContextLimit(agent: unknown, conversation: unknown): number {
  const conv = (conversation ?? {}) as { context_window_limit?: unknown };
  if (typeof conv.context_window_limit === "number" && conv.context_window_limit > 0) {
    return conv.context_window_limit;
  }
  const a = (agent ?? {}) as {
    model_settings?: { context_window_limit?: unknown };
    llm_config?: { context_window?: unknown };
  };
  const fromModel = a.model_settings?.context_window_limit;
  if (typeof fromModel === "number" && fromModel > 0) return fromModel;
  const fromLlm = a.llm_config?.context_window;
  return typeof fromLlm === "number" && fromLlm > 0 ? fromLlm : LETTA_DEFAULT_CONTEXT_LIMIT;
}

/** letta-code's fallback for an endpoint it cannot size (`use-context-limit.ts`). */
export const LETTA_DEFAULT_CONTEXT_LIMIT = 128_000;

export interface WatchdogUpstream {
  request<T extends WsProtocolMessage>(
    command: Record<string, unknown> & { type: string; request_id: string },
    timeoutMs: number,
  ): Promise<T>;
  isReady(): boolean;
}

export class ContextWatchdog {
  /** scopeKey → when this BFF last compacted it. */
  private readonly compactedAt = new Map<string, number>();
  /** scopeKey → the declared window and when it was read. */
  private readonly limits = new Map<string, { tokens: number; at: number }>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly deps: {
      ratio: number;
      usage: TurnUsageLog;
      upstream: WatchdogUpstream;
      log: (message: string) => void;
      now?: () => number;
    },
  ) {}

  observe(frame: WsProtocolMessage): void {
    const { ratio } = this.deps;
    if (ratio <= 0 || ratio > 1) return;
    if (frame.type !== "turn_finished") return;
    if ((frame as { subagent_id?: unknown }).subagent_id) return;
    const key = frameScopeKey(frame);
    if (!key) return;

    const error = typeof frame.error === "string" ? frame.error : "";
    const exhausted = isContextExhaustionError(error);
    const last = this.deps.usage.get(key).last;
    const used = last?.contextTokens;
    if (!exhausted && used === undefined) return;

    void this.evaluate(key, exhausted, used);
  }

  private async evaluate(key: string, exhausted: boolean, used: number | undefined): Promise<void> {
    if (this.busy.has(key)) return;
    const now = this.now();
    const lastAttempt = this.compactedAt.get(key);
    if (lastAttempt !== undefined && now - lastAttempt < CONTEXT_COMPACT_COOLDOWN_MS) return;

    const limit = await this.limitFor(key);
    const ratio = used !== undefined && limit > 0 ? used / limit : 0;
    if (!exhausted && ratio < this.deps.ratio) return;

    // The compact command is scoped by conversation alone; the agent is implied.
    const [, conversationId] = parseScopeKey(key);
    this.busy.add(key);
    this.compactedAt.set(key, now);
    this.trim();
    try {
      const response = await this.deps.upstream.request<ConversationCompactResponseMessage>(
        {
          type: "conversation_compact",
          request_id: `bff-context-watchdog-${randomUUID()}`,
          // The protocol's own shape: the app-server resolves the agent from
          // the conversation, so there is no agent_id to send.
          conversation_id: conversationId,
        },
        // A summary is a model call on the same slow engine as the turn that
        // just ran; give it the room one more turn would need.
        300_000,
      );
      const failed = response.success === false;
      this.deps.log(
        `context watchdog: compacted ${conversationId} (${
          exhausted
            ? `provider refused the request${used !== undefined ? ` at ${used} tokens` : ""}`
            : `${Math.round(ratio * 100)}% of ${limit} tokens`
        })${failed ? " — the app-server refused" : ""}`,
      );
    } catch (error) {
      this.deps.log(
        `context watchdog: could not compact ${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.busy.delete(key);
    }
  }

  /** The window in force for a scope, re-read once a minute. */
  private async limitFor(key: string): Promise<number> {
    const cached = this.limits.get(key);
    if (cached && this.now() - cached.at < LIMIT_TTL_MS) return cached.tokens;
    if (!this.deps.upstream.isReady()) return cached?.tokens ?? LETTA_DEFAULT_CONTEXT_LIMIT;
    const [agentId, conversationId] = parseScopeKey(key);
    try {
      const [agent, conversation] = await Promise.all([
        this.deps.upstream
          .request<AgentRetrieveResponseMessage>(
            {
              type: "agent_retrieve",
              request_id: `bff-watchdog-agent-${randomUUID()}`,
              agent_id: agentId,
            },
            10_000,
          )
          .catch(() => null),
        conversationId === "default"
          ? Promise.resolve(null)
          : this.deps.upstream
              .request<ConversationRetrieveResponseMessage>(
                {
                  type: "conversation_retrieve",
                  request_id: `bff-watchdog-conv-${randomUUID()}`,
                  conversation_id: conversationId,
                },
                10_000,
              )
              .catch(() => null),
      ]);
      const tokens = effectiveContextLimit(
        agent?.agent ?? null,
        conversation?.conversation ?? null,
      );
      this.limits.set(key, { tokens, at: this.now() });
      return tokens;
    } catch {
      return cached?.tokens ?? LETTA_DEFAULT_CONTEXT_LIMIT;
    }
  }

  private trim(): void {
    while (this.compactedAt.size > WATCHDOG_SCOPES) {
      const oldest = this.compactedAt.keys().next().value;
      if (oldest === undefined) break;
      this.compactedAt.delete(oldest);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
