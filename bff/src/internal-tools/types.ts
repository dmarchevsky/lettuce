/** What every internal tool hands back to the mod: text for the model, flagged or not. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
  /**
   * Set by pi_fetch with `save`: the file bytes, which the MOD writes into the
   * agent's own workspace (the BFF has no path to /work — that mount belongs
   * to app-server). The mod template is the only consumer.
   */
  content_b64?: string;
  /** Workspace-relative destination for `content_b64`, already sanitized. */
  save_path?: string;
  /**
   * Set by `generate_image`: several pictures, each already given a
   * workspace-relative path to be saved at. The MOD writes them (the BFF has no
   * path to /work) **and** returns them to letta-code as image content, so the
   * picture is in the conversation as a persisted message part — which is what
   * lets a vision-capable model look at its own drawing and iterate.
   */
  images?: { b64: string; path: string }[];
}

/** Who is calling, as the mod reported it. */
export interface ToolCallContext {
  /** Null for a caller that sent no agent (an older mod, an agent shell's curl). */
  agentId: string | null;
  /** The conversation the call was made from, when the mod sent one
   * (`x-letta-conversation-id`); a run settles back into it. */
  conversationId?: string | null;
  /**
   * Aborts when the caller gives up on this call. letta-code 0.34.19+ hands an
   * AbortSignal to every external (mod) tool call and aborts in-flight tool
   * executions instead of waiting for them, and the mod forwards `ctx.signal`
   * into its fetch here — so this is that same cancellation, now carried into
   * whatever the handler asks of a sidecar. A turn cancellation is the intent;
   * nothing sets it for its own reasons.
   */
  signal?: AbortSignal;
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
