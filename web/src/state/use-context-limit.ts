import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "./use-session.ts";

/**
 * letta-code's context window for an OpenAI-compatible model it cannot size:
 * a fixed conservative default (LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW), not
 * what the server actually serves. `/context-limit` overrides it.
 */
export const LETTA_DEFAULT_CONTEXT_LIMIT = 128_000;
/** Below this, letta-code refuses a limit without --override; we refuse outright. */
export const MIN_CONTEXT_LIMIT = 30_000;

export type LimitSource = "conversation" | "agent" | "default";

export interface ContextLimit {
  tokens: number;
  /** Where the effective value is set — the conversation's own wins over the agent's. */
  source: LimitSource;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The effective limit, resolved the way letta-code does: conversation, agent, default. */
export function resolveContextLimit(agent: unknown, conversation: unknown): ContextLimit {
  const conv = (conversation ?? {}) as { context_window_limit?: unknown };
  const own = positive(conv.context_window_limit);
  if (own !== null) return { tokens: own, source: "conversation" };
  const a = (agent ?? {}) as {
    model_settings?: { context_window_limit?: unknown };
    llm_config?: { context_window?: unknown };
  };
  const agentLimit =
    positive(a.model_settings?.context_window_limit) ?? positive(a.llm_config?.context_window);
  if (agentLimit !== null) return { tokens: agentLimit, source: "agent" };
  return { tokens: LETTA_DEFAULT_CONTEXT_LIMIT, source: "default" };
}

/**
 * "262144", "262,144", "256k" → tokens; null when it is not a number. A bare
 * "k" is thousands of 1024 only when it reads as a power-of-two size (128k,
 * 256k), because that is how llama.cpp contexts are configured.
 */
export function parseContextLimit(text: string): number | null {
  const trimmed = text.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  const match = /^(\d+(?:\.\d+)?)\s*(k)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (!match[2]) return Math.round(value);
  return Number.isInteger(Math.log2(value)) ? value * 1024 : Math.round(value * 1000);
}

export interface ContextLimitApi {
  limit: ContextLimit | null;
  refresh: () => Promise<void>;
}

/**
 * The effective limit read from the app-server, or null when nothing was
 * learned — a failed `agent_retrieve` must not resolve to the 128k default,
 * which is the wrong value exactly when the real limit is higher (the cold
 * client that asks before the socket is open). A failed `conversation_retrieve`
 * alone still resolves from the agent: the agent-scope value is known.
 */
export async function fetchContextLimit(
  request: SessionApi["request"],
  agentId: string,
  conversationId: string | null,
): Promise<ContextLimit | null> {
  const [agent, conversation] = await Promise.all([
    request<{ agent?: unknown }>("agent_retrieve", { agent_id: agentId }).catch(() => null),
    conversationId && conversationId !== "default"
      ? request<{ conversation?: unknown }>("conversation_retrieve", {
          conversation_id: conversationId,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!agent) return null;
  return resolveContextLimit(agent.agent, conversation?.conversation);
}

export function useContextLimit(
  request: SessionApi["request"],
  agentId: string | null,
  conversationId: string | null,
  ready: boolean,
): ContextLimitApi {
  const [limit, setLimit] = useState<ContextLimit | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setLimit(null);
      return;
    }
    const resolved = await fetchContextLimit(request, agentId, conversationId);
    // A failed lookup keeps whatever was shown instead of overwriting it with
    // the default.
    if (resolved) setLimit(resolved);
  }, [request, agentId, conversationId]);

  // The ids seed from localStorage synchronously, so this must wait for the
  // socket: a request before the WebSocket opens rejects with "Not connected",
  // and the gauge would sit on the 128k default until the next scope change.
  // `ready` flips back on every reconnect, which re-fetches there too.
  useEffect(() => {
    if (ready && agentId) void refresh();
  }, [ready, agentId, refresh]);

  return { limit, refresh };
}
