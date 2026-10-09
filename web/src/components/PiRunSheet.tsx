import { useEffect, useRef, useState } from "react";
import { fetchPiRun, LIVE_POLL_MS, type PiRun, type PiRunStep, STATUS_LABELS } from "../lib/pi.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  runId: string;
  onClose: () => void;
}

function firstLine(text: string): string {
  return (
    (text || "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function prettyArgs(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/**
 * One transcript row, in the main conversation's own visual language: Task is
 * the user bubble, the agent's prose is the assistant bubble, Thinking and
 * tool calls are the same collapsed disclosures chat uses (via <details>, so
 * the sheet stays stateless). Tool previews come from the shared
 * `summarizeToolCall` so they read exactly like chat's tool rows.
 */
function Step({ step }: { step: PiRunStep }) {
  if (step.kind !== "command") {
    if (step.kind === "prompt") {
      return (
        <div className="entry user">
          <div className="role">
            <span className="who">Task</span>
          </div>
          <div className="bubble">
            <Markdown text={step.text} />
          </div>
        </div>
      );
    }
    if (step.kind === "reasoning") {
      return (
        <details className="entry reasoning">
          <summary className="tool-head">
            <span className="step-name">Thinking</span>
            <Icon name="chevron-right" className="chevron" />
          </summary>
          <div className="bubble thinking">
            <Markdown text={step.text} />
          </div>
        </details>
      );
    }
    return (
      <div className="entry assistant">
        <div className="role">
          <span className="who">Agent</span>
        </div>
        <div className="bubble">
          <Markdown text={step.text} />
        </div>
      </div>
    );
  }
  const args = parseToolArgs(step.input);
  // pi's tool names are lowercase (bash, read); the chat summarizer matches
  // Letta's capitalized set, so normalize before asking for a headline.
  const named = step.tool ? step.tool.charAt(0).toUpperCase() + step.tool.slice(1) : undefined;
  const summary = summarizeToolCall(named, args, null);
  const preview = summary?.headline || firstLine(step.input);
  const running = step.output === null;
  return (
    <details className={`entry tool${step.isError ? " error" : ""}`} open={running}>
      <summary className="tool-head">
        <code>{step.tool}</code>
        {preview ? (
          <span className={`grow-text summary${(summary?.mono ?? true) ? " mono" : ""}`}>
            {preview.slice(0, 200)}
          </span>
        ) : null}
        {step.isError ? <span className="tag bad">error</span> : null}
        {running ? <span className="tool-peek">Running…</span> : null}
        <Icon name="chevron-right" className="chevron" />
      </summary>
      <div className="rail">
        <span className="rail-label">In</span>
        <pre className="tool-args">{prettyArgs(step.input)}</pre>
        {!running && step.output ? (
          <>
            <span className="rail-label">Out</span>
            <pre className="tool-args">{step.output}</pre>
          </>
        ) : null}
        {running ? <span className="tool-peek">Running…</span> : null}
      </div>
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
    <Sheet title="Remote Pi run" onClose={onClose} size="spacious" fill status={error}>
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
