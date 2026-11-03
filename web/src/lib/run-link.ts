/**
 * Linking a LIVE coding-worker subagent to its run file.
 *
 * The completion notification carries the id (`agent_id=codex_<thread>`) that
 * `CodexRunSheet`/`ClaudeRunSheet` open by — but only after success, so a
 * running row has nothing to open with. A running run is still findable: the
 * runs listings compute `status: "running"` from the file itself (Codex from
 * `task_started`/`task_complete`, Claude from entry freshness), and both
 * summaries carry `startedAt`. So match on shape instead of id, and only when
 * the match is honest: exactly one live worker of the kind, exactly one
 * still-active run of that kind whose start time agrees with the worker's.
 * Anything ambiguous returns null and the UI shows no link — guessing would
 * open one child's row onto another child's run.
 */

import { CLAUDE_SUBAGENT_TYPE } from "./claude.ts";
import { CODEX_SUBAGENT_TYPE } from "./codex.ts";
import type { LiveSubagent } from "./subagents.ts";

export type WorkerKind = "codex" | "claude";

/** The run-listing shape both kinds share (structural: Codex/Claude summaries). */
export interface LinkableRun {
  status: string;
  startedAt: string | null;
  lastActivityAt: string | null;
}

/** Which run listing a subagent type reads from, or null for a plain subagent. */
export function workerKindOf(subagentType: string): WorkerKind | null {
  if (subagentType === CODEX_SUBAGENT_TYPE) return "codex";
  if (subagentType === CLAUDE_SUBAGENT_TYPE) return "claude";
  return null;
}

/**
 * How long the worker and its run file must agree on "just now" to be the same
 * run. Generous on purpose: a run file's last write can lag a long generation
 * by minutes, while a crashed run keeps `status: running` forever (no
 * completion record was ever written) and staleness is the only clue.
 */
export const LINK_FRESH_MS = 15 * 60 * 1000;

/** How close the two start clocks must be. They are the same host's clock, so
 * only parsing and launch overhead separate them. */
export const LINK_START_TOLERANCE_MS = 120 * 1000;

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** A run is still alive if either clock says so; a run with neither clock is not. */
function lastBeat(run: LinkableRun): number | null {
  return ms(run.lastActivityAt) ?? ms(run.startedAt);
}

/**
 * The run belonging to `worker`, or null when no link is honest.
 *
 * `workers` is every live snapshot in the same scope (not just this kind) and
 * `runs` that kind's listing, newest first. Rules:
 * 1. a plain (non-worker) snapshot never links here;
 * 2. two live workers of the same kind → no link for either (fan-out — the
 *    per-agent Runs tab is the answer there);
 * 3. candidates = runs of this kind that are `status: "running"`, not stale by
 *    `LINK_FRESH_MS`, and whose `startedAt` is within `LINK_START_TOLERANCE_MS`
 *    of the worker's own `startTime`;
 * 4. exactly one candidate → it; zero or several → null.
 *
 * `worker.startTime` is the snapshot's epoch-ms start; a snapshot predating the
 * field falls back to `now - durationMs`, which is the same clock minus one
 * rounding.
 */
export function resolveLiveWorkerRun<T extends LinkableRun>(
  worker: LiveSubagent,
  workers: readonly LiveSubagent[],
  runs: readonly T[],
  now: number,
  kind: WorkerKind,
): T | null {
  if (workerKindOf(worker.subagentType) !== kind) return null;
  const sameKind = workers.filter((w) => workerKindOf(w.subagentType) === kind);
  if (sameKind.length !== 1 || sameKind[0] !== worker) return null;

  const workerStart = worker.startTime ?? now - worker.durationMs;
  const candidates = runs.filter((run) => {
    if (run.status !== "running") return false;
    const beat = lastBeat(run);
    if (beat === null || now - beat > LINK_FRESH_MS) return false;
    const started = ms(run.startedAt);
    return started !== null && Math.abs(started - workerStart) <= LINK_START_TOLERANCE_MS;
  });
  return candidates.length === 1 ? candidates[0]! : null;
}
