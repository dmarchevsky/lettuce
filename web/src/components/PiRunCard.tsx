import { useEffect, useState } from "react";
import type { PiRunFacts, PiRunFile } from "../lib/pi.ts";
import {
  ago,
  fetchPiRunFacts,
  listPiRunFiles,
  piRunFileUrl,
  STATUS_LABELS,
  stopPiRun,
} from "../lib/pi.ts";
import { msSinceLastPiFrame, stalenessWatchdogMs, usePiLiveRuns } from "../lib/pi-live.ts";
import { formatElapsed } from "../lib/working.ts";

const TONES: Record<PiRunFacts["state"], string> = {
  running: " running",
  completed: " ok-tag",
  detached: " muted",
  cancelled: " muted",
  failed: " bad",
};

/**
 * The live card for one remote-pi run, standing in the transcript where the
 * agent dispatched it (`pi_run`/`pi_send` return). Facts arrive pushed on the
 * browser socket (the BFF's ~2-s progress frames, `web/src/lib/pi-live.ts`)
 * after one initial fetch for history: the step in flight, the last thing pi
 * said, event and byte counters that tick with the stream, and the stop
 * buttons that used to be an ssh session away. This is what the olla incident
 * bought: an agent no longer needs to relay pi_status for a human to follow
 * the work.
 */
export function PiRunCard({
  runId,
  onOpenSession,
}: {
  runId: string;
  /** Open the session this run belongs to, in the pane. Null session = just this run. */
  onOpenSession?: (runId: string, session: string | null) => void;
}) {
  const [facts, setFacts] = useState<PiRunFacts | null>(null);
  const [files, setFiles] = useState<PiRunFile[]>([]);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState<"stop" | "force" | null>(null);
  // One tick per second while the run lives: the running clock should not wait
  // on the 3-second status poll.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (facts?.state !== "running") return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [facts?.state]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    // One fetch for history (a card rendered from replayed transcript has
    // past to show); live updates arrive as frames below.
    const load = async () => {
      try {
        const next = await fetchPiRunFacts(runId);
        if (cancelled) return;
        setFacts(next);
        setGone(false);
        try {
          setFiles(await listPiRunFiles(runId));
        } catch {
          /* no artifacts is also an answer */
        }
      } catch {
        if (cancelled) return;
        // A run's files may not exist yet seconds after dispatch; give up on
        // the card quietly after a few misses, never on a settled run.
        misses += 1;
        if (misses >= 4) setGone(true);
        else timer = setTimeout(load, 6_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  // Pushed facts patch the card; frames also carry the artifact list, so the
  // card polls nothing while the stream flows.
  const liveRuns = usePiLiveRuns();
  useEffect(() => {
    const frame = liveRuns[runId];
    if (!frame) return;
    setFacts((prev) => (prev ? { ...prev, ...frame } : frame));
    if (frame.files) setFiles(frame.files);
  }, [liveRuns, runId]);

  // The safety net: a frame lost to a reconnect, or a BFF restart mid-run,
  // used to be covered by the next poll; now the card re-reads by fetch once
  // the frame stream has been silent past the watchdog window.
  useEffect(() => {
    if (facts?.state !== "running") return;
    const timer = setInterval(() => {
      if (msSinceLastPiFrame() > stalenessWatchdogMs) {
        void fetchPiRunFacts(runId)
          .then((next) => setFacts((prev) => (prev ? { ...prev, ...next } : next)))
          .catch(() => {
            /* the next tick tries again; the run may have been swept */
          });
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [facts?.state, runId]);

  if (gone && !facts) return null;
  if (!facts) {
    return (
      <div className="pi-card">
        <p className="muted small">Remote pi run starting…</p>
      </div>
    );
  }

  const running = facts.state === "running";
  const quietMin = Math.floor(facts.quietSeconds / 60);
  void tick; // read: the per-second interval re-renders this line
  const ranMs = facts?.startedAt
    ? Math.max(
        0,
        (facts.endedAt ? Date.parse(facts.endedAt) : Date.now()) - Date.parse(facts.startedAt),
      )
    : 0;
  const stop = async (force: boolean) => {
    const question = force
      ? "Force stop: this kills the pi process on the remote host. Continue?"
      : "Stop watching this run? The remote pi keeps working (detach).";
    if (!window.confirm(question)) return;
    setBusy(force ? "force" : "stop");
    try {
      await stopPiRun(runId, force);
      // One short beat for the ssh path to record the verdict, then re-read.
      await new Promise((resolve) => setTimeout(resolve, 500));
      setFacts(await fetchPiRunFacts(runId));
    } catch {
      /* the button re-enables; the state on screen is still true */
    }
    setBusy(null);
  };

  return (
    <div className="pi-card">
      <div className="pi-card-head">
        <span className={`tag${TONES[facts.state]}`}>{STATUS_LABELS[facts.state]}</span>
        <span className="pi-card-title one-line" title={facts.prompt}>
          {facts.prompt || "remote pi"}
        </span>
        {running && quietMin >= 1 ? (
          <span
            className="tag muted"
            title="No stream output for a while — long tool calls do this legitimately."
          >
            quiet {quietMin}m
          </span>
        ) : null}
      </div>
      {running && facts.nowTool ? (
        <div className="pi-card-now">
          <code>{facts.nowTool}</code>
          <span className="muted one-line">{facts.nowInput}</span>
        </div>
      ) : null}
      {facts.lastSaid ? <p className="pi-card-said">“{facts.lastSaid.trim()}”</p> : null}
      {files.length > 0 ? (
        <div className="pi-card-files">
          <span className="muted small">Artifacts:</span>
          {files.map((file) => (
            <a
              key={file.name}
              className="pi-file"
              href={piRunFileUrl(runId, file.name)}
              target="_blank"
              rel="noreferrer"
              title={`${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`}
            >
              {/\.(png|jpe?g|gif|webp)$/i.test(file.name) ? (
                <img className="pi-card-thumb" src={piRunFileUrl(runId, file.name)} alt="" />
              ) : (
                file.name
              )}
            </a>
          ))}
        </div>
      ) : null}
      {facts.error ? <p className="small bad">{facts.error}</p> : null}
      <div className="pi-card-foot">
        <span className="muted small pi-events">
          {facts.eventCount.toLocaleString()} events
          {facts.bytesCaptured > 0 ? ` · ${(facts.bytesCaptured / 1024).toFixed(0)} KB` : ""}
          {ranMs > 0 ? ` · ${running ? "running" : "ran"} ${formatElapsed(ranMs)}` : ""}
          {facts.lastEventAt ? ` · ${ago(facts.lastEventAt)}` : ""}
        </span>
        <span className="pi-card-actions">
          {onOpenSession ? (
            // In-app since the viewer became a pane: the old link reloaded the
            // page onto the Runs tab and lost the conversation you were reading.
            <button
              type="button"
              className="link"
              onClick={() => onOpenSession(runId, facts.session)}
            >
              View session
            </button>
          ) : (
            <a className="link" href={`/?tab=runs&run=${encodeURIComponent(runId)}`}>
              View run
            </a>
          )}
          {running ? (
            <>
              <button
                type="button"
                className="link"
                disabled={busy !== null}
                onClick={() => void stop(false)}
              >
                {busy === "stop" ? "Stopping…" : "Stop"}
              </button>
              <button
                type="button"
                className="link danger"
                disabled={busy !== null}
                onClick={() => void stop(true)}
              >
                {busy === "force" ? "Killing…" : "Force stop"}
              </button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
