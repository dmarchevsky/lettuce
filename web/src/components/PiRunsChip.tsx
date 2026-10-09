import { useEffect, useState } from "react";
import { fetchPiRuns } from "../lib/pi.ts";

/**
 * "pi · N" — remote-pi runs still streaming right now, so "is any worker
 * still working?" is one glance at the topbar instead of a tab. Tap opens
 * the Runs tab. Polls every 15 s while something runs, 60 s otherwise; the
 * settle push covers the human case in between.
 */
export function PiRunsChip({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let running = 0;
      try {
        running = (await fetchPiRuns(10)).filter((run) => run.status === "running").length;
      } catch {
        // The route 404s when the token is off — there is simply no chip.
      }
      if (!alive) return;
      setCount(running);
      timer = setTimeout(() => void tick(), running > 0 ? 15_000 : 60_000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (count === 0) return null;
  return (
    <button
      type="button"
      className="pill as-button pi-runs-chip"
      onClick={onOpen}
      title="Remote pi runs in progress"
    >
      pi · {count}
    </button>
  );
}
