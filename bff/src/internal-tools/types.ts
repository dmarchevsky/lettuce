/** What every internal tool hands back to the mod: text for the model, flagged or not. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** Who is calling, as the mod reported it. */
export interface ToolCallContext {
  /** Null for a caller that sent no agent (an older mod, an agent shell's curl). */
  agentId: string | null;
  /** The conversation the call was made from, when the mod sent one
   * (`x-letta-conversation-id`); a run settles back into it. */
  conversationId?: string | null;
}

/** One native tool the BFF serves. Never throws: a failure is an answer the agent reads. */
export type ToolHandler = (
  args: Record<string, unknown>,
  /** Absent in tests and for callers that need no identity. */
  context?: ToolCallContext,
) => Promise<ToolAnswer>;

/**
 * How a tool is declared to letta-code. `ask` follows the permission mode
 * (Standard/Strict prompt, Unrestricted runs — letta-code
 * `permissions/checker.ts`); `auto` never prompts.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  approval: "auto" | "ask";
}

/** Below upstream's 32k tool-return cap, so a continuation hint is never cut off. */
export const MAX_TOOL_TEXT = 30_000;

export function capText(text: string, hint = "the rest was cut"): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n\n[Cut at ${MAX_TOOL_TEXT} characters — ${hint}.]`
    : text;
}
