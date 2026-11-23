import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../lib/download.ts";
import {
  EVENT_PAGE,
  fetchTaskRunEvents,
  readTaskRunEntries,
  TASK_STATUS_LABELS,
  type TaskRunEntry,
  type TaskRunSummary,
} from "../lib/task-runs.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  run: TaskRunSummary;
  onClose: () => void;
}

/** One folded tool call: the transcript's own tool grammar, header plus output. */
function CallEntry({ entry }: { entry: Extract<TaskRunEntry, { kind: "call" }> }) {
  const summary = summarizeToolCall(entry.name, parseToolArgs(entry.input ?? undefined), null);
  const headline = (summary?.headline ?? entry.name).replace(/^\$ /, "");
  const mono = summary?.mono ?? true;
  return (
    <div className="entry task">
      <div className="tool-head">
        <code>{entry.name}</code>
        <span className={`grow-text summary${mono ? " mono" : ""}`}>{headline}</span>
      </div>
      {summary?.subtitle ? <p className="tool-subtitle">{summary.subtitle}</p> : null}
      {entry.output ? (
        mono ? (
          <pre className={`tool-args${entry.isError ? " stderr" : ""}`}>{entry.output}</pre>
        ) : (
          <div className={`bubble task-result${entry.isError ? " bad" : ""}`}>
            <Markdown text={entry.output} />
          </div>
        )
      ) : null}
    </div>
  );
}

function Entry({ entry }: { entry: TaskRunEntry }) {
  switch (entry.kind) {
    case "call":
      return <CallEntry entry={entry} />;
    case "text":
      return (
        <div className={`entry narration${entry.reasoning ? " reasoning" : ""}`}>
          <div className={`bubble ${entry.reasoning ? "thinking" : "narration"}`}>
            <Markdown text={entry.text} />
          </div>
        </div>
      );
    case "notification":
      return (
        <div className="entry system">
          <div className="bubble system">
            <Markdown text={entry.text} />
          </div>
        </div>
      );
    case "notice":
      return <p className="muted small">{entry.text}</p>;
  }
}

/**
 * A finished (or still-writing) task's whole transcript, read from the event log
 * upstream appends beside the run's output file — so it opens after the process is
 * gone, and after the app-server with it. That durability is the feature: the live
 * sheet in Tasks is a view of the newest snapshot and disappears with the run.
 *
 * It pages backwards, oldest-side first like the log itself, and opens at the tail:
 * the last thing a run did is what you came to read, and a 256 MiB log is never
 * going on screen whole. The status line says which slice is showing, because
 * "the transcript" and "this page of it" are different claims.
 */
export function TaskRunSheet({ run, onClose }: Props) {
  const [entries, setEntries] = useState<TaskRunEntry[]>([]);
  /** Line offset of the first record fetched so far; 0 = the whole log is in. */
  const [firstAfter, setFirstAfter] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // The log is line-addressed and a record is a line, so the count the listing
  // read off the last `seq` is close enough to aim at the tail from. Aim wrong and
  // the worst case is a page that starts a little early — `Load earlier` still
  // reaches the top, and the status line reports what is actually on screen.
  const tailStart = Math.max(0, (run.events ?? EVENT_PAGE) - EVENT_PAGE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchTaskRunEvents(run.taskId, tailStart, EVENT_PAGE);
        if (cancelled) return;
        setEntries(readTaskRunEntries(page.events));
        setFirstAfter(Math.max(0, tailStart));
        setLoaded(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run.taskId, tailStart]);

  // Newest last, like the log: the first load lands at the end of what it fetched,
  // which is what the reader came for. (Prepending an earlier page also re-runs
  // this, and lands back at the bottom — where they were, not where they came from.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dep says events arrived — where to scroll is read from the DOM
  useEffect(() => {
    if (loaded) endRef.current?.scrollIntoView({ block: "end" });
  }, [loaded, entries.length]);

  const loadEarlier = async () => {
    if (earlier) return;
    setEarlier(true);
    try {
      const from = Math.max(0, firstAfter - EVENT_PAGE);
      const page = await fetchTaskRunEvents(run.taskId, from, EVENT_PAGE);
      setEntries((current) => [...readTaskRunEntries(page.events), ...current]);
      setFirstAfter(from);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEarlier(false);
    }
  };

  const facts = [
    TASK_STATUS_LABELS[run.status],
    run.subagentType ?? run.kind,
    run.events !== null ? `${run.events} events` : null,
    run.bytes > 0 ? formatBytes(run.bytes) : null,
    run.startedAt ? formatEntryTimeFull(run.startedAt) : null,
  ].filter((fact) => fact !== null);

  const shown = entries.length;
  const status = error
    ? error
    : loaded
      ? firstAfter === 0
        ? `Showing the whole log — ${shown} events`
        : `Showing ${shown} of ${run.events ?? "?"} events`
      : "Loading…";

  return (
    <Sheet
      title={run.description ?? run.taskId}
      onClose={onClose}
      size="spacious"
      fill
      status={status}
    >
      <p className="muted small">{facts.join(" · ")}</p>
      <div className="subagent-run">
        {firstAfter > 0 && !error ? (
          <button
            type="button"
            className="link"
            onClick={() => void loadEarlier()}
            disabled={earlier}
          >
            {earlier ? "Loading…" : "Load earlier events"}
          </button>
        ) : null}
        {entries.map((entry) => (
          // `seq` is the log's own number and unique within a run, so it is the
          // only key that survives prepending a page without re-rendering rows.
          <Entry key={`${entry.kind}:${entry.seq}`} entry={entry} />
        ))}
        {!loaded && !error ? <p className="muted small">Loading…</p> : null}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}
