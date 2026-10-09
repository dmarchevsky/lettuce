/**
 * Claude Code subagent workers, as the browser sees them: Settings → Claude
 * Code and the run viewer. Everything goes through the BFF's /api/claude
 * routes — Claude's files live in /root/.letta, outside what a browser may
 * touch. The types mirror `bff/src/claude/`; the two packages cannot import
 * from each other.
 */

/** `subscription`: a Claude subscription via `claude setup-token`; `endpoint`: an Anthropic-compatible URL. */
export type ClaudeAuthMode = "endpoint" | "subscription";

export interface ClaudeSettings {
  enabled: boolean;
  mode: ClaudeAuthMode;
  baseUrl: string;
  /** Endpoint mode's model. */
  model: string;
  /** Subscription mode's model; "" = Claude Code's default. */
  subscriptionModel: string;
  hasAuthToken: boolean;
  hasOauthToken: boolean;
}

/** A save. Each token: absent keeps the stored one, "" clears it. */
export type ClaudeSettingsUpdate = Partial<
  Omit<ClaudeSettings, "hasAuthToken" | "hasOauthToken">
> & {
  authToken?: string;
  oauthToken?: string;
};

export type ClaudeRunStatus = "running" | "completed" | "unknown";

export interface ClaudeCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  input: string;
  output: string | null;
  truncated: boolean;
  at: string | null;
}

export type ClaudeRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | ClaudeCommandStep;

export interface ClaudeRunSummary {
  sessionId: string;
  cwd: string | null;
  model: string | null;
  status: ClaudeRunStatus;
  startedAt: string | null;
  lastActivityAt: string | null;
  prompt: string | null;
}

export interface ClaudeRun extends ClaudeRunSummary {
  durationMs: number | null;
  steps: ClaudeRunStep[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}

/** The subagent type letta-code's `Task` / `launch_subagent` accept for a Claude worker. */
export const CLAUDE_SUBAGENT_TYPE = "claude-code";

/** How often an open viewer re-reads a run that is still going. */
export const LIVE_POLL_MS = 3000;

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchClaudeSettings(): Promise<{ settings: ClaudeSettings }> {
  return (await ok(await fetch("/api/claude/settings"))).json();
}

export async function saveClaudeSettings(update: ClaudeSettingsUpdate): Promise<ClaudeSettings> {
  const response = await ok(
    await fetch("/api/claude/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return ((await response.json()) as { settings: ClaudeSettings }).settings;
}

export async function fetchClaudeRuns(limit = 10): Promise<ClaudeRunSummary[]> {
  const response = await ok(await fetch(`/api/claude/runs?limit=${limit}`));
  return ((await response.json()) as { runs: ClaudeRunSummary[] }).runs;
}

export async function fetchClaudeRun(sessionId: string): Promise<ClaudeRun> {
  const response = await ok(await fetch(`/api/claude/runs/${encodeURIComponent(sessionId)}`));
  return ((await response.json()) as { run: ClaudeRun }).run;
}

// Claude session ids are plain UUIDv4 — deliberately NOT the v7-only pattern
// codex.ts uses: Claude generates them with no time bits.
const CLAUDE_AGENT_ID_RE =
  /\bagent_id=claude_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/**
 * The Claude session a task notification reports on. letta-code's result line
 * carries `agent_id=claude_<session id>` once the worker has started
 * (`tools/impl/task.ts`); a worker that failed before starting has none.
 */
export function claudeSessionInTaskText(text: string): string | null {
  return CLAUDE_AGENT_ID_RE.exec(text)?.[1] ?? null;
}

/** "3m 12s", "45s", "1h 4m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const STATUS_LABELS: Record<ClaudeRunStatus, string> = {
  running: "Running",
  completed: "Finished",
  unknown: "Unknown",
};
