import { useCallback, useEffect, useState } from "react";
import {
  type ClaudeRunSummary,
  fetchClaudeRuns,
  LIVE_POLL_MS,
  STATUS_LABELS,
} from "../lib/claude.ts";
import { listDate } from "../lib/conversation-groups.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { ClaudeRunSheet } from "./ClaudeRunSheet.tsx";

/** The status chip's tone: a finished run reads as done. */
const STATUS_TONES: Record<ClaudeRunSummary["status"], string> = {
  running: "",
  completed: " ok-tag",
  unknown: " muted",
};

/**
 * Recent Claude Code worker runs, newest first, each opening the full run.
 *
 * Why a list and not a link on the "Running now" row: that row is letta-code's
 * background task, which carries a subagent id but never the Claude session id
 * (the subagent snapshot's `agent_url` stays null for external workers). The
 * transcript files are keyed by session id, so a running worker is found here.
 *
 * `refreshKey` changes when the set of running background tasks does, so a
 * worker that just started or finished shows up without waiting for a poll.
 */
export function ClaudeRunsList({ refreshKey }: { refreshKey: string }) {
  const [runs, setRuns] = useState<ClaudeRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await fetchClaudeRuns(8));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger itself.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const anyRunning = runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), LIVE_POLL_MS * 2);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  if (runs.length === 0 && !error) return null;

  return (
    <>
      <p className="section-note">Claude runs</p>
      {error ? (
        <p className="warning small" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      <ul className="list">
        {runs.map((run) => (
          <li key={run.sessionId} className="task">
            <button type="button" className="row" onClick={() => setOpenSession(run.sessionId)}>
              <span className="grow-text">
                <span className="task-head stacked">
                  <span className={`tag${STATUS_TONES[run.status]}`}>
                    {STATUS_LABELS[run.status]}
                  </span>
                  <span className="small">{run.prompt ?? "(no prompt recorded)"}</span>
                </span>
                <span
                  className="muted small one-line"
                  title={run.startedAt ? formatEntryTimeFull(run.startedAt) : undefined}
                >
                  {run.startedAt ? listDate(run.startedAt) : ""}
                  {run.cwd ? ` · ${run.cwd}` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {openSession ? (
        <ClaudeRunSheet sessionId={openSession} onClose={() => setOpenSession(null)} />
      ) : null}
    </>
  );
}
