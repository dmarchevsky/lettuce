/**
 * Subagent task runs, as the browser sees them: the Runs pane's file-backed list
 * and its transcript viewer. Everything goes through the BFF's `/api/task-runs`
 * routes — the event logs live in the app-server's scratchpad, outside what a
 * browser may touch, and they outlive the process that wrote them.
 *
 * The types mirror `bff/src/runs/task-logs.ts`; the two packages cannot import
 * from each other. An event record is upstream's own JSON, untouched: this module
 * is where it becomes something renderable, and where its odd edges (a `[truncated
 * N bytes]` cut, an `events_missed` notice, a run whose log ends mid-line) are
 * named once instead of at every call site.
 */

import { formatBytes } from "./download.ts";

export type TaskRunStatus = "running" | "completed" | "unknown";
export type TaskRunKind = "codex" | "claude-code" | "subagent";

export interface TaskRunSummary {
  taskId: string;
  kind: TaskRunKind;
  /** The transcript's own `[subagent_type: …]`, verbatim — the row's label. */
  subagentType: string | null;
  description: string | null;
  /** Archive dir the files live in; null for the current generation. */
  generation: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  bytes: number;
  /** Event count, read off the last record's `seq`; null when unparseable. */
  events: number | null;
  status: TaskRunStatus;
}

/** The status chip's tone, matching the sibling lists' vocabulary. */
export const TASK_STATUS_LABELS: Record<TaskRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  unknown: "Stopped",
};

export const TASK_STATUS_TONES: Record<TaskRunStatus, string> = {
  running: "",
  completed: " ok-tag",
  unknown: " muted",
};

/**
 * A page of runs. `other` is always 0: a task transcript names no owner, so the
 * listing cannot scope itself to an agent and will not pretend to — the pane shows
 * every run of this kind and the Runs tab's `show all` count stays honest.
 */
export interface TaskRunListPage {
  runs: TaskRunSummary[];
  other: number;
  next: number | null;
  has_more: boolean;
}

export async function fetchTaskRuns(limit = 10, cursor = 0): Promise<TaskRunListPage> {
  const response = await ok(await fetch(`/api/task-runs?limit=${limit}&cursor=${cursor}`));
  const body = (await response.json()) as {
    runs: TaskRunSummary[];
    next?: number | null;
    has_more?: boolean;
  };
  return { runs: body.runs, other: 0, next: body.next ?? null, has_more: body.has_more === true };
}

/** One page of a transcript, oldest first, plus where to continue forward. */
export interface TaskRunEventPage {
  taskId: string;
  generation: string | null;
  events: Record<string, unknown>[];
  next: number;
  has_more: boolean;
}

export async function fetchTaskRunEvents(
  taskId: string,
  after: number,
  limit: number,
): Promise<TaskRunEventPage> {
  const response = await ok(
    await fetch(
      `/api/task-runs/${encodeURIComponent(taskId)}/events?after=${after}&limit=${limit}`,
    ),
  );
  return (await response.json()) as TaskRunEventPage;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

/** How much of a transcript one request brings back. */
export const EVENT_PAGE = 120;

/**
 * A renderable line of a transcript. A tool call and its result are ONE entry —
 * a call whose output has not arrived yet is the same entry with no `output`, so
 * a run still in progress renders as it fills in rather than half-renders.
 */
export type TaskRunEntry =
  | {
      kind: "call";
      seq: number;
      at: string | null;
      name: string;
      /** The arguments, verbatim: the transcript's own summariser parses them. */
      input: string | null;
      output: string | null;
      isError: boolean;
      /** When the result arrived, so the row can state how long the call took. */
      endedAt: string | null;
      /** Set when the call's own record carried upstream's cut marker. */
      truncated: boolean;
    }
  | { kind: "text"; seq: number; at: string | null; text: string; reasoning: boolean }
  | { kind: "notification"; seq: number; at: string | null; text: string }
  /** A background command's completion notice, or a log that stopped on its own. */
  | { kind: "notice"; seq: number; at: string | null; text: string };

/** Upstream's own marker for a cut field, as `capTaskEvent` writes it. */
const TRUNCATED_MARKER = /\[truncated \d+ bytes\]/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function time(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The log's records, oldest first, folded into renderable entries.
 *
 * Deliberately forgiving: a record of a type we do not know is dropped rather than
 * thrown, and a tool result whose call fell off the front of the page keeps itself
 * as its own entry — paging starts wherever it starts, and dropping the orphans
 * would hide the very output a paged reader scrolled back for.
 */
export function readTaskRunEntries(raw: readonly Record<string, unknown>[]): TaskRunEntry[] {
  const entries: TaskRunEntry[] = [];
  /** Open calls by their wire id, so a result can find its own call. */
  const open = new Map<string, TaskRunEntry & { kind: "call" }>();

  for (const record of raw) {
    const seq = Number(record.seq) || 0;
    const at = time(record.at);
    switch (record.type) {
      case "tool_call": {
        const id = text(record.id);
        const input = readInput(record.input);
        const entry: TaskRunEntry & { kind: "call" } = {
          kind: "call",
          seq,
          at,
          name: text(record.name) ?? "tool",
          input,
          output: null,
          isError: false,
          endedAt: null,
          truncated: input !== null && TRUNCATED_MARKER.test(input),
        };
        entries.push(entry);
        if (id) open.set(id, entry);
        break;
      }
      case "tool_result": {
        const id = text(record.tool_call_id);
        const output = text(record.output) ?? "";
        const isError = record.is_error === true;
        const call = id ? open.get(id) : undefined;
        if (call) {
          call.output = output;
          call.isError = isError;
          call.endedAt = at;
          if (TRUNCATED_MARKER.test(output)) call.truncated = true;
          break;
        }
        // Orphan: a result with no call in this page. Render it under the name
        // the result itself carries (upstream fills it in), unnamed otherwise.
        entries.push({
          kind: "call",
          seq,
          at,
          name: text(record.name) ?? "result",
          input: null,
          output,
          isError,
          endedAt: null,
          truncated: TRUNCATED_MARKER.test(output),
        });
        break;
      }
      case "text":
      case "reasoning": {
        const body = text(record.text);
        if (body) {
          entries.push({
            kind: "text",
            seq,
            at,
            text: body,
            reasoning: record.type === "reasoning",
          });
        }
        break;
      }
      case "notification": {
        const body = text(record.text);
        if (body) entries.push({ kind: "notification", seq, at, text: body });
        break;
      }
      case "oversized_record": {
        // The BFF's own bound on one record (`MAX_LINE_BYTES`): the reader says
        // how big it was and shows a preview, rather than dropping an event the
        // reader paged to see.
        const bytes = Number(record.bytes) || 0;
        const preview = text(record.preview);
        entries.push({
          kind: "notice",
          seq,
          at,
          text: `One record of ${formatBytes(bytes)} was too large to show${
            preview ? `:\n${preview}` : ""
          }`,
        });
        break;
      }
      case "events_missed": {
        const missed = Number(record.missed) || 0;
        if (missed > 0) {
          entries.push({
            kind: "notice",
            seq,
            at,
            text: `${missed} earlier events were not received`,
          });
        }
        break;
      }
      case "status": {
        // The only one upstream writes is `event_log_full`: the log stopped
        // because it reached its size cap, which the reader deserves to know.
        if (record.status === "event_log_full") {
          entries.push({ kind: "notice", seq, at, text: "The event log reached its size limit." });
        }
        break;
      }
      default:
        break;
    }
  }
  return entries;
}

/**
 * A call's arguments as a string the transcript's summariser can parse. Upstream
 * stores them parsed when it can and raw when it cannot, so both arrive here.
 */
function readInput(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** How long a call took, from its own two records, or null if either is missing. */
export function callDuration(entry: Extract<TaskRunEntry, { kind: "call" }>): string | null {
  if (!entry.at || !entry.endedAt) return null;
  const ms = Date.parse(entry.endedAt) - Date.parse(entry.at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
