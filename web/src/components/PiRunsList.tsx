import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listDate } from "../lib/conversation-groups.ts";
import { ago, fetchPiRuns, groupPiRuns, type PiRunSummary, STATUS_LABELS } from "../lib/pi.ts";
import { msSinceLastPiFrame, stalenessWatchdogMs, usePiLiveRuns } from "../lib/pi-live.ts";
import { type AgentNames, type RunsListProps, scopedEmptyLabel } from "../lib/runs-scope.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";

/** The status chip's tone: finished reads as done; detached and failed warn. */
const STATUS_TONES: Record<PiRunSummary["status"], string> = {
  running: " running",
  completed: " ok-tag",
  detached: " muted",
  cancelled: " muted",
  failed: " bad",
};

/**
 * Recent remote-pi runs folded into one row per session, newest session first.
 * Unlike the Codex and Claude lists (which read the CLI's own files inside
 * the app-server), these runs are captured by the BFF itself, so the list
 * exists without the upstream connection — and "running" means the BFF
 * still holds the ssh child.
 *
 * One row per run read as five unrelated jobs where one session had sent five
 * messages, so a row is a session now: its newest run leads it (status chip,
 * prompt) and the row says how many runs the session holds. The fetch is
 * deliberately deeper than the rows it feeds, so one busy session cannot
 * crowd every other session out of the page.
 */
const RUNS_PAGE = 40;
/** Session rows the section shows — the same eight-line budget the run rows had. */
const VISIBLE_SESSIONS = 8;
export function PiRunsList({
  refreshKey,
  agentId,
  agentName,
  agentNames,
  onOther,
  onOpenRun,
}: RunsListProps & {
  /** Names for the owner line a run shows only when every agent is listed. */
  agentNames: AgentNames;
  /** Open one run's session in the pane — the row's whole verb. */
  onOpenRun: (runId: string, session: string | null) => void;
}) {
  const [runs, setRuns] = useState<PiRunSummary[]>([]);
  const [other, setOther] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const liveFrames = usePiLiveRuns();

  const load = useCallback(async () => {
    try {
      const page = await fetchPiRuns(RUNS_PAGE, agentId);
      for (const run of page.runs) seenRuns.current.add(run.runId);
      setRuns(page.runs);
      setOther(page.other);
      onOther(page.other);
      setError(null);
    } catch (cause) {
      // The section 404s when the `pi` token is off — render nothing then.
      setRuns([]);
      setOther(0);
      onOther(0);
      setError(null);
      void cause;
    }
  }, [agentId, onOther]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger itself.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Pushed frames patch the rows as a derived value: the fetch stays the only
  // writer of `runs`, so no effect can feed on its own state update.
  const rows = useMemo(
    () =>
      runs.map((run) => {
        const frame = liveFrames[run.runId];
        return frame
          ? {
              ...run,
              status: frame.state,
              eventCount: frame.eventCount,
              lastEventAt: frame.lastEventAt,
              bytesCaptured: frame.bytesCaptured,
            }
          : run;
      }),
    [runs, liveFrames],
  );

  // A frame naming a run this list has never seen is a run that started after the
  // mount, so it reloads the list — **once per run id**. The frame stream is
  // machine-wide and a frame carries no owner, so under a scope a run belonging to
  // another agent can never become known to this list: reloading on every frame
  // about it (the BFF flushes about one per 2 s per running run) would poll the
  // BFF for as long as that run streams.
  const seenRuns = useRef(new Set<string>());
  useEffect(() => {
    let fresh = false;
    for (const runId of Object.keys(liveFrames)) {
      if (seenRuns.current.has(runId)) continue;
      seenRuns.current.add(runId);
      fresh = true;
    }
    if (fresh) void load();
  }, [liveFrames, load]);

  // Watchdog: frames stalled (reconnect gap, BFF restart mid-run) while a row
  // still reads running — re-read the truth once per window.
  const anyRunning = rows.some((run) => run.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      if (msSinceLastPiFrame() > stalenessWatchdogMs) void load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  // See CodexRunsList: silence means nothing-to-show, never hidden-by-the-scope.
  if (!error && runs.length === 0 && other === 0) return null;

  // Group after the frame patch, so a run that settled live leads its row with
  // the truth, not with the status the fetch saw.
  const sessions = groupPiRuns(rows).slice(0, VISIBLE_SESSIONS);

  return (
    <>
      <p className="section-note">Remote Pi runs</p>
      {error ? (
        <p className="warning small" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      {runs.length === 0 && !error ? (
        <p className="muted small">{scopedEmptyLabel("Remote Pi runs", agentName, other)}</p>
      ) : (
        <ul className="list">
          {sessions.map((row) => {
            const run = row.latest;
            return (
              <li key={row.key} className="task">
                <button
                  type="button"
                  className="row"
                  onClick={() => onOpenRun(run.runId, run.session)}
                  title={run.prompt}
                >
                  <span className="grow-text">
                    <span className="task-head stacked">
                      <span className={`tag${STATUS_TONES[run.status]}`}>
                        {STATUS_LABELS[run.status]}
                      </span>
                      <span className="small one-line">{run.prompt || "(no prompt recorded)"}</span>
                    </span>
                    <span
                      className="muted small one-line"
                      title={run.startedAt ? formatEntryTimeFull(run.startedAt) : undefined}
                    >
                      {/* A sessionless run (it died before its header line) has no
                          session to name, so it says nothing it cannot know. */}
                      {row.session
                        ? `session ${row.session.slice(0, 8)} · ${row.count} run${
                            row.count === 1 ? "" : "s"
                          } · `
                        : ""}
                      {run.startedAt ? listDate(run.startedAt) : ""}
                      {` · ${run.target}`}
                      {/* A pi run carries no cwd, so when every agent is listed it is
                        the only kind whose owner would otherwise go unsaid. */}
                      {agentId === null
                        ? ` · ${run.agentId ? (agentNames[run.agentId] ?? "no agent") : "no agent"}`
                        : ""}
                      {run.status === "running" && run.eventCount > 0
                        ? ` · ${run.eventCount.toLocaleString()} events${run.lastEventAt ? ` · ${ago(run.lastEventAt)}` : ""}`
                        : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
