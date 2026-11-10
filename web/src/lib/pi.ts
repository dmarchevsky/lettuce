/**
 * The remote pi worker, as the browser sees it: Settings → Remote Pi
 * and the run viewer. Everything goes through the BFF's /api/pi routes — the
 * private key and the captured run streams live on the BFF's own volume and
 * never cross to the browser; the browser sees only `hasKey` and the PUBLIC
 * half (`publicKey`), the line to paste into the remote's authorized_keys.
 * The types mirror `bff/src/pi/`; the two packages cannot import from each
 * other.
 */

import type { RunsPage } from "./runs-scope.ts";

export interface PiSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Public half of the stored key — safe to show; the private one never comes. */
  publicKey: string | null;
  /** Who made the stored key, so the form shows the flow that is true. */
  keySource: "generated" | "pasted";
  pathPrepend: string;
  /** The remote program plus its fixed arguments, as one line; empty runs `pi`. */
  command: string;
  workdir: string;
  model: string | null;
  /** The stored private key is reduced to this — it never comes to the browser. */
  hasKey: boolean;
}

/** What a host check concluded — the same states the BFF records. */
export type PiCheckState =
  | "ready"
  | "unpinned"
  | "no_key"
  | "auth_failed"
  | "no_pi"
  | "no_workdir"
  | "unreachable";

export interface PiCheck {
  target: string;
  state: PiCheckState;
  ok: boolean;
  detail: string;
  at: string;
  piVersion: string | null;
  pinnedFingerprint: string | null;
}

export type PiPinResult =
  | { changed: false; lines: number; target: string; fingerprint: string | null }
  | { changed: true; target: string; oldFingerprint: string | null; newFingerprint: string | null };

/** A save. `privateKey`: absent or "" keeps the stored key. */
export type PiSettingsUpdate = Partial<Omit<PiSettings, "hasKey" | "publicKey">> & {
  privateKey?: string;
};

/**
 * What one agent does differently (`bff/src/pi/agent-settings.ts`): its own
 * working folder, occasionally its own host. Every empty field inherits the
 * global record, so "own settings" usually means one field. The ssh key and the
 * enable switch are never per-agent — the switch is tool access and lives in
 * Tools, and one lettuce key reaches every authorized host.
 */
export interface PiAgentOverride {
  mode: "global" | "own";
  host: string;
  port: number | null;
  user: string;
  pathPrepend: string;
  /** "" inherits the global command. */
  command: string;
  workdir: string;
  model: string | null;
}

/** What the BFF says about one agent: its own record, what it resolves to, and
 * whether the global setup exists at all (an override needs it to). */
export interface PiAgentPayload {
  agentId: string;
  override: PiAgentOverride;
  effective: PiSettings;
  globalConfigured: boolean;
  globalTarget: string | null;
  check: PiCheck | null;
}

export type PiRunStatus = "running" | "completed" | "detached" | "cancelled" | "failed";

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
  agentId: string | null;
  session: string | null;
  target: string;
  kind: "run" | "send";
  status: PiRunStatus;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
  /** Live progress, flushed at most ~2 s behind the stream. */
  eventCount: number;
  bytesCaptured: number;
  lastEventAt: string | null;
}

export interface PiRun extends PiRunSummary {
  steps: PiRunStep[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** The sheet's refetch throttle: frames arrive every ~2 s and each read is
 * the whole captured stream, so growth is coalesced to one read per interval. */
export const LIVE_POLL_MS = 3000;

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export interface PiSettingsPayload {
  settings: PiSettings;
  check: PiCheck | null;
  /** Agents that point somewhere of their own — the shared section mentions them. */
  agents?: { agentId: string; mode: "global" | "own" }[];
}

export async function fetchPiSettings(): Promise<PiSettingsPayload> {
  return (await ok(await fetch("/api/pi/settings"))).json();
}

export async function savePiSettings(
  update: PiSettingsUpdate,
): Promise<{ settings: PiSettings; check: PiCheck | null }> {
  const response = await ok(
    await fetch("/api/pi/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return (await response.json()) as { settings: PiSettings; check: PiCheck | null };
}

/**
 * Ask the host the question a run will ask. The draft may hold unsaved form
 * values — checking before saving is the point.
 */
export async function checkPiHost(
  draft: PiSettingsUpdate = {},
  agentId?: string | null,
): Promise<PiCheck> {
  const response = await ok(
    await fetch("/api/pi/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentId ? { ...draft, agent_id: agentId } : draft),
    }),
  );
  return ((await response.json()) as { check: PiCheck }).check;
}

/**
 * TOFU pin. A *different* key already pinned for that host answers 409 with both
 * fingerprints and `changed: true` — replacing it is a second click.
 */
export async function pinPiHostKey(
  options: { host?: string; port?: number; force?: boolean; agentId?: string | null } = {},
): Promise<PiPinResult> {
  const { agentId, ...rest } = options;
  const response = await fetch("/api/pi/pin-host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentId ? { ...rest, agent_id: agentId } : rest),
  });
  const text = await response.text();
  if (response.ok || response.status === 409) {
    const body = JSON.parse(text) as { pinned: PiPinResult };
    return body.pinned;
  }
  throw new Error(text || `HTTP ${response.status}`);
}

/** "just now" / "4 min ago" — mirrors the BFF's own wording. */
export function ago(at: string, now = new Date()): string {
  const then = new Date(at).getTime();
  if (!at || !Number.isFinite(then)) return "never";
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** One agent's own Remote Pi settings, and what they resolve to. */
export async function fetchPiAgent(agentId: string): Promise<PiAgentPayload> {
  return (await ok(await fetch(`/api/pi/agent/${encodeURIComponent(agentId)}`))).json();
}

/** Save them; the BFF checks the resulting host on the way back. */
export async function savePiAgent(
  agentId: string,
  override: PiAgentOverride,
): Promise<PiAgentPayload & { check: PiCheck | null }> {
  const response = await ok(
    await fetch(`/api/pi/agent/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(override),
    }),
  );
  return (await response.json()) as PiAgentPayload & { check: PiCheck | null };
}

/** Back to inheriting everything. */
export async function resetPiAgent(agentId: string): Promise<PiAgentPayload> {
  return (
    await ok(await fetch(`/api/pi/agent/${encodeURIComponent(agentId)}`, { method: "DELETE" }))
  ).json();
}

/** Generate or rotate the lettuce-held deploy key; only the public half returns. */
export async function generatePiKey(): Promise<PiSettings> {
  const response = await ok(await fetch("/api/pi/generate-key", { method: "POST" }));
  return ((await response.json()) as { settings: PiSettings }).settings;
}

export async function fetchPiRuns(
  limit = 10,
  agentId: string | null = null,
): Promise<RunsPage<PiRunSummary>> {
  const scope = agentId ? `&agent=${encodeURIComponent(agentId)}` : "";
  const response = await ok(await fetch(`/api/pi/runs?limit=${limit}${scope}`));
  const body = (await response.json()) as { runs: PiRunSummary[]; other?: number };
  return { runs: body.runs, other: body.other ?? 0 };
}

/**
 * `?tab=runs&run=<id>` — the link a settle push carries and the run card's
 * "View run" points at. Read once at boot; consumed from the URL so a reload
 * does not re-open the sheet.
 */
export function readRunsDeepLink(): { tab: boolean; run: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") !== "runs") return { tab: false, run: null };
    const run = params.get("run");
    params.delete("tab");
    params.delete("run");
    const rest = params.toString();
    window.history.replaceState(null, "", rest ? `?${rest}` : window.location.pathname);
    return {
      tab: true,
      run: run && /^[0-9a-f-]{36}$/i.test(run) ? run : null,
    };
  } catch {
    return { tab: false, run: null };
  }
}

export async function fetchPiRun(runId: string): Promise<{ run: PiRun; capturing: boolean }> {
  const response = await ok(await fetch(`/api/pi/runs/${encodeURIComponent(runId)}`));
  return (await response.json()) as { run: PiRun; capturing: boolean };
}

/**
 * Every run on one pi session, oldest first — what the session panel opens with.
 * A session is one pi conversation on one host, so its runs are the whole history
 * of what the agent asked of it: one `pi_run`/`pi_send` each.
 */
export async function fetchPiSessionRuns(
  session: string,
): Promise<{ runs: PiRunSummary[]; capped: boolean }> {
  const response = await ok(await fetch(`/api/pi/session/${encodeURIComponent(session)}/runs`));
  const body = (await response.json()) as { runs: PiRunSummary[]; capped?: boolean };
  // `capped` is the store saying it dropped older runs to keep the listing a
  // bounded read; an older BFF that omits it simply means "not truncated".
  return { runs: body.runs, capped: body.capped ?? false };
}

/**
 * The session panel's run dropdown, newest first: a session can hold dozens of
 * runs, so the choice is a line per run rather than a list to scroll. The label
 * carries the status and the prompt because that is what tells two runs apart.
 */
export function piRunOptions(runs: readonly PiRunSummary[]): { runId: string; label: string }[] {
  return runs
    .map((run, index) => ({
      runId: run.runId,
      label: `Run ${index + 1} · ${STATUS_LABELS[run.status]} · ${oneLine(run.prompt) || "(no prompt recorded)"}`,
    }))
    .reverse();
}

/** The same index the dropdown and the run's own boundary line agree on. */
/**
 * Which runs of a session to read next: the `nearby` positions closest to the
 * focused run, nearest first, skipping any already loaded or already asked for.
 *
 * The bound is a **window around the focus**, not a count per wave, and that is the
 * whole point. Each read is one run's capture tail (megabytes), so a sixty-run
 * session must not mean sixty reads at open — and a wave sized by count, re-derived
 * after each arrival, walks outward one run at a time until it has read everything.
 * Anything outside the window is one dropdown choice away and reads on demand.
 */
export function piRunWave(
  runs: readonly PiRunSummary[],
  focusRunId: string,
  loaded: (runId: string) => boolean,
  nearby = 3,
): string[] {
  const focusIndex = runs.findIndex((run) => run.runId === focusRunId);
  if (focusIndex < 0 || runs.length < 2) return [];
  const wave: string[] = [];
  for (let step = 1; step <= nearby; step++) {
    for (const candidate of [runs[focusIndex + step], runs[focusIndex - step]]) {
      if (candidate && !loaded(candidate.runId)) wave.push(candidate.runId);
    }
  }
  return wave;
}

export function piRunNumber(runs: readonly PiRunSummary[], runId: string): number {
  const at = runs.findIndex((run) => run.runId === runId);
  return at < 0 ? runs.length : at + 1;
}

/** One **Runs list** row: a whole session, or a run whose session never surfaced. */
export interface PiSessionRow {
  /** Stable React key: the session when there is one, the run when there is not. */
  key: string;
  session: string | null;
  /** How many of the fetched runs belong to this session. */
  count: number;
  /** The session's newest run — the row's status, prompt and click target. */
  latest: PiRunSummary;
}

/**
 * Fold a newest-first run listing into one row per session.
 *
 * The Runs list used to spend a row per run, so one five-run session took five
 * rows and read as five unrelated jobs rather than one session sending five
 * messages. Each session leads with its newest run — that is the status worth
 * seeing and the transcript worth opening — and says how many runs it holds.
 * Group order is order of first occurrence, so sessions sort by recency too.
 * A run with no session yet (it died before its header line) is a row alone.
 */
export function groupPiRuns(runs: readonly PiRunSummary[]): PiSessionRow[] {
  const rows: PiSessionRow[] = [];
  const bySession = new Map<string, PiSessionRow>();
  for (const run of runs) {
    const row = run.session ? bySession.get(run.session) : undefined;
    if (row) {
      row.count += 1;
      continue;
    }
    const next: PiSessionRow = {
      key: run.session ? `s:${run.session}` : `r:${run.runId}`,
      session: run.session,
      count: 1,
      latest: run,
    };
    rows.push(next);
    if (run.session) bySession.set(run.session, next);
  }
  return rows;
}

function oneLine(text: string): string {
  return (text || "").split("\n")[0]?.trim().slice(0, 80) ?? "";
}

export const STATUS_LABELS: Record<PiRunStatus, string> = {
  running: "Running",
  completed: "Finished",
  detached: "Detached",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** The structured pi_status the run card polls (the BFF's `statusFacts`). */
export interface PiRunFacts {
  runId: string;
  state: PiRunStatus;
  exitCode: number | null;
  error: string | null;
  session: string | null;
  prompt: string;
  target: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  bytesCaptured: number;
  lastEventAt: string | null;
  quietSeconds: number;
  nowTool?: string;
  nowInput?: string;
  lastSaid?: string;
  /** Only on pushed `__bff_pi_progress` frames — what the Runs list patches by. */
  kind?: "run" | "send";
  model?: string | null;
  /** Only on pushed frames: the run's fetched artifacts, so no files poll. */
  files?: PiRunFile[];
}

export async function fetchPiRunFacts(runId: string): Promise<PiRunFacts> {
  const response = await ok(await fetch(`/api/pi/runs/${encodeURIComponent(runId)}/status`));
  return ((await response.json()) as { status: PiRunFacts }).status;
}

/** A file a `pi_fetch` pulled in (C1): served under the run's own URL. */
export interface PiRunFile {
  name: string;
  size: number;
}

export async function listPiRunFiles(runId: string): Promise<PiRunFile[]> {
  const response = await ok(await fetch(`/api/pi/runs/${encodeURIComponent(runId)}/files`));
  return ((await response.json()) as { files: PiRunFile[] }).files;
}

export function piRunFileUrl(runId: string, name: string): string {
  return `/api/pi/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}`;
}

/** Kill the remote pi (default) or only close Lettuce's watch. Errors come back as 409 text. */
export async function stopPiRun(runId: string, detach = false): Promise<void> {
  const response = await fetch(`/api/pi/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ detach }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
}
