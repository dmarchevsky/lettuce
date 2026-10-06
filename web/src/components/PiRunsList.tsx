import { useCallback, useEffect, useState } from "react";
import { listDate } from "../lib/conversation-groups.ts";
import { fetchPiRuns, LIVE_POLL_MS, type PiRunSummary, STATUS_LABELS } from "../lib/pi.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { PiRunSheet } from "./PiRunSheet.tsx";

/** The status chip's tone: finished reads as done; detached and failed warn. */
const STATUS_TONES: Record<PiRunSummary["status"], string> = {
  running: "",
  completed: " ok-tag",
  detached: " muted",
  failed: " bad",
};

/**
 * Recent remote-pi runs, newest first, each opening the full transcript.
 * Unlike the Codex and Claude lists (which read the CLI's own files inside
 * the app-server), these runs are captured by the BFF itself, so the list
 * exists without the upstream connection — and "running" means the BFF
 * still holds the ssh child.
 */
export function PiRunsList({ refreshKey }: { refreshKey: string }) {
  const [runs, setRuns] = useState<PiRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await fetchPiRuns(8));
      setError(null);
    } catch (cause) {
      // The section 404s when the `pi` token is off — render nothing then.
      setRuns([]);
      setError(null);
      void cause;
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
      <p className="section-note">Remote Pi runs</p>
      {error ? <p className="small bad pad">{error}</p> : null}
      <ul className="list">
        {runs.map((run) => (
          <li key={run.runId} className="task">
            <button type="button" className="row" onClick={() => setOpenRun(run.runId)}>
              <span className="grow-text">
                <span className="task-head stacked">
                  <span className={`tag${STATUS_TONES[run.status]}`}>
                    {STATUS_LABELS[run.status]}
                  </span>
                  <span className="small">{run.prompt || "(no prompt recorded)"}</span>
                </span>
                <span
                  className="muted small one-line"
                  title={run.startedAt ? formatEntryTimeFull(run.startedAt) : undefined}
                >
                  {run.startedAt ? listDate(run.startedAt) : ""}
                  {` · ${run.target}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {openRun ? <PiRunSheet runId={openRun} onClose={() => setOpenRun(null)} /> : null}
    </>
  );
}
