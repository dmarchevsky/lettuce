import { useEffect, useRef, useState } from "react";
import { fetchPiRun, LIVE_POLL_MS, type PiRun, type PiRunStep, STATUS_LABELS } from "../lib/pi.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  runId: string;
  onClose: () => void;
}

function Step({ step }: { step: PiRunStep }) {
  if (step.kind !== "command") {
    if (step.kind === "prompt") {
      return (
        <div className="codex-step codex-prompt">
          <div className="muted small">Task</div>
          <Markdown text={step.text} />
        </div>
      );
    }
    if (step.kind === "reasoning") {
      return <p className="codex-step codex-reasoning muted small">{step.text}</p>;
    }
    return (
      <div className="codex-step">
        <Markdown text={step.text} />
      </div>
    );
  }
  return (
    <details className="codex-step codex-command" open={step.output === null}>
      <summary>
        <Icon name="chevron-right" className="chevron" />
        <code>{step.tool}</code>
        <span className="muted small one-line">{step.input}</span>
        {step.output === null ? <span className="small muted"> running…</span> : null}
        {step.isError ? <span className="small bad"> error</span> : null}
      </summary>
      {step.output ? <pre className="tool-args">{step.output}</pre> : null}
    </details>
  );
}

/**
 * One remote-pi run — every tool call and its output — read from the json
 * stream the BFF captured (the run's own events, not the remote session
 * file). Re-reads every few seconds while the capture is still going;
 * "detached" means the BFF stopped capturing while the remote pi may still be
 * working (docs/remote-pi-plan.md § 4.5).
 */
export function PiRunSheet({ runId, onClose }: Props) {
  const [run, setRun] = useState<PiRun | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const stepCount = run?.steps.length ?? 0;
  const live = capturing || run?.status === "running";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await fetchPiRun(runId);
        if (cancelled) return;
        setRun(next.run);
        setCapturing(next.capturing);
        setError(null);
        if (next.capturing || next.run.status === "running") timer = setTimeout(load, LIVE_POLL_MS);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // A run whose files do not exist yet looks like a 404 for a moment.
        timer = setTimeout(load, LIVE_POLL_MS * 2);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  // Follow a live run as it grows; leave a finished one where the reader is.
  useEffect(() => {
    if (live && stepCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [live, stepCount]);

  const facts: string[] = [];
  if (run) {
    facts.push(STATUS_LABELS[run.status]);
    if (run.model) facts.push(run.model);
    facts.push(run.target);
    if (run.session) facts.push(`session ${run.session.slice(0, 8)}`);
    if (run.usage) {
      facts.push(
        `${run.usage.inputTokens.toLocaleString()} in · ${run.usage.outputTokens.toLocaleString()} out`,
      );
    }
  }

  return (
    <Sheet title="Remote pi run" onClose={onClose} size="spacious" fill status={error}>
      <div className="codex-run">
        {run ? <p className="muted small">{facts.join(" · ")}</p> : null}
        {!run && !error ? <p className="muted">Loading…</p> : null}
        {run?.steps.map((step, index) => (
          <Step key={step.kind === "command" ? step.callId : `${step.kind}-${index}`} step={step} />
        ))}
        {live ? <p className="muted small">Working…</p> : null}
        {run?.status === "detached" ? (
          <p className="muted small">
            Lettuce stopped capturing this run; the remote pi keeps working and its session can be
            resumed with pi_send.
          </p>
        ) : null}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}
