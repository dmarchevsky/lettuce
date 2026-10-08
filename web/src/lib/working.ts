/**
 * What the composer's working line says while a turn runs.
 *
 * The line used to be the fixed sentence "Agent is working" — true, but it
 * answered none of the questions a running turn actually raises: what is
 * happening right now, is it hung, how fast is it going. This module derives a
 * phase and a short activity from state the client already holds: the
 * transcript (streaming flags, the in-flight tool call), the queue, and the
 * live usage the BFF folds per model step. No protocol addition is involved.
 *
 * The grammar (fixed slots left to right):
 *
 *   ●●○ [icon] bare verb + object, whole · metrics · queue +N · elapsed
 *
 * - the icon slot is reserved even when empty, so the text never shifts;
 * - a metric is shown only while it can change: tok/s and token counts appear
 *   only while the model is generating, never while a tool runs, so a frozen
 *   counter never reads as a hang;
 * - elapsed counts from turn start and sits last, so its digits sit still;
 * - amber means "this looks stuck" (see the stall note), never an error.
 */

import type { TranscriptEntry } from "./messages.ts";
import type { QueuedItem } from "./queue-actions.ts";
import { parseToolArgs, summarizeToolCall } from "./tool-summary.ts";

/** The six states the line can be in; `null` state means no line at all. */
export type WorkingState = "thinking" | "writing" | "tool" | "stopping" | "stall";

export interface WorkingSnapshot {
  state: WorkingState;
  /** Icon name from `components/Icon.tsx`; null leaves the fixed slot empty. */
  icon: string | null;
  /** "Reading", "Codex worker", … */
  verb: string;
  /** The tool's short object (path, command, query); absent for wordless states. */
  object?: string;
  /** Render `object` in mono — paths, commands, URLs. */
  mono?: boolean;
  /** Stall: what the last frame was ("web_search", or "the model"). */
  lastSeen?: string;
}

export interface WorkingInput {
  processing: boolean;
  stopping: boolean;
  entries: readonly TranscriptEntry[];
  queue: readonly QueuedItem[];
  cwd: string | null;
  /** Wall clock, supplied by the caller so the derivation stays pure. */
  now: number;
  /** When this turn's work started; null when nothing is running. */
  turnStartedAt: number | null;
  /** The last frame that reached this conversation (see `use-conversation`). */
  lastActivityAt: number | null;
}

/** Silence for this long with the model apparently working reads as stuck. */
export const STALL_AFTER_MS = 60_000;

/**
 * The in-flight main-agent tool call: a `tool_call` whose return has not
 * arrived. Returns share the id `return:<tool_call_id>` (`lib/messages.ts`),
 * and subagent steps share the conversation's frames, so `subagentId` entries
 * are not this turn's own work.
 */
function inFlightTool(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  const returned = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "tool_return" && entry.toolCallId) returned.add(entry.toolCallId);
  }
  let pending: TranscriptEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "tool_call" || entry.subagentId) continue;
    if (entry.toolCallId && returned.has(entry.toolCallId)) continue;
    pending = entry;
  }
  return pending;
}

function streamingText(entries: readonly TranscriptEntry[]): "assistant" | "reasoning" | null {
  let kind: "assistant" | "reasoning" | null = null;
  for (const entry of entries) {
    if (!entry.streaming || entry.subagentId) continue;
    if (entry.kind === "assistant") kind = "assistant";
    else if (entry.kind === "reasoning") kind = kind === "assistant" ? kind : "reasoning";
  }
  return kind;
}

/** The tool family glyphs; everything else the transcript already draws with. */
const TOOL_ICONS: Record<string, string> = {
  Bash: "terminal",
  BashOutput: "terminal",
  exec_command: "terminal",
  Read: "file",
  ReadFile: "file",
  read_file: "file",
  read_file_gemini: "file",
  Write: "file",
  WriteFile: "file",
  write_file: "file",
  Edit: "edit",
  EditFile: "edit",
  edit_file: "edit",
  replace: "edit",
  MultiEdit: "edit",
  Grep: "search",
  GrepFiles: "search",
  grep_files: "search",
  search_file_content: "search",
  Glob: "search",
  glob_gemini: "search",
  LS: "folder",
  ListDir: "folder",
  list_dir: "folder",
  list_directory: "folder",
  web_search: "search",
  WebSearch: "search",
  fetch_webpage: "globe",
  WebFetch: "globe",
  Task: "task",
  Agent: "task",
  Skill: "model",
  memory: "memory",
  Wake: "history",
  TodoWrite: "task",
  MessageChannel: "chats",
  WatchPR: "branch",
};

/**
 * Bare-verb names per tool family. The line must fit the whole activity at
 * phone width without truncating it, so every verb is one short word and the
 * object rides verbatim: `Read docker/compose.yml`, `Run docker compose
 * build`, `Search cloudflared 530`.
 */
const TOOL_VERBS: Record<string, string> = {
  Bash: "Run",
  BashOutput: "Collect",
  exec_command: "Run",
  Read: "Read",
  ReadFile: "Read",
  read_file: "Read",
  read_file_gemini: "Read",
  Write: "Write",
  WriteFile: "Write",
  write_file: "Write",
  Edit: "Edit",
  EditFile: "Edit",
  edit_file: "Edit",
  replace: "Edit",
  MultiEdit: "Edit",
  Grep: "Grep",
  GrepFiles: "Grep",
  grep_files: "Grep",
  search_file_content: "Grep",
  Glob: "Glob",
  glob_gemini: "Glob",
  LS: "List",
  ListDir: "List",
  list_dir: "List",
  list_directory: "List",
  web_search: "Search",
  WebSearch: "Search",
  fetch_webpage: "Fetch",
  WebFetch: "Fetch",
  Task: "Subagent",
  Agent: "Subagent",
  Skill: "Skill",
  memory: "Memory",
  Wake: "Schedule",
  TodoWrite: "Plan",
  MessageChannel: "Post",
  WatchPR: "Watch PR",
};

function str(args: Record<string, unknown> | null, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
}

/** "4:10", "0:42"; hours only once they happen. Tabular by CSS. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Truncate in the middle so the tail survives: a path or command's meaning is
 * its filename and extension, which a CSS end-ellipsis is guaranteed to eat.
 */
export function middleEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars || maxChars < 5) return text;
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Budget for pathological arguments only; normal activity text rides whole. */
export const OBJECT_MAX_CHARS = 120;

/**
 * The line's activity for one tool call: bare verb + the object verbatim,
 * reusing the transcript's own summariser so the two never disagree about a
 * path. Nothing readable is truncated — the activity is the line's one
 * guaranteed reader; only absurd arguments are clipped, mid-string.
 */
export function describeTool(
  entry: TranscriptEntry,
  cwd: string | null,
): Pick<WorkingSnapshot, "icon" | "verb" | "object" | "mono"> {
  const name = entry.toolName ?? "";
  const args = parseToolArgs(entry.toolArgs);
  const icon = TOOL_ICONS[name] ?? null;

  if ((name === "Task" || name === "Agent") && args) {
    const worker = str(args, "subagent_type");
    const description = str(args, "description") || str(args, "prompt");
    const short = description ? middleEllipsis(description, OBJECT_MAX_CHARS) : "";
    if (worker === "codex") return { icon: "model", verb: "Codex:", object: short || undefined };
    if (worker === "claude-code")
      return { icon: "model", verb: "Claude:", object: short || undefined };
    const label = worker ? `${worker} subagent:` : "Subagent:";
    return { icon: "task", verb: label, object: short || undefined };
  }

  const verb = TOOL_VERBS[name] ?? (name ? `Use ${name}` : "Working");
  const summary = summarizeToolCall(name, args, cwd);
  if (!summary) return { icon, verb };
  // The transcript's Bash headline carries a "$ " prompt; the verb here is "Run".
  const object = middleEllipsis(summary.headline, OBJECT_MAX_CHARS).replace(/^\$ /, "");
  return { icon, verb, object: object || undefined, mono: summary.mono };
}

/** The last thing that could explain a stall — a tool name, or the model. */
function lastSeenLabel(entries: readonly TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && !entry.subagentId && entry.kind === "tool_call" && entry.toolName) {
      return entry.toolName;
    }
  }
  return "the model";
}

/**
 * Derive the working line, or null when nothing should show (idle, or the turn
 * ended — the caller only mounts the line while `processing`).
 */
export function deriveWorking(input: WorkingInput): WorkingSnapshot | null {
  if (!input.processing) return null;
  if (input.stopping) return { state: "stopping", icon: null, verb: "Stopping…" };

  const tool = inFlightTool(input.entries);
  const streaming = streamingText(input.entries);

  // Silence while nothing runs — long prefills and stuck model calls. A tool
  // running with no frames (a slow build) is doing fine, so it never stalls.
  const silent =
    input.lastActivityAt !== null && input.now - input.lastActivityAt >= STALL_AFTER_MS;
  if (silent && !tool && !streaming) {
    return {
      state: "stall",
      // No icon for the fixed slot: the stall branch of the component already
      // puts the warning triangle in the leading slot — setting one here
      // drew the triangle twice.
      icon: null,
      verb: "No activity",
      lastSeen: lastSeenLabel(input.entries),
    };
  }

  if (tool) {
    return { state: "tool", ...describeTool(tool, input.cwd) };
  }
  if (streaming === "assistant") return { state: "writing", icon: null, verb: "Writing" };
  return { state: "thinking", icon: null, verb: "Thinking" };
}

/** How many queued items will actually drain (parked ones do not). */
export function drainingQueueCount(queue: readonly QueuedItem[]): number {
  return queue.filter((item) => !item.paused).length;
}
