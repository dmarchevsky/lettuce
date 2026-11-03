import { useEffect, useRef, useState } from "react";
import { formatElapsed } from "../lib/working.ts";
import { formatTokens } from "../lib/usage.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import type { LiveSubagent } from "../lib/subagents.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  /** The live snapshot, re-rendered on every `update_subagent_state` frame. */
  subagent: LiveSubagent;
  /** Shorten paths in the child's own tool summaries the way the transcript does. */
  cwd: string | null;
  onClose: () => void;
  /** Absent = the snapshot carries no `agentId`, so there is nothing to stop. */
  onStop?: () => void;
}

/** The child's current clock: its own start when the wire sent one, else frozen at the frame's elapsed. */
function useElapsed(subagent: LiveSubagent): number {
  const [now, setNow] = useState(() => Date.now());
  const anchored = subagent.startTime !== undefined;
  const anchorRef = useRef(now - subagent.durationMs);
  useEffect(() => {
    if (anchored) anchorRef.current = subagent.startTime!;
  }, [anchored, subagent.startTime]);
  useEffect(() => {
    if (!anchored) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anchored]);
  return anchored ? now - anchorRef.current : subagent.durationMs;
}

/** One line of the child's tool-call log — the transcript's tool grammar, header only. */
function ToolLine({ name, args, cwd, working }: {
  name: string;
  args: string;
  cwd: string | null;
  working: boolean;
}) {
  const summary = summarizeToolCall(name, parseToolArgs(args), cwd);
  const headline = (summary?.headline ?? name).replace(/^\$ /, "");
  return (
    <div className="entry tool">
      <button type="button" className="tool-head" disabled>
        <code>{name}</code>
        <span className={`grow-text summary${(summary?.mono ?? true) ? " mono" : ""}`}>
          {headline}
        </span>
        {working ? <span className="tool-peek">Working…</span> : null}
      </button>
      {summary?.subtitle ? <p className="tool-subtitle">{summary.subtitle}</p> : null}
    </div>
  );
}

/**
 * The running child's event log, from the only live source upstream gives:
 * the `update_subagent_state` snapshot (subagent tool calls never arrive as
 * transcript frames). It is a view of the latest frame, not a stream — new
 * frames re-render it whole, so a missed frame is self-healing. The parent
 * unmounts it when the snapshot leaves the live list; the completion report
 * lands in the conversation, where it already goes.
 */
export function SubagentTranscriptSheet({ subagent, cwd, onClose, onStop }: Props) {
  const elapsed = useElapsed(subagent);
  const [promptOpen, setPromptOpen] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const progress = subagent.progress ?? [];
  const stepCount = subagent.toolCalls.length + progress.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [stepCount]);

  const facts = [subagent.status];
  if (subagent.totalTokens >= 100) facts.push(`${formatTokens(subagent.totalTokens)} tok`);
  if (elapsed > 0) facts.push(formatElapsed(elapsed));
  if (subagent.model) facts.push(subagent.model);

  return (
    <Sheet
      title={subagent.description || "Subagent"}
      onClose={onClose}
      size="spacious"
      fill
      actions={
        onStop ? (
          <button type="button" className="link danger" onClick={onStop}>
            Stop
          </button>
        ) : undefined
      }
    >
      <p className="muted small">{facts.join(" · ")}</p>

      {subagent.prompt ? (
        <div className="entry">
          <button type="button" className="tool-head" onClick={() => setPromptOpen((v) => !v)}>
            <span className="step-name">Task</span>
            <Icon name={promptOpen ? "chevron-down" : "chevron-right"} className="chevron" />
          </button>
          {promptOpen ? (
            <div className="bubble thinking">
              <Markdown text={subagent.prompt} cwd={cwd} />
            </div>
          ) : null}
        </div>
      ) : null}

      {subagent.toolCalls.map((call, i) => (
        <ToolLine
          key={`${call.name}:${i}`}
          name={call.name}
          args={call.args}
          cwd={cwd}
          working={subagent.status === "running" && i === subagent.toolCalls.length - 1}
        />
      ))}

      {progress.map((line) => (
        <div className="entry narration" key={line.id}>
          <div className="bubble narration">
            <Markdown text={line.text} cwd={cwd} />
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </Sheet>
  );
}
