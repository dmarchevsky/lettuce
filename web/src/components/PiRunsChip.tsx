import { useEffect, useMemo, useState } from "react";
import { fetchPiRuns, type PiRunSummary } from "../lib/pi.ts";
import { msSinceLastPiFrame, stalenessWatchdogMs, usePiLiveRuns } from "../lib/pi-live.ts";

/**
 * How many remote-pi runs are currently running — derived from the pushed
 * progress frames, so an idle page issues zero pi requests (this replaced a
 * 60-s-forever poll). One fetch on mount covers runs that started before the
 * page did; the watchdog re-syncs if the frame stream stalls (a BFF restart
 * mid-run settles every orphan at once, with no socket listening). Feeds both
 * the Runs tab dot and the topbar chip.
 */
export function usePiActiveRuns(enabled: boolean): number {
  const [fetched, setFetched] = useState<PiRunSummary[]>([]);
  const live = usePiLiveRuns();

  useEffect(() => {
    if (!enabled) {
      setFetched([]);
      return;
    }
    void fetchPiRuns(10)
      .then((page) => setFetched(page.runs))
      .catch(() => {
        /* the section 404s when the `pi` token is off; zero is the answer */
      });
  }, [enabled]);

  // The frames override the fetch per run: a run that settled after the page
  // loaded must not stay counted because the older list row still says running.
  const running = useMemo(() => {
    const byRun = new Map<string, boolean>();
    for (const run of fetched) byRun.set(run.runId, run.status === "running");
    for (const fact of Object.values(live)) byRun.set(fact.runId, fact.state === "running");
    let n = 0;
    for (const isRunning of byRun.values()) if (isRunning) n += 1;
    return n;
  }, [fetched, live]);
  const active = enabled ? running : 0;

  useEffect(() => {
    if (!enabled || running === 0) return;
    const timer = setInterval(() => {
      if (msSinceLastPiFrame() > stalenessWatchdogMs) {
        void fetchPiRuns(10)
          .then((page) => setFetched(page.runs))
          .catch(() => {
            /* the next tick tries again */
          });
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [enabled, running]);

  return active;
}

/** Compact topbar chip: "pi · N" while runs are active. */
export function PiRunsChip({ active, onOpen }: { active: number; onOpen: () => void }) {
  if (active <= 0) return null;
  return (
    <button
      type="button"
      className="chip pi-chip"
      onClick={onOpen}
      title={`${active} remote pi run${active === 1 ? "" : "s"} running`}
    >
      <i className="tab-dot" aria-hidden="true" />
      pi · {active}
    </button>
  );
}
