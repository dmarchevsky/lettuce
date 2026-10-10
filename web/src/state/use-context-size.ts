import { useCallback, useEffect, useState } from "react";
import { type ContextAccounting, fetchContextSize, saveContextSize } from "../lib/context-size.ts";

/**
 * The Context sheet's compaction numbers, held by the app so the gauge and the
 * sheet agree on the same denominator — the gauge measures how full the
 * conversation is *of the space before it compacts*, which is not the number
 * letta-code stores.
 *
 * Read from the BFF rather than computed here: the derived window is what the
 * BFF writes upstream, so the sheet shows the same function's output, not a
 * second implementation of it.
 */
export function useContextSize(
  agentId: string | null,
  conversationId: string | null,
  ready: boolean,
) {
  const [accounting, setAccounting] = useState<ContextAccounting | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setAccounting(null);
      return;
    }
    try {
      setAccounting(await fetchContextSize({ agentId, conversationId }));
    } catch {
      // The gauge keeps its last numbers rather than dropping to the raw limit.
    }
  }, [agentId, conversationId]);

  useEffect(() => {
    if (ready && agentId) void refresh();
  }, [ready, agentId, refresh]);

  /** Store a size for one scope (`null` returns to the model's declaration). */
  const setSize = useCallback(
    async (tokens: number | null, scope: "agent" | "conversation") => {
      if (!agentId) throw new Error("No agent is open");
      const output = await saveContextSize({ agentId, conversationId, scope, tokens });
      await refresh();
      return output;
    },
    [agentId, conversationId, refresh],
  );

  return { accounting, refresh, setSize };
}
