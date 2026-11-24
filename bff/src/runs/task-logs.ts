/**
 * Durable subagent run transcripts — the Runs pane's file-backed list.
 *
 * Upstream keeps a *running* task's events in process memory (a per-task buffer
 * read back with `read_subagent_events`) and that dies with the app-server. The
 * durable record is the file beside it: every event is appended to
 * `<task_id>.jsonl` next to the task's readable `<task_id>.log`, inside the
 * background-output dir — a fresh `mkdtemp(os.tmpdir()/letta-background-)` per
 * process, which `TMPDIR` pins under `$LETTA_STATE_DIR/task-logs` at the same
 * absolute path in the app-server (rw, it writes) and in this container (rw, for
 * the retention prune alone). See `docker/compose.yml` and letta-code
 * `src/tools/impl/task-transcript.ts`.

 * Two upstream facts set the shape of everything here.
 *
 *  - **A task id is unique per process, not per name.** `getNextTaskId()` counts
 *    up from `task_1` in every process, `createBackgroundOutputFile` *truncates*
 *    `<id>.log` on create, and the events log opens in append mode. Upstream's
 *    isolation is therefore the directory — one process, one `mkdtemp` dir — so
 *    the run directory is the other half of a run's identity here, and nothing
 *    this module maintains has to keep names unique.
 *  - **One directory, many writers.** `createBackgroundOutputFile` has nine call
 *    sites — bash, monitor, workflow, exec, watch-pr — so a file sitting there
 *    that is not a task is normal. Anything whose start block does not parse is
 *    skipped, never an error, which is why the listing reads the start block
 *    rather than trusting the name.
 *
 * Nothing here goes upstream and nothing needs the socket: the files are local
 * to this container, so the list answers while the app-server is down, which is
 * exactly when the history matters. One verb destroys anything — retention's
 * delete of a whole run directory — and it operates only on a name inside its own
 * root after the guard chain below has proved it (`files/delete.ts` is the shape).
 *
 * The file sizes are upstream's ceiling, not ours: a single run's event log may
 * reach 256 MiB (`TASK_EVENTS_MAX_BYTES`), so nothing here reads a whole file.
 * The listing reads a bounded head and tail, and the page reader stops as soon
 * as the page is full.
 */

import { lstatSync, realpathSync } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { normalizePosixPath } from "../session/protocol.ts";
import { symlinkViolation } from "../session/symlink-guard.ts";

/** Where the app-server writes its task logs. The `TMPDIR` root, same path. */
export const TASK_LOG_ROOT_DEFAULT = "/var/lettuce/task-logs";

/** How long a finished run's directory is kept, absent `TASK_LOG_RETENTION_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 14;

/** `<task_id>.log` / `<task_id>.jsonl`. Upstream's ids are `task_<n>`, digits only. */
const TASK_ID_RE = /^task_[0-9A-Za-z_-]{1,40}$/;
/**
 * One process's run directory. `getBackgroundOutputDir()` makes it with
 * `mkdtempSync(os.tmpdir()/"letta-background-")` — six random characters — and
 * nothing else in the tree is a run. This grammar is the whole identity rule:
 * a task id is unique only *inside* one of these directories, so nothing outside
 * it is ever listed, read, or deleted.
 */
const RUN_DIR_RE = /^letta-background-[A-Za-z0-9]{6}$/;
/** `[Task started: …]` then `[subagent_type: …]` — `writeTaskTranscriptStart`. */
const START_BLOCK_RE = /^\[Task started: ([\s\S]*?)\]\n\[subagent_type: ([^\]\n]*)\]/;

/** How much of the readable log the start block could possibly need. */
const START_BLOCK_BYTES = 4_096;
/** How much of the event log one head read covers: the first record, whatever
 * size its first tool call's arguments are. */
const EVENT_HEAD_BYTES = 64 * 1024;
/** How much of the events tail one read covers — enough for the last record. */
const TAIL_BYTES = 64 * 1024;
/** Read granularity of the page reader. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Ceiling on one events page's payload, so a page costs a page, not the run. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/**
 * Ceiling on one line of the events log. A single record is not capped by
 * upstream when it is written to the file, so this is the only bound between a
 * fat record and a browser. A line over it is replaced whole by an
 * `oversized_record` with a preview: cutting JSON mid-way would not parse, and a
 * silent drop would hide the very output a reader scrolled back for.
 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** How much of an oversized record is still shown, as its preview. */
const OVERSIZED_PREVIEW_BYTES = 4 * 1024;
/** A file touched this recently is still producing events, so the run is live. */
const RUNNING_WINDOW_MS = 5 * 60 * 1000;
/** How much of the readable log's tail carries its closing line, if it has one. */
const LOG_TAIL_BYTES = 4 * 1024;
/** Candidates considered per listing, newest first — the run tree is unbounded. */
const MAX_CANDIDATES = 500;
/** Start blocks read per page, on top of `limit`, so one page stays one page. */
const MAX_PARSE_ATTEMPTS = 400;

export type TaskRunKind = "codex" | "claude-code" | "subagent";
/**
 * What the file proves about how a run ended. `stopped` is its own answer on
 * purpose: a log that simply stopped writing proves the run stopped, not that it
 * failed, and upstream's own `[Task completed]` / `[Task failed]` closing lines
 * are the only evidence either way.
 */
export type TaskRunStatus = "running" | "completed" | "failed" | "stopped";

/** What the Runs row states: what the file proves, not what the process knew. */
export interface TaskRunSummary {
  taskId: string;
  kind: TaskRunKind;
  /** The transcript's own `[subagent_type: …]`, verbatim, for the row's label. */
  subagentType: string | null;
  /** The run's own description from the start block; null if unreadable.
   */
  description: string | null;
  /** The process directory this pair lives in — what makes its id unique. */
  runDir: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Bytes of both files together — the row's "how big". */
  bytes: number;
  /** Event count, read off the last record's `seq`; null when unparseable. */
  events: number | null;
  status: TaskRunStatus;
}

export interface TaskRunList {
  runs: TaskRunSummary[];
  /** Cursor for the next page — an offset into the ordered candidates. */
  next: number | null;
  has_more: boolean;
}

/** One page of a transcript: the records verbatim, plus where to continue. */
export interface TaskRunEventsPage {
  taskId: string;
  runDir: string;
  /** Upstream's own records (`seq`, `at`, `type`, and its fields), untouched. */
  events: Record<string, unknown>[];
  /** Line offset of the first event not returned — pass it back as `after`. */
  next: number;
  has_more: boolean;
}

/** The file kinds the io reports: a symlink is `other`, so nothing follows it. */
export interface TaskLogEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

export interface TaskFileStat {
  bytes: number;
  mtimeMs: number;
}

/** A window of whole lines from a file, plus where the window ended. */
export interface LineWindow {
  lines: string[];
  /** Line offset just past the last line the window covers. */
  nextLines: number;
  hasMore: boolean;
}

/**
 * The file access this module needs, and the seam its tests drive.
 *
 * Everything here is one filesystem fact per method, so the guard chain, the
 * retention pass and the page arithmetic are all testable against a fixture
 * directory (`fsTaskLogIo` is the real one; the tests use it pointed at a temp
 * dir, because mtime order, symlinks and a real rename cannot be faked honestly).
 */
export interface TaskLogIo {
  /** Direct children of `dir`, or null when it does not exist. */
  list(dir: string): Promise<TaskLogEntry[] | null>;
  /** Size and mtime of one path, or null when it is gone. */
  stat(path: string): Promise<TaskFileStat | null>;
  /** Up to `maxBytes` from the start, or null when the file is missing. */
  readHead(path: string, maxBytes: number): Promise<string | null>;
  /** Up to `maxBytes` from the end, or null when the file is missing. */
  readTail(path: string, maxBytes: number): Promise<string | null>;
  /**
   * Up to `limit` whole lines starting after line `after` (0-based), stopping
   * early at `maxBytes`. The reader stops as soon as the window is full, so a
   * page never costs the whole file.
   */
  readLineWindow(path: string, after: number, limit: number, maxBytes: number): Promise<LineWindow>;
  removeDir(dir: string): Promise<void>;
  realpath(path: string): string;
  lstat(path: string): { isSymbolicLink(): boolean };
}

/** `FileHandle`, named without importing the type — `node:fs/promises` re-exports it unevenly. */
type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Open one file, read it, close it — and read as absent when it is not there.
 *
 * A transcript directory is written by another process: a file can be listed and
 * gone by the time it is opened, and "no such run" is the honest answer. Any
 * other failure is left to the caller, because a permission error is not the same
 * fact as a missing file and must not be made to look like one.
 */
async function withHandle<T>(
  path: string,
  read: (handle: FileHandle) => Promise<T>,
): Promise<T | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return await read(handle);
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The default io: this container's own bind of the shared scratchpad. */
export const fsTaskLogIo: TaskLogIo = {
  async list(dir) {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    }));
  },

  async stat(path) {
    try {
      const info = await stat(path);
      return { bytes: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },

  async readHead(path, maxBytes) {
    return withHandle(path, async (handle) => {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.toString("utf8", 0, bytesRead);
    });
  },

  async readTail(path, maxBytes) {
    return withHandle(path, async (handle) => {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      // A seeked tail can begin mid-character; one replacement glyph in a line
      // that will not parse anyway is the cheapest way to handle it, and it is
      // what `pi/runner.ts` does for the same reason.
      return buffer.toString("utf8", 0, bytesRead);
    });
  },

  async readLineWindow(path, after, limit, maxBytes) {
    const window = await withHandle(path, (handle) =>
      readWholeLines(handle, after, limit, maxBytes),
    );
    return window ?? { lines: [], nextLines: after, hasMore: false };
  },

  removeDir: async (dir) => {
    // `force` only swallows ENOENT, which is the one case worth swallowing here:
    // a directory can go missing between `runDirs()` and this call (a recreate,
    // someone cleaning up) and a listing must not turn that into a 500.
    await rm(dir, { recursive: true, force: true });
  },
  realpath: (path) => realpathSync(path),
  lstat: (path) => lstatSync(path),
};

/**
 * Whole lines only, from a `FileHandle`, with the window bounded twice over.
 *
 * `after` counts lines already shown, so skipping them costs a scan of the bytes
 * before them: a page's memory is one page, but its time is proportional to how
 * far into the file it sits. That is the accepted cost of a line-addressed cursor
 * and it is why the sheet opens at the tail rather than paging from the top.
 * A trailing partial line (a run still appending) is left for the next read
 * rather than parsed as an event.
 *
 * One record may still be huge: upstream caps an event only on the wire path
 * (`capTaskEvent` in `agent/subagent-events.ts` is applied by `storeSubagentEvent`,
 * not by the file appender), so a single line is cut at {@link MAX_LINE_BYTES}
 * with a marker, the way upstream itself cuts an oversized event. The rest of that
 * line is skipped, not buffered.
 */
async function readWholeLines(
  handle: FileHandle,
  after: number,
  limit: number,
  maxBytes: number,
): Promise<LineWindow> {
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const lines: string[] = [];
  let offset = 0;
  let pending = "";
  /** A line too big to buffer: counted and previewed, never held whole. */
  let oversize: { bytes: number; preview: string } | null = null;
  let lineIndex = 0;
  let collected = 0;
  let usedBytes = 0;
  let nextLines = after;
  let tripped = false;
  let ahead = false;

  /** One whole line, in order: count it, deliver it, or trip the page limit. */
  const take = (piece: string): void => {
    lineIndex++;
    if (tripped) {
      if (piece.length > 0) ahead = true;
      return;
    }
    if (lineIndex <= after) return;
    // Counted in bytes, not in JavaScript characters: a transcript of CJK or
    // emoji would otherwise slip a page three times the advertised size past the
    // ceiling the browser was promised.
    const bytes = Buffer.byteLength(piece);
    if (collected >= limit || (collected > 0 && usedBytes + bytes > maxBytes)) {
      tripped = true;
      // The line that tripped the limit was not delivered, so there is more —
      // unless it was blank, in which case only a byte of probe can say.
      if (piece.length > 0) ahead = true;
      return;
    }
    lines.push(piece);
    collected++;
    usedBytes += bytes;
    nextLines = lineIndex;
  };

  while (!tripped) {
    const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, offset);
    offset += bytesRead;
    const eof = bytesRead === 0;
    let text = decoder.decode(buffer.subarray(0, bytesRead), { stream: !eof });

    // Mid-way through a record too big to hold: count bytes until its newline
    // arrives, then the rest of this chunk is ordinary text again.
    if (oversize) {
      const nl = text.indexOf("\n");
      if (nl < 0) {
        oversize.bytes += Buffer.byteLength(text);
        text = "";
      } else {
        oversize.bytes += Buffer.byteLength(nl < 0 ? text : text.slice(0, nl));
        text = text.slice(nl + 1);
        take(
          JSON.stringify({
            type: "oversized_record",
            bytes: oversize.bytes,
            preview: oversize.preview,
          }),
        );
        oversize = null;
      }
    }

    text = pending + text;
    const pieces = text.split("\n");
    // The last piece has no newline yet: either the rest of this chunk will
    // complete it, or at EOF it is a line the writer has not finished.
    pending = pieces.pop() ?? "";
    for (const piece of pieces) take(piece);

    // Past the ceiling and still no newline: stop holding it. A partial line at
    // EOF is left for the next read rather than parsed as an event, so an
    // oversized tail simply never resolves into a record.
    if (!oversize && pending.length > MAX_LINE_BYTES) {
      oversize = {
        bytes: Buffer.byteLength(pending),
        preview: pending.slice(0, OVERSIZED_PREVIEW_BYTES),
      };
      pending = "";
    }

    if (eof) {
      if (tripped) return { lines, nextLines, hasMore: ahead || pending.length > 0 };
      // Nothing past `after` — including the case where `after` is already past
      // the end. `nextLines` stays where the reader left it so the contract
      // ("pass it back as `after`") never walks a caller backwards.
      return { lines, nextLines: collected > 0 ? lineIndex : after, hasMore: false };
    }
    if (tripped) {
      // The line that tripped the limit was not delivered, so there is more —
      // unless nothing but blanks is in hand, which one byte of probe decides.
      const moreInHand = ahead || pending.length > 0;
      if (moreInHand) return { lines, nextLines, hasMore: true };
      const probe = await handle.read(buffer, 0, 1, offset);
      return { lines, nextLines, hasMore: probe.bytesRead > 0 };
    }
  }
  return { lines, nextLines, hasMore: true };
}

/** A name this module will accept as a task id — no traversal, no separators. */
export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value);
}

/**
 * A name this module will accept as a run directory — upstream's `mkdtemp` shape
 * and nothing else. A URL supplies this before any path is built from it, so the
 * grammar is what keeps a caller inside one process's directory.
 */
export function isRunDir(value: string): boolean {
  return RUN_DIR_RE.test(value);
}

/**
 * Codex and Claude Code run as subagents too, and their transcripts are here as
 * well as in their own homes — the row says which one it is so the pane does not
 * show the same run twice under two labels.
 */
export function taskRunKindOf(subagentType: string | null): TaskRunKind {
  if (subagentType === "codex") return "codex";
  if (subagentType === "claude-code") return "claude-code";
  return "subagent";
}

/**
 * Why a path is not this root's to touch — or null. Purely lexical, so it is
 * usable on a path that does not exist yet.
 */
function lexicalViolation(root: string, path: string): string | null {
  if (path.includes("\0")) return "path contains a null byte";
  const resolved = normalizePosixPath(path);
  return resolved === root || resolved.startsWith(`${root}/`)
    ? null
    : `${resolved} is not under ${root}`;
}

/**
 * The component-wise symlink walk, which tolerates an absent tail — a link
 * anywhere in the path is a refusal, and a missing component is not.
 *
 * Component-wise before any resolution, so nothing is followed on the way to
 * deciding: `session/symlink-guard.ts`, same reason, one tree over.
 */
function linkViolation(io: TaskLogIo, root: string, path: string): string | null {
  return symlinkViolation(normalizePosixPath(path), root, (target) => io.lstat(target));
}

/**
 * The `realpath` re-check, which needs the path to exist: the resolved path must
 * still be inside the root, so a link that the walk above somehow missed (or one
 * swapped in after it) cannot land a read or a move outside.
 */
function containmentViolation(io: TaskLogIo, root: string, path: string): string | null {
  let real: string;
  try {
    real = io.realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return `${path} does not exist`;
  }
  const resolved = normalizePosixPath(real);
  return resolved === root || resolved.startsWith(`${root}/`)
    ? null
    : `${real} is not under ${root}`;
}

/** A directory this module may list or remove: inside the root, real, link-free. */
function dirViolation(io: TaskLogIo, root: string, dir: string): string | null {
  return (
    lexicalViolation(root, dir) ??
    linkViolation(io, root, dir) ??
    containmentViolation(io, root, dir)
  );
}

/**
 * The run directories under the root, newest first.
 *
 * Upstream's `mkdtemp` name is random, so order comes from each directory's own
 * mtime, which is when its process last created something inside it. A directory
 * this module cannot prove is inside the root, or whose name is not upstream's
 * own shape, is not a run and is never opened.
 */
async function runDirs(io: TaskLogIo, root: string): Promise<string[]> {
  const entries = await io.list(root);
  if (!entries) return [];
  const dated: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "dir" || !RUN_DIR_RE.test(entry.name)) continue;
    const dir = `${root}/${entry.name}`;
    if (dirViolation(io, root, dir)) continue;
    const info = await io.stat(dir);
    dated.push({ name: entry.name, mtimeMs: info?.mtimeMs ?? 0 });
  }
  return dated
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .map((entry) => entry.name);
}

interface Pair {
  /** The readable log, or null when only the event log survived. */
  logPath: string | null;
  eventsPath: string | null;
  logStat: TaskFileStat | null;
  eventsStat: TaskFileStat | null;
}

/**
 * `io.stat` for a path that must be provably inside the root.
 *
 * A link in any component, or a resolved path elsewhere, reads as *absent*: a
 * scratchpad an agent can write into is a tree where `task_1.log` may be a
 * symlink to somewhere else, and "no such run" is the right answer for it. The
 * `realpath` runs after the `lstat` walk, so the only window left is the one
 * `files/delete.ts` documents — closing it needs `openat`, which Bun does not
 * expose — and here it guards a read, not a removal.
 */
async function guardedStat(
  io: TaskLogIo,
  root: string,
  path: string,
): Promise<TaskFileStat | null> {
  if (lexicalViolation(root, path) || linkViolation(io, root, path)) return null;
  const info = await io.stat(path);
  if (!info) return null;
  return containmentViolation(io, root, path) ? null : info;
}

/**
 * Both halves of one run's files in one directory, proved to live inside `root`.
 *
 * `dirOk` is the directory's own verdict, computed once per directory by the
 * caller: a listing walks hundreds of files through one directory, and the
 * `realpath` that proves the directory says nothing new per file. Each half is
 * still checked on its own, because a scratchpad an agent can write into can hold
 * a `task_1.log` that is a symlink to anywhere.
 *
 * A `.jsonl` half that does not exist is not a refusal — a task whose event log
 * could not be opened has a readable log and nothing else.
 */
async function statPair(
  io: TaskLogIo,
  root: string,
  dir: string,
  taskId: string,
  dirOk: boolean,
): Promise<Pair | null> {
  if (!dirOk) return null;
  const logStat = await guardedStat(io, root, `${dir}/${taskId}.log`);
  const eventsStat = await guardedStat(io, root, `${dir}/${taskId}.jsonl`);
  if (!logStat && !eventsStat) return null;
  return {
    logPath: logStat ? `${dir}/${taskId}.log` : null,
    eventsPath: eventsStat ? `${dir}/${taskId}.jsonl` : null,
    logStat,
    eventsStat,
  };
}

interface Candidate {
  taskId: string;
  runDir: string;
  logPath: string;
  eventsPath: string | null;
  /** Newest mtime of the pair, which is what "recently ran" means here. */
  activityMs: number;
  bytes: number;
}

/**
 * Every `task_*` pair the pane can offer, newest run directory first, capped.
 *
 * Only the pair's facts (mtime, size) are collected here; the start block is read
 * later, for the candidates a page actually shows. Directories are walked newest
 * first so hitting the cap drops the oldest runs rather than a scatter of them.
 */
async function collectCandidates(io: TaskLogIo, root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const runDir of await runDirs(io, root)) {
    const dir = `${root}/${runDir}`;
    const entries = await io.list(dir);
    if (!entries) continue;
    const dirOk = dirViolation(io, root, dir) === null;
    for (const entry of entries) {
      // The readable log is the marker: it carries the start block, and a
      // `.jsonl` without one has nothing to show.
      if (entry.kind !== "file" || !entry.name.endsWith(".log")) continue;
      const taskId = entry.name.slice(0, -".log".length);
      if (!isTaskId(taskId)) continue;
      const pair = await statPair(io, root, dir, taskId, dirOk);
      // No readable log means no start block means nothing to say about it.
      if (!pair?.logPath) continue;
      candidates.push({
        taskId,
        runDir,
        logPath: pair.logPath,
        eventsPath: pair.eventsPath,
        activityMs: Math.max(pair.logStat?.mtimeMs ?? 0, pair.eventsStat?.mtimeMs ?? 0),
        bytes: (pair.logStat?.bytes ?? 0) + (pair.eventsStat?.bytes ?? 0),
      });
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

/**
 * Both halves of one run's files, in one directory proved to be a run directory.
 *
 * The id and the directory both arrive from a URL, so neither is derived from
 * until it matches the grammar it claims: a task id is unique only inside its
 * process directory, which is why a row carries both halves of its identity.
 * Without a named directory the newest one holding the id wins.
 */
async function locatePair(
  io: TaskLogIo,
  root: string,
  taskId: string,
  runDir?: string,
): Promise<{ runDir: string } & Pair> {
  const wanted = runDir ? [runDir] : await runDirs(io, root);
  for (const name of wanted) {
    if (!RUN_DIR_RE.test(name)) break;
    const dir = `${root}/${name}`;
    const pair = await statPair(io, root, dir, taskId, dirViolation(io, root, dir) === null);
    if (pair) return { runDir: name, ...pair };
  }
  return { runDir: "", logPath: null, eventsPath: null, logStat: null, eventsStat: null };
}

/** The start block's two facts, or null when the file is not a task transcript. */
async function readStartBlock(io: TaskLogIo, logPath: string): Promise<StartBlock | null> {
  const head = await io.readHead(logPath, START_BLOCK_BYTES);
  if (head === null) return null;
  const match = START_BLOCK_RE.exec(head);
  if (!match) return null;
  const description = (match[1] ?? "").trim().slice(0, 500);
  const subagentType = (match[2] ?? "").trim().slice(0, 80);
  // An empty start block is upstream's truncation-before-the-first-event window,
  // or a file that is not a task at all. Either way there is nothing to say.
  if (!description || !subagentType) return null;
  return { description, subagentType };
}

interface StartBlock {
  description: string;
  subagentType: string;
}

/** `at` of the first record, from a bounded head read. */
async function firstEventTime(io: TaskLogIo, eventsPath: string): Promise<string | null> {
  const head = await io.readHead(eventsPath, EVENT_HEAD_BYTES);
  if (!head) return null;
  for (const line of head.split("\n")) {
    const at = recordTime(line);
    if (at) return at;
  }
  return null;
}

/**
 * `at` and `seq` of the last record, from a bounded tail read.
 *
 * A tail read begins wherever the byte window began, so its first line is often
 * a fragment of a record. Nothing needs to know that: the walk goes back from the
 * end and a fragment simply does not parse, which is the same refusal a junk line
 * gets. The last record that parses is the last event, and its `seq` is the event
 * count upstream numbered for us.
 */
async function lastEventFact(io: TaskLogIo, eventsPath: string): Promise<LastEvent> {
  // A tail read begins wherever the byte window began, so its first line is often
  // a fragment of a record. Nothing needs to know that: the walk goes back from
  // the end and a fragment simply does not parse, which is the same refusal a
  // junk line gets. The last record that parses is the last event, and its `seq`
  // is the event count upstream numbered for us.
  //
  // The window grows when nothing parses, because a run's final record can be
  // bigger than the window — one large tool result as the last event leaves no
  // line boundary in 64 KiB at all. Still bounded: 8 MiB of tail is far past any
  // real record, and a log whose last line is bigger than that is reported as
  // unknown rather than read forever.
  const windows = [TAIL_BYTES, 1024 * 1024, 8 * 1024 * 1024];
  for (const size of windows) {
    const tail = await io.readTail(eventsPath, size);
    if (!tail) return {};
    const found = lastRecord(tail);
    if (found) return found;
    // The window already covered the whole file; a wider one reads the same bytes.
    if (tail.length < size) return {};
  }
  return {};
}

function lastRecord(tail: string): LastEvent | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const entry = record as Record<string, unknown>;
    const seq = typeof entry.seq === "number" && entry.seq >= 0 ? entry.seq : null;
    const at = typeof entry.at === "string" ? entry.at : null;
    if (seq === null && at === null) continue;
    return { at, seq };
  }
  return null;
}

interface LastEvent {
  at?: string | null;
  seq?: number | null;
}

function recordTime(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    return typeof record?.at === "string" ? record.at : null;
  } catch {
    return null;
  }
}

/**
 * Drop run directories that have been quiet for the retention window.
 *
 * This is the only delete in this file. It removes a whole `letta-background-*`
 * directory — one process's runs — and only when its newest entry is older than
 * the window, which is what makes it safe to run from a listing: a process still
 * writing has a fresh entry, and the newest directory is never a candidate no
 * matter what its clock claims. `retentionDays <= 0` keeps everything, the safe
 * reading of a mis-set environment variable.
 */
export async function pruneRunDirs(
  io: TaskLogIo,
  root: string,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ deleted: string[]; kept: number }> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const deleted: string[] = [];
  if (retentionDays <= 0) return { deleted, kept: 0 };
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = nowMs - retentionDays * 86_400_000;

  const dirs = await runDirs(io, root);
  let kept = 0;
  // `runDirs` is newest-first, and the newest is never pruned: that is whichever
  // process is running now or was most recent, whatever its clock says.
  for (const name of dirs.slice(1)) {
    const dir = `${root}/${name}`;
    const entries = await io.list(dir);
    if (!entries) {
      kept++;
      continue;
    }
    let newest = 0;
    let statable = 0;
    for (const entry of entries) {
      const info = await guardedStat(io, root, `${dir}/${entry.name}`);
      if (info) {
        statable++;
        newest = Math.max(newest, info.mtimeMs);
      }
    }
    if (!statable) {
      // Nothing inside could be judged: entries that are links to outside the root
      // stay this directory's business but not ours to age by, so the directory's
      // own clock decides — which also means a directory that is simply empty
      // ages out instead of living forever.
      const self = await guardedStat(io, root, dir);
      newest = self ? self.mtimeMs : 0;
    }
    if (!newest || newest >= cutoff) {
      kept++;
      continue;
    }
    await io.removeDir(dir);
    deleted.push(name);
  }
  return { deleted, kept: kept + Math.min(dirs.length, 1) };
}

/**
 * The listing: every run directory under the root, newest activity first.
 *
 * Recency comes from the file's own mtime, so unlike the Claude listing every
 * candidate need not be read before the sort — only the ones a page actually
 * shows are opened. A pair whose start block does not parse is skipped: the root
 * also holds bash, monitor, workflow and exec logs, and a phantom run row is
 * worse than a missing one. Retention runs here, so the pane is self-limiting
 * without a scheduler.
 */
export async function listTaskRuns(
  io: TaskLogIo,
  root: string,
  options: {
    now?: Date;
    limit?: number;
    cursor?: number;
    retentionDays?: number;
  } = {},
): Promise<TaskRunList> {
  const now = options.now ?? new Date();
  await pruneRunDirs(io, root, { now, retentionDays: options.retentionDays });

  const candidates = await collectCandidates(io, root);
  candidates.sort((a, b) => b.activityMs - a.activityMs || b.taskId.localeCompare(a.taskId));

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25) || 1, 1), 100);
  const cursor = Math.max(Math.trunc(options.cursor ?? 0) || 0, 0);
  const runs: TaskRunSummary[] = [];
  let consumed = cursor;
  for (; consumed < candidates.length && runs.length < limit; consumed++) {
    if (consumed - cursor >= MAX_PARSE_ATTEMPTS) break;
    const candidate = candidates[consumed];
    if (!candidate) break;
    const summary = await summarizeCandidate(io, candidate, now);
    if (summary) runs.push(summary);
  }
  return {
    runs,
    next: consumed < candidates.length ? consumed : null,
    has_more: consumed < candidates.length,
  };
}

async function summarizeCandidate(
  io: TaskLogIo,
  candidate: Candidate,
  now: Date,
): Promise<TaskRunSummary | null> {
  const start = await readStartBlock(io, candidate.logPath);
  if (!start) return null;
  const last = candidate.eventsPath ? await lastEventFact(io, candidate.eventsPath) : {};
  const startedAt = candidate.eventsPath ? await firstEventTime(io, candidate.eventsPath) : null;
  const lastActivityAt =
    last.at ?? (candidate.activityMs ? new Date(candidate.activityMs).toISOString() : null);
  return {
    taskId: candidate.taskId,
    kind: taskRunKindOf(start.subagentType),
    subagentType: start.subagentType,
    description: start.description,
    runDir: candidate.runDir,
    startedAt,
    lastActivityAt,
    bytes: candidate.bytes,
    events: last.seq ?? null,
    status: await statusOf(io, candidate, now),
  };
}

/**
 * What the files prove about how the run ended.
 *
 * Upstream writes a closing line into the readable log — `[Task completed]` or
 * `[Task failed]` (`task-transcript.ts:71,77`) — so that line, from a bounded
 * tail read, is the only proof of an ending there is. Without it a run that is
 * still writing is running and a run that stopped writing is **stopped**: calling
 * that "completed" would tell the operator a crashed or killed run succeeded,
 * which is a claim the file never makes.
 */
async function statusOf(io: TaskLogIo, candidate: Candidate, now: Date): Promise<TaskRunStatus> {
  const tail = await io.readTail(candidate.logPath, LOG_TAIL_BYTES);
  if (tail) {
    // Upstream closes a finished run with its own line — `[Task completed]` or
    // `[Task failed]` — as the file's last line. Matched exactly and only there:
    // a run that quoted the marker in its own output (reading a transcript, catting
    // a task log) then died would otherwise be labelled completed, which is the
    // exact lie this read exists to avoid.
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const line = raw.trim();
      if (!line) continue;
      if (line === "[Task completed]") return "completed";
      if (line === "[Task failed]") return "failed";
      break;
    }
  }
  if (!candidate.activityMs) return "stopped";
  const idleMs = now.getTime() - candidate.activityMs;
  if (idleMs >= 0 && idleMs <= RUNNING_WINDOW_MS) return "running";
  return "stopped";
}

/**
 * One page of a run's transcript, by line offset.
 *
 * The records come back exactly as upstream wrote them — the `[truncated N
 * bytes]` marker inside a tool result, the `events_missed` record, the
 * `event_log_full` status — because their meaning is upstream's and the viewer
 * renders them rather than reinterpreting them. A line that is not JSON is
 * counted (the cursor is lines, not events) and dropped, which is what a run
 * still mid-append looks like at the end of the file.
 *
 * Null when no such run exists — in that directory, at all — or when its id is
 * not a task id at all; the route turns that into a 404, and nothing about an
 * arbitrary string reaches the filesystem.
 */
export async function readTaskRunEvents(
  io: TaskLogIo,
  root: string,
  taskId: string,
  options: { after?: number; limit?: number; runDir?: string } = {},
): Promise<TaskRunEventsPage | null> {
  if (!isTaskId(taskId)) return null;
  if (options.runDir !== undefined && !isRunDir(options.runDir)) return null;
  const pair = await locatePair(io, root, taskId, options.runDir);
  if (!pair.runDir || (!pair.logPath && !pair.eventsPath)) return null;

  const after = Math.max(Math.trunc(options.after ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200) || 1, 1), 1_000);
  const window = pair.eventsPath
    ? await io.readLineWindow(pair.eventsPath, after, limit, MAX_PAGE_BYTES)
    : { lines: [], nextLines: after, hasMore: false };

  const events: Record<string, unknown>[] = [];
  for (const line of window.lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    events.push(record as Record<string, unknown>);
  }
  return {
    taskId,
    runDir: pair.runDir,
    events,
    next: window.nextLines,
    has_more: window.hasMore,
  };
}

/** `TASK_LOG_RETENTION_DAYS`, read the way a number read from an env should be:
 * a bad value falls back rather than deleting everything. */
export function parseRetentionDays(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_RETENTION_DAYS;
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS;
  return Math.trunc(days);
}

/**
 * The two deps the routes need, with the defaults in one place so `index.ts`
 * says only what the deployment changed.
 */
export interface TaskLogStore {
  root: string;
  list(options?: { limit?: number; cursor?: number; now?: Date }): Promise<TaskRunList>;
  events(
    taskId: string,
    options?: { after?: number; limit?: number; runDir?: string },
  ): Promise<TaskRunEventsPage | null>;
}

export function createTaskLogStore(
  options: { root?: string; io?: TaskLogIo; retentionDays?: number; now?: () => Date } = {},
): TaskLogStore {
  const io = options.io ?? fsTaskLogIo;
  // A blank is not a root: `normalizePosixPath("")` is `/`, and `/` is a root in
  // which every path is inside. Compose sets the literal; a bare `TASK_LOG_DIR=`
  // in someone's `.env` means "the default", not "the filesystem".
  const root = normalizePosixPath(
    options.root?.trim() || process.env.TASK_LOG_DIR?.trim() || TASK_LOG_ROOT_DEFAULT,
  );
  const retentionDays =
    options.retentionDays ?? parseRetentionDays(process.env.TASK_LOG_RETENTION_DAYS);
  const now = options.now ?? (() => new Date());
  return {
    root,
    list: (listOptions = {}) =>
      listTaskRuns(io, root, {
        limit: listOptions.limit,
        cursor: listOptions.cursor,
        retentionDays,
        now: listOptions.now ?? now(),
      }),
    events: (taskId, eventOptions = {}) => readTaskRunEvents(io, root, taskId, eventOptions),
  };
}
