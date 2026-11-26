/**
 * The Context sheet's compaction numbers, read from and written to the BFF
 * (`bff/src/session/context-size.ts`, which mirrors these field names — the two
 * packages cannot import from each other).
 *
 * One number is typed by a human here: the **context size**, what the model
 * server gives one request. Everything else is derived from it and from what the
 * model declares, which is why nothing else is editable.
 */

export type ContextSource = "typed" | "declared" | "default";

export interface ContextAccounting {
  /** What one request gets, in tokens. */
  context: number;
  /** Whether that came from you, from the model's declaration, or from neither. */
  source: ContextSource;
  /** What every request promises to be allowed to generate; null when undeclared. */
  maxOutput: number | null;
  /** Where the conversation compacts. The gauge measures against this. */
  compactAt: number;
  /** The window letta-code is given so its own threshold lands on `compactAt`. */
  window: number;
  /** What you typed, per scope — what "Use automatic" would clear. */
  typed: { agent: number | null; conversation: number | null };
  /** Which of those the size above came from; names the scope to clear. */
  typedScope: "agent" | "conversation" | null;
  /** What the model's declaration would produce, when an override is in force. */
  automatic: { context: number; compactAt: number } | null;
  /**
   * The window letta-code is using is not the one these numbers imply. Null when
   * it is. `armedLate` is the dangerous half: the window compacts **after** the
   * server would refuse the request, so the next over-large message is an error
   * and not a summary. A window that only compacts early costs context, so it is
   * said without alarm and fixed without a verb.
   */
  mismatch: {
    window: number;
    refusedAt: number;
    engineAt: number;
    armedLate: boolean;
  } | null;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchContextSize(input: {
  agentId: string;
  conversationId: string | null;
}): Promise<ContextAccounting> {
  const params = new URLSearchParams({ agent_id: input.agentId });
  if (input.conversationId) params.set("conversation_id", input.conversationId);
  return (
    await ok(await fetch(`/api/context-size?${params}`))
  ).json() as Promise<ContextAccounting>;
}

/** Store (or with `null`, clear) the context size for one scope; answers with letta-code's line. */
export async function saveContextSize(input: {
  agentId: string;
  conversationId: string | null;
  scope: "agent" | "conversation";
  tokens: number | null;
}): Promise<string> {
  const response = await ok(
    await fetch("/api/context-size", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: input.agentId,
        conversation_id: input.conversationId,
        scope: input.scope,
        tokens: input.tokens,
      }),
    }),
  );
  const body = (await response.json()) as { output?: string };
  return body.output ?? "";
}
