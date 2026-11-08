import type { PiRunStep } from "../lib/pi.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";

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
 * One transcript row of a remote-pi run, in the main conversation's own visual
 * language: Task is the user bubble, the agent's prose is the assistant bubble,
 * Thinking and tool calls are the same collapsed disclosures chat uses (via
 * `<details>`, so the viewer stays stateless). Tool previews come from the shared
 * `summarizeToolCall` so they read exactly like chat's tool rows.
 *
 * This is `PiRunSheet`'s row, lifted out so the session panel and anything else
 * that shows a captured run render the same transcript rather than a second
 * dialect of it: the remote worker's thread is meant to look like the
 * conversation it was dispatched from, on a different background.
 */
export function PiRunStepRow({ step }: { step: PiRunStep }) {
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
