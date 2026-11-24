import { useCallback, useEffect, useState } from "react";
import { listDate } from "../lib/conversation-groups.ts";
import { formatBytes } from "../lib/download.ts";
import type { RunsListProps } from "../lib/runs-scope.ts";
import {
  fetchTaskRuns,
  TASK_STATUS_LABELS,
  TASK_STATUS_TONES,
  type TaskRunSummary,
} from "../lib/task-runs.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { TaskRunSheet } from "./TaskRunSheet.tsx";

/**
 * How long a run may look idle before the row stops calling it running. This is
 * the BFF's own window (`RUNNING_WINDOW_MS` in `bff/src/runs/task-logs.ts`) —
 * the status is computed there from the log's mtime, and a second, longer guess
 * here would only hide rows the listing already settled.
 */
const RUNNING_FRESH_MS = 5 * 60 * 1000;

/** Rows the section shows. The pane offers a handful of lists, not an archive. */
const LIST_LIMIT = 10;

/** The row's right-hand fact: the run's own elapsed, from its first and last lines. */
function elapsed(run: TaskRunSummary): string | null {
  if (!run.startedAt || !run.lastActivityAt) return null;
  const ms = Date.parse(run.lastActivityAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Past subagent runs — the Runs pane's file-backed list, the sibling of the
 * coding workers' lists over the app-server's own task transcripts.
 *
 * These rows are files, not processes: what they state (kind, when, how many
 * events, how big) is what the transcript proves, and a run whose app-server died
 * is still here. That is the point of the list — the live row in Tasks is gone
 * when the process is, and this is where the log can still be opened.
 *
 * One honest difference from its siblings: a task transcript names no agent, so
 * this list cannot scope itself to the open one — it shows every run of this kind
 * and reports nothing hidden. And it lists only plain subagents: a `codex` or
 * `claude-code` run has its own list above with the viewer for its own files, and
 * one run earning two rows with two viewers is worse than no row.
 */
export function TaskRunsList({ refreshKey, onOther }: RunsListProps) {
  const [runs, setRuns] = useState<TaskRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<TaskRunSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await fetchTaskRuns(25);
      setRuns(page.runs.filter((run) => run.kind === "subagent").slice(0, LIST_LIMIT));
      onOther(0);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      onOther(0);
    }
  }, [onOther]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger itself.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const anyFresh = runs.some(
    (run) =>
      run.status === "running" &&
      Date.now() - (Date.parse(run.lastActivityAt ?? "") || 0) < RUNNING_FRESH_MS,
  );
  useEffect(() => {
    if (!anyFresh) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [anyFresh, load]);

  // Nothing anywhere and no filter hiding it: the section is not this machine's
  // business, and this one cannot be hiding anything behind the pane's scope.
  if (!error && runs.length === 0) return null;

  return (
    <>
      <p className="section-note">Subagent runs</p>
      {error ? (
        <p className="warning small" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      {runs.length > 0 ? (
        <ul className="list">
          {runs.map((run) => (
            <li key={`${run.runDir}/${run.taskId}`} className="task">
              <button type="button" className="row" onClick={() => setOpenTask(run)}>
                <span className="grow-text">
                  <span className="task-head stacked">
                    <span className={`tag${TASK_STATUS_TONES[run.status]}`}>
                      {TASK_STATUS_LABELS[run.status]}
                    </span>
                    <span className="small">{run.description ?? run.taskId}</span>
                  </span>
                  <span
                    className="muted small one-line"
                    title={run.startedAt ? formatEntryTimeFull(run.startedAt) : undefined}
                  >
                    {[
                      run.subagentType ?? run.kind,
                      run.status === "running"
                        ? `started ${listDate(run.startedAt ?? undefined)}`
                        : `finished ${listDate(run.lastActivityAt ?? run.startedAt ?? undefined)}`,
                      run.events !== null ? `${run.events} events` : null,
                      run.bytes > 0 ? formatBytes(run.bytes) : null,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                </span>
                {elapsed(run) ? <span className="muted small">{elapsed(run)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {openTask ? <TaskRunSheet run={openTask} onClose={() => setOpenTask(null)} /> : null}
    </>
  );
}
