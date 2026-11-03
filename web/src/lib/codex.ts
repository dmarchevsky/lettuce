/**
 * Codex subagent workers, as the browser sees them: Settings → Codex and the
 * run viewer. Everything goes through the BFF's /api/codex routes — Codex's
 * files live in /root/.letta, outside what a browser may touch. The types
 * mirror `bff/src/codex/`; the two packages cannot import from each other.
 */

import type { RunsPage } from "./runs-scope.ts";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CodexSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  reasoningEffort: ReasoningEffort | null;
  contextWindow: number | null;
  streamIdleTimeoutSeconds: number | null;
}

/** A save. `apiKey`: absent keeps the stored key, "" clears it. */
export type CodexSettingsUpdate = Partial<Omit<CodexSettings, "hasApiKey">> & { apiKey?: string };

export type CodexRunStatus = "running" | "completed" | "aborted" | "unknown";

export interface CodexCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  command: string;
  output: string | null;
  exitCode: number | null;
  truncated: boolean;
  at: string | null;
}

export type CodexRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | CodexCommandStep;

export interface CodexRunSummary {
  threadId: string;
  cwd: string | null;
  /**
   * The agent whose workspace the run happened in, or null for a run with no
   * workspace owner (cron and channel workers run in `/work` itself). What the
   * Runs pane filters on; `bff/src/runs/attribution.ts` derives it.
   */
  agentId: string | null;
  status: CodexRunStatus;
  startedAt: string | null;
  lastActivityAt: string | null;
  prompt: string | null;
}

/** One run's full viewer payload: a summary less the owner, which only the
 * listing computes (the single-run endpoint parses the file, not the workspace). */
export interface CodexRun extends Omit<CodexRunSummary, "agentId"> {
  durationMs: number | null;
  steps: CodexRunStep[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}

/** The subagent type letta-code's `Task` / `launch_subagent` accept for a Codex worker. */
export const CODEX_SUBAGENT_TYPE = "codex";

/** How often an open viewer re-reads a run that is still going. */
export const LIVE_POLL_MS = 3000;

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchCodexSettings(): Promise<{
  settings: CodexSettings;
  suggestedBaseUrl: string | null;
}> {
  return (await ok(await fetch("/api/codex/settings"))).json();
}

export async function saveCodexSettings(update: CodexSettingsUpdate): Promise<CodexSettings> {
  const response = await ok(
    await fetch("/api/codex/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return ((await response.json()) as { settings: CodexSettings }).settings;
}

export async function fetchCodexRuns(
  limit = 10,
  agentId: string | null = null,
): Promise<RunsPage<CodexRunSummary>> {
  const scope = agentId ? `&agent=${encodeURIComponent(agentId)}` : "";
  const response = await ok(await fetch(`/api/codex/runs?limit=${limit}${scope}`));
  const body = (await response.json()) as { runs: CodexRunSummary[]; other?: number };
  return { runs: body.runs, other: body.other ?? 0 };
}

export async function fetchCodexRun(threadId: string): Promise<CodexRun> {
  const response = await ok(await fetch(`/api/codex/runs/${encodeURIComponent(threadId)}`));
  return ((await response.json()) as { run: CodexRun }).run;
}

const CODEX_AGENT_ID_RE =
  /\bagent_id=codex_([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/**
 * The Codex thread a task notification reports on. letta-code's result line
 * carries `agent_id=codex_<thread id>` once the worker has started
 * (`tools/impl/task.ts`); a worker that failed before starting has none.
 */
export function codexThreadInTaskText(text: string): string | null {
  return CODEX_AGENT_ID_RE.exec(text)?.[1] ?? null;
}

/** "3m 12s", "45s", "1h 4m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const STATUS_LABELS: Record<CodexRunStatus, string> = {
  running: "Running",
  completed: "Finished",
  aborted: "Stopped",
  unknown: "Unknown",
};
