import { useEffect, useState } from "react";
import { fetchPiRuns } from "../lib/pi.ts";

const IDLE_POLL_MS = 60_000;
const LIVE_POLL_MS = 15_000;

/**
 * How many remote-pi runs are currently running. Polls fast while something is
 * active and slow while idle; disabled for agents that cannot use pi. Feeds
 * both the Runs tab dot and the topbar chip.
 */
export function usePiActiveRuns(enabled: boolean): number {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setActive(0);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      try {
        const runs = await fetchPiRuns(10);
        const n = runs.filter((run) => run.status === "running").length;
        setActive(n);
        schedule(n > 0 ? LIVE_POLL_MS : IDLE_POLL_MS);
      } catch {
        schedule(IDLE_POLL_MS);
      }
    };
    void tick();
    return () => clearTimeout(timer);
  }, [enabled]);

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
