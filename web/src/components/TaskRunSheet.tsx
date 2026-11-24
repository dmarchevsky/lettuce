import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "../lib/download.ts";
import {
  callDuration,
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
  const duration = callDuration(entry);
  return (
    <div className="entry task">
      <div className="tool-head">
        <code>{entry.name}</code>
        <span className={`grow-text summary${mono ? " mono" : ""}`}>{headline}</span>
        {duration ? <span className="duration">{duration}</span> : null}
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
  /** Line offset just past the last record fetched — the forward cursor. */
  const [nextLine, setNextLine] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [newer, setNewer] = useState(false);
  /** True when the log holds lines past what is on screen (its own `has_more`). */
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // The log is line-addressed and upstream writes one record per line, so the
  // count the listing read off the last `seq` is close enough to aim at the tail
  // from. Aim wrong and the worst case is a page that starts early or empty —
  // handled below by aiming once more from the top.
  const tailStart = Math.max(0, (run.events ?? EVENT_PAGE) - EVENT_PAGE);

  const open = useCallback(async () => {
    try {
      let page = await fetchTaskRunEvents(run.taskId, tailStart, EVENT_PAGE, run.runDir);
      // The aim missed the file entirely (a log with fewer lines than records, or
      // a run whose last record is bigger than anything the listing could read):
      // show the head instead, and remember that we did — the offsets on screen
      // are then the log's first lines, not the tail's, and the status line and
      // the paging controls have to agree with that.
      const fellBack = page.events.length === 0 && tailStart > 0;
      if (fellBack) page = await fetchTaskRunEvents(run.taskId, 0, EVENT_PAGE, run.runDir);
      const start = fellBack ? 0 : tailStart;
      setEntries(readTaskRunEntries(page.events));
      setFirstAfter(start);
      setNextLine(page.next);
      setHasMore(page.has_more);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [run.taskId, run.runDir, tailStart]);

  useEffect(() => {
    void open();
  }, [open]);

  // Land at the end of what was fetched, because that is what the reader came
  // for. `atEnd` is false while an earlier page is being prepended, which is the
  // one case where scrolling to the bottom would throw them away from the place
  // they asked to see.
  const atEnd = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dep says records arrived — where to scroll is read from the DOM
  useEffect(() => {
    if (!loaded || !atEnd.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [loaded, entries.length]);

  const loadEarlier = async () => {
    if (earlier) return;
    setEarlier(true);
    atEnd.current = false;
    try {
      const from = Math.max(0, firstAfter - EVENT_PAGE);
      const page = await fetchTaskRunEvents(run.taskId, from, EVENT_PAGE, run.runDir);
      setEntries((current) => [...readTaskRunEntries(page.events), ...current]);
      setFirstAfter(from);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEarlier(false);
    }
  };

  // Forward paging exists for one case: the open aimed at the head because it
  // could not count the log, so everything past the first page is still ahead.
  // Without this the newest events — the ones worth reading — would be unreachable.
  const loadNewer = async () => {
    if (newer) return;
    setNewer(true);
    try {
      const page = await fetchTaskRunEvents(run.taskId, nextLine, EVENT_PAGE, run.runDir);
      atEnd.current = true;
      setEntries((current) => [...current, ...readTaskRunEntries(page.events)]);
      setNextLine(page.next);
      setHasMore(page.has_more);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNewer(false);
    }
  };

  const facts = [
    TASK_STATUS_LABELS[run.status],
    run.subagentType ?? run.kind,
    run.events !== null ? `${run.events} events` : null,
    run.bytes > 0 ? formatBytes(run.bytes) : null,
    run.startedAt ? formatEntryTimeFull(run.startedAt) : null,
  ].filter((fact) => fact !== null);

  // Counts are the log's own line span, not the number of folded rows: a call and
  // its result is one row and two events, and "showing 80 of 214" over folded rows
  // would be a number that means nothing.
  const atHead = firstAfter === 0;
  const status = error
    ? error
    : !loaded
      ? "Loading…"
      : entries.length === 0
        ? "No events in this log yet"
        : atHead && !hasMore && nextLine >= (run.events ?? nextLine)
          ? `The whole log — ${nextLine} event${nextLine === 1 ? "" : "s"}`
          : `Showing events ${firstAfter + 1}–${nextLine} of ${run.events ?? "?"}`;

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
        {atHead && hasMore && !error ? (
          <button type="button" className="link" onClick={() => void loadNewer()} disabled={newer}>
            {newer ? "Loading…" : "Load newer events"}
          </button>
        ) : null}
        {!loaded && !error ? <p className="muted small">Loading…</p> : null}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}
