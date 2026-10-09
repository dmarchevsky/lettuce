import { useEffect, useState } from "react";
import type { PiRunFacts, PiRunFile } from "../lib/pi.ts";
import {
  ago,
  fetchPiRunFacts,
  LIVE_POLL_MS,
  listPiRunFiles,
  piRunFileUrl,
  STATUS_LABELS,
  stopPiRun,
} from "../lib/pi.ts";

const TONES: Record<PiRunFacts["state"], string> = {
  running: "",
  completed: " ok-tag",
  detached: " muted",
  cancelled: " muted",
  failed: " bad",
};

/**
 * The live card for one remote-pi run, standing in the transcript where the
 * agent dispatched it (`pi_run`/`pi_send` return). Polls the BFF's structured
 * status until the run settles: the step in flight, the last thing pi said,
 * event and byte counters that tick with the stream, and the stop buttons that
 * used to be an ssh session away. This is what the olla incident bought: an
 * agent no longer needs to relay pi_status for a human to follow the work.
 */
export function PiRunCard({ runId }: { runId: string }) {
  const [facts, setFacts] = useState<PiRunFacts | null>(null);
  const [files, setFiles] = useState<PiRunFile[]>([]);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState<"stop" | "force" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const load = async () => {
      try {
        const next = await fetchPiRunFacts(runId);
        if (cancelled) return;
        setFacts(next);
        setGone(false);
        misses = 0;
        // Artifacts ride along: a pi_fetch mid-run shows up without a reload.
        try {
          const nextFiles = await listPiRunFiles(runId);
          if (!cancelled)
            setFiles((prev) =>
              prev.length === nextFiles.length &&
              prev.every((f, i) => nextFiles[i]?.name === f.name && nextFiles[i]?.size === f.size)
                ? prev
                : nextFiles,
            );
        } catch {
          /* no artifacts is also an answer */
        }
        if (next.state === "running") timer = setTimeout(load, LIVE_POLL_MS);
      } catch {
        if (cancelled) return;
        // A run's files may not exist yet seconds after dispatch; give up on
        // the card quietly after a few misses, never on a settled run.
        misses += 1;
        if (misses >= 4) setGone(true);
        else timer = setTimeout(load, LIVE_POLL_MS * 2);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

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
          {facts.lastEventAt ? ` · ${ago(facts.lastEventAt)}` : ""}
        </span>
        <span className="pi-card-actions">
          <a className="link" href={`/?tab=runs&run=${encodeURIComponent(runId)}`}>
            View run
          </a>
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
