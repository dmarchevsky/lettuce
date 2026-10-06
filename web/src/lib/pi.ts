/**
 * The remote pi worker, as the browser sees it: Settings → Remote pi worker
 * and the run viewer. Everything goes through the BFF's /api/pi routes — the
 * private key and the captured run streams live on the BFF's own volume and
 * never cross to the browser; the browser sees only `hasKey` and the PUBLIC
 * half (`publicKey`), the line to paste into the remote's authorized_keys.
 * The types mirror `bff/src/pi/`; the two packages cannot import from each
 * other.
 */

export interface PiSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Public half of the stored key — safe to show; the private one never comes. */
  publicKey: string | null;
  pathPrepend: string;
  workdir: string;
  model: string | null;
  /** The stored private key is reduced to this — it never comes to the browser. */
  hasKey: boolean;
}

/** A save. `privateKey`: absent or "" keeps the stored key. */
export type PiSettingsUpdate = Partial<Omit<PiSettings, "hasKey" | "publicKey">> & {
  privateKey?: string;
};

export type PiRunStatus = "running" | "completed" | "detached" | "failed";

export interface PiCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  input: string;
  output: string | null;
  isError: boolean;
  at: string | null;
}

export type PiRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | PiCommandStep;

export interface PiRunSummary {
  runId: string;
  session: string | null;
  target: string;
  kind: "run" | "send";
  status: PiRunStatus;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
}

export interface PiRun extends PiRunSummary {
  steps: PiRunStep[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** How often an open viewer re-reads a run that is still being captured. */
export const LIVE_POLL_MS = 3000;

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchPiSettings(): Promise<{ settings: PiSettings }> {
  return (await ok(await fetch("/api/pi/settings"))).json();
}

export async function savePiSettings(update: PiSettingsUpdate): Promise<PiSettings> {
  const response = await ok(
    await fetch("/api/pi/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return ((await response.json()) as { settings: PiSettings }).settings;
}

/** Generate or rotate the lettuce-held deploy key; only the public half returns. */
export async function generatePiKey(): Promise<PiSettings> {
  const response = await ok(await fetch("/api/pi/generate-key", { method: "POST" }));
  return ((await response.json()) as { settings: PiSettings }).settings;
}

/** TOFU: the BFF ssh-keyscans the configured host and pins what it answers. */
export async function pinPiHostKey(): Promise<{ lines: number; target: string }> {
  const response = await ok(await fetch("/api/pi/pin-host", { method: "POST" }));
  return ((await response.json()) as { pinned: { lines: number; target: string } }).pinned;
}

export async function fetchPiRuns(limit = 10): Promise<PiRunSummary[]> {
  const response = await ok(await fetch(`/api/pi/runs?limit=${limit}`));
  return ((await response.json()) as { runs: PiRunSummary[] }).runs;
}

export async function fetchPiRun(runId: string): Promise<{ run: PiRun; capturing: boolean }> {
  const response = await ok(await fetch(`/api/pi/runs/${encodeURIComponent(runId)}`));
  return (await response.json()) as { run: PiRun; capturing: boolean };
}

export const STATUS_LABELS: Record<PiRunStatus, string> = {
  running: "Running",
  completed: "Finished",
  detached: "Detached",
  failed: "Failed",
};
