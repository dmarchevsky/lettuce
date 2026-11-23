/**
 * Durable subagent run transcripts — the Runs pane's file-backed list.
 *
 * Upstream keeps a *running* task's events in process memory (a per-task buffer
 * read back with `read_subagent_events`) and that dies with the app-server. The
 * durable record is the file beside it: every event is appended to
 * `<task_id>.jsonl` next to the task's readable `<task_id>.log`, in the
 * background-output dir, which `LETTA_SCRATCHPAD` pins to
 * `$LETTA_STATE_DIR/task-logs` — the same absolute path in the app-server (rw,
 * it writes) and in this container (rw, for the sweep and the retention prune
 * alone). See `docker/compose.yml` and letta-code `src/tools/impl/task-transcript.ts`.
 *
 * Two upstream facts set the shape of everything here.
 *
 *  - **Ids are reused across boots.** `getNextTaskId()` counts up from `task_1`
 *    in every process, `createBackgroundOutputFile` *truncates* `<id>.log` on
 *    create, and the events log opens in append mode — so a second boot would
 *    otherwise write a new run into a dead run's transcript. `sweepTaskLogs`
 *    moves a generation's pairs into `archive/<stamp>` once, on connect, before
 *    any launch can land in the new process. That is what makes a transcript's
 *    identity *generation + name*, which is ours to maintain, not upstream's.
 *  - **One directory, many writers.** `createBackgroundOutputFile` has nine call
 *    sites — bash, monitor, workflow, exec, watch-pr — so a file sitting there
 *    that is not a task is normal. Anything whose start block does not parse is
 *    skipped, never an error, which is why the listing reads the start block
 *    rather than trusting the name.
 *
 * Nothing here goes upstream and nothing needs the socket: the files are local
 * to this container, so the list answers while the app-server is down, which is
 * exactly when the history matters. Two verbs touch the tree — the sweep's move
 * and retention's delete — and both operate only on names inside their own root
 * after the guard chain below has proved it (`files/delete.ts` is the shape).
 *
 * The file sizes are upstream's ceiling, not ours: a single run's event log may
 * reach 256 MiB (`TASK_EVENTS_MAX_BYTES`), so nothing here reads a whole file.
 * The listing reads a bounded head and tail, and the page reader stops as soon
 * as the page is full.
 */

import { lstatSync, realpathSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { normalizePosixPath } from "../session/protocol.ts";
import { symlinkViolation } from "../session/symlink-guard.ts";

/** Where the app-server writes its task logs. `LETTA_SCRATCHPAD`, same path. */
export const TASK_LOG_ROOT_DEFAULT = "/var/lettuce/task-logs";

/** How long an archived generation is kept, absent `TASK_LOG_RETENTION_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 14;

/** Sub-directory of the root holding past generations, one dir per boot. */
export const ARCHIVE_DIR = "archive";

/** `<task_id>.log` / `<task_id>.jsonl`. Upstream's ids are `task_<n>`, digits only. */
const TASK_ID_RE = /^task_[0-9A-Za-z_-]{1,40}$/;
/** The base name of a file the sweep is allowed to move. */
const TASK_FILE_RE = /^task_[0-9A-Za-z_-]{1,40}\.(?:log|jsonl)$/;
/** An archive dir name this module wrote (`generationStamp`), and can therefore date. */
const GENERATION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
/** `[Task started: …]` then `[subagent_type: …]` — `writeTaskTranscriptStart`. */
const START_BLOCK_RE = /^\[Task started: ([\s\S]*?)\]\n\[subagent_type: ([^\]\n]*)\]/;

/** How much of the readable log the start block could possibly need. */
const START_BLOCK_BYTES = 4_096;
/** How much of the events tail one read covers — enough for the last record. */
const TAIL_BYTES = 64 * 1024;
/** Read granularity of the page reader. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Ceiling on one events page's payload, so a page costs a page, not the run. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** A file touched this recently is still producing events, so the run is live. */
const RUNNING_WINDOW_MS = 5 * 60 * 1000;
/** Candidates considered per listing, newest first — the archive is unbounded. */
const MAX_CANDIDATES = 500;
/** Start blocks read per page, on top of `limit`, so one page stays one page. */
const MAX_PARSE_ATTEMPTS = 400;

export type TaskRunKind = "codex" | "claude-code" | "subagent";
export type TaskRunStatus = "running" | "completed" | "unknown";

/** What the Runs row states: what the file proves, not what the process knew. */
export interface TaskRunSummary {
  taskId: string;
  kind: TaskRunKind;
  /** The transcript's own `[subagent_type: …]`, verbatim, for the row's label. */
  subagentType: string | null;
  /** The launch prompt's description from the start block; null if unreadable. */
  description: string | null;
  /** Archive dir the pair lives in, or null when it is the current generation. */
  generation: string | null;
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
  generation: string | null;
  /** Upstream's own records (`seq`, `at`, `type`, and its fields), untouched. */
  events: Record<string, unknown>[];
  /** Line offset of the first event not returned — pass it back as `after`. */
  next: number;
  has_more: boolean;
}

export interface SweepResult {
  /** The generation dir the files went to, or null when there was nothing to move. */
  generation: string | null;
  moved: string[];
  /** Names left in the root on purpose (a link, or a name already archived). */
  skipped: string[];
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
 * sweep's ordering and the page arithmetic are all testable against a fixture
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
  move(from: string, to: string): Promise<void>;
  makeDir(dir: string): Promise<void>;
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

  move: (from, to) => rename(from, to),
  makeDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  removeDir: async (dir) => {
    await rm(dir, { recursive: true, force: false });
  },
  realpath: (path) => realpathSync(path),
  lstat: (path) => lstatSync(path),
};

/**
 * Whole lines only, from a `FileHandle`, with the window bounded twice over.
 *
 * `after` counts lines already shown, so skipping them costs a scan of the bytes
 * before them — cheap for the runs this pane is about (a task's own events, a
 * few MB), and the reason a page is a page: the reader returns the moment the
 * window is full instead of walking the file. A trailing partial line (a run
 * still appending) is left for the next read rather than parsed as an event.
 */
async function readWholeLines(
  handle: FileHandle,
  after: number,
  limit: number,
  maxBytes: number,
): Promise<LineWindow> {
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let offset = 0;
  let pending = "";
  let lineIndex = 0;
  let collected = 0;
  let usedBytes = 0;
  let nextLines = after;
  const lines: string[] = [];

  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, offset);
    offset += bytesRead;
    const eof = bytesRead === 0;
    const text = pending + decoder.decode(buffer.subarray(0, bytesRead), { stream: !eof });
    const pieces = text.split("\n");
    // The last piece has no newline yet: either the rest of this chunk will
    // complete it, or at EOF it is a line the writer has not finished.
    pending = pieces.pop() ?? "";
    let stopAt = -1;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? "";
      lineIndex++;
      if (lineIndex <= after) continue;
      if (collected >= limit || (collected > 0 && usedBytes + piece.length > maxBytes)) {
        stopAt = i;
        break;
      }
      lines.push(piece);
      collected++;
      usedBytes += piece.length;
      nextLines = lineIndex;
    }
    if (stopAt >= 0) {
      // The line that tripped the limit was not delivered, so there is more —
      // unless everything left in hand is blank, in which case one more read
      // decides it, and that is the only extra read the answer costs.
      const blankAhead = pieces.slice(stopAt).some((piece) => piece.length > 0);
      if (blankAhead || eof) return { lines, nextLines, hasMore: blankAhead };
      const probe = await handle.read(buffer, 0, 1, offset);
      return { lines, nextLines, hasMore: probe.bytesRead > 0 };
    }
    if (eof) {
      return { lines, nextLines: lineIndex, hasMore: false };
    }
  }
}

/** A name this module will accept as a task id — no traversal, no separators. */
export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value);
}

/** `2026-11-21T14-03-22Z` — filename-safe, sortable, and reversible. */
export function generationStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[:]/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
}

/** The instant a generation stamp names, or null when it names none. */
export function parseGenerationStamp(stamp: string): number | null {
  if (!GENERATION_RE.test(stamp)) return null;
  const iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
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
 * usable on a path that does not exist yet (the sweep's target directory).
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

/** The archive's generation dirs, newest first, names this module can date. */
async function generationDirs(io: TaskLogIo, root: string): Promise<string[]> {
  const entries = await io.list(`${root}/${ARCHIVE_DIR}`);
  if (!entries) return [];
  return entries
    .filter((entry) => entry.kind === "dir" && GENERATION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
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
 * The directory is guarded once (it is the same proof for both files), then each
 * half is stat-guarded. A `.jsonl` half that does not exist is not a refusal — a
 * task whose event log could not be opened has a readable log and nothing else.
 */
async function statPair(
  io: TaskLogIo,
  root: string,
  dir: string,
  taskId: string,
): Promise<Pair | null> {
  if (dirViolation(io, root, dir)) return null;
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
  generation: string | null;
  logPath: string;
  eventsPath: string | null;
  /** Newest mtime of the pair, which is what "recently ran" means here. */
  activityMs: number;
  bytes: number;
}

/**
 * Every `task_*` pair the pane can offer, newest dirs first and capped.
 *
 * Only the pair's facts (mtime, size) are collected here; the start block is read
 * later, for the candidates a page actually shows. The walk starts at the root
 * and then walks the archive newest-first, so hitting the cap drops the oldest
 * generations rather than a scatter of them.
 */
async function collectCandidates(io: TaskLogIo, root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const generations = await generationDirs(io, root);
  const dirs: { generation: string | null; dir: string }[] = [
    { generation: null, dir: root },
    ...generations.map((stamp) => ({
      generation: stamp,
      dir: `${root}/${ARCHIVE_DIR}/${stamp}`,
    })),
  ];
  for (const { generation, dir } of dirs) {
    const entries = await io.list(dir);
    if (!entries) continue;
    for (const entry of entries) {
      // The readable log is the marker: it carries the start block, and a
      // `.jsonl` without one has nothing to show.
      if (entry.kind !== "file" || !entry.name.endsWith(".log")) continue;
      const taskId = entry.name.slice(0, -".log".length);
      if (!isTaskId(taskId)) continue;
      const pair = await statPair(io, root, dir, taskId);
      // No readable log means no start block means nothing to say about it.
      if (!pair?.logPath) continue;
      candidates.push({
        taskId,
        generation,
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
 * Both halves of one run's files, wherever they are, newest generation first.
 *
 * The id arrives from a URL, so nothing is derived from it until it matches the
 * grammar `isTaskId` states. The root is searched first: a live run's pair is
 * always in the root, and an archived id is unique because the sweep moved it
 * there exactly once.
 */
async function locatePair(
  io: TaskLogIo,
  root: string,
  taskId: string,
  generations: string[],
): Promise<{ generation: string | null } & Pair> {
  const dirs = [null, ...generations];
  for (const generation of dirs) {
    const dir = generation === null ? root : `${root}/${ARCHIVE_DIR}/${generation}`;
    const pair = await statPair(io, root, dir, taskId);
    if (pair) return { generation, ...pair };
  }
  return { generation: null, logPath: null, eventsPath: null, logStat: null, eventsStat: null };
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
  const head = await io.readHead(eventsPath, START_BLOCK_BYTES);
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
  const tail = await io.readTail(eventsPath, TAIL_BYTES);
  if (!tail) return {};
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
  return {};
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
 * Move the previous generation's task pairs out of the root, once.
 *
 * Without this, a new app-server process truncates `task_1.log` and appends its
 * events to the dead run's `task_1.jsonl` (the counter restarts at 1 and the
 * events log opens in append mode), so two runs share one transcript. It is
 * idempotent — a second pass finds no `task_*` pairs in the root and creates no
 * directory — and it moves only names matching `task_*` that it can prove are
 * inside its own root.
 *
 * A file a run is still writing is moved safely: a rename keeps the appender's
 * file descriptor on the same inode, so the transcript follows it into the
 * archive and still reads as one run. That is what makes running this on every
 * connect, app-server restart or not, harmless.
 */
export async function sweepTaskLogs(
  io: TaskLogIo,
  root: string,
  options: { now?: () => Date; generation?: string } = {},
): Promise<SweepResult> {
  const entries = await io.list(root);
  if (!entries) return { generation: null, moved: [], skipped: [] };

  const names: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (!TASK_FILE_RE.test(entry.name)) continue;
    if (entry.kind !== "file") {
      // A directory or a symlink wearing a task name is not this module's to move.
      skipped.push(entry.name);
      continue;
    }
    if (!(await guardedStat(io, root, `${root}/${entry.name}`))) {
      skipped.push(entry.name);
      continue;
    }
    names.push(entry.name);
  }
  if (names.length === 0) return { generation: null, moved: [], skipped };

  const generation = options.generation ?? generationStamp((options.now ?? (() => new Date()))());
  if (!GENERATION_RE.test(generation)) {
    throw new Error(`Not a generation name: ${generation}`);
  }
  const dir = `${root}/${ARCHIVE_DIR}/${generation}`;
  // Guarded without `realpath`, because the directory is about to be created:
  // the name is fully constrained above, so the only things left to refuse are a
  // traversal in the root itself and a link standing where the archive goes.
  if (lexicalViolation(root, dir) ?? linkViolation(io, root, dir)) {
    throw new Error(`Refusing to sweep into ${dir}: it is not inside ${root}`);
  }
  await io.makeDir(dir);

  const moved: string[] = [];
  for (const name of names) {
    const from = `${root}/${name}`;
    const to = `${dir}/${name}`;
    if (await io.stat(to)) {
      // Same name already archived — a re-sweep inside one second. Overwriting
      // would lose the older transcript, so leave the new one in the root.
      skipped.push(name);
      continue;
    }
    await io.move(from, to);
    moved.push(name);
  }
  return { generation, moved, skipped };
}

/**
 * Drop archived generations older than the retention window.
 *
 * This is the only delete in this file, and it only ever removes a
 * `archive/<generation>` directory whose name it can date. A directory it cannot
 * date is left alone — an unparseable name is not evidence of being old.
 * `retentionDays <= 0` keeps everything, which is the safe reading of a
 * mis-set environment variable.
 */
export async function pruneArchive(
  io: TaskLogIo,
  root: string,
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ deleted: string[]; kept: number }> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const deleted: string[] = [];
  if (retentionDays <= 0) return { deleted, kept: 0 };
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = nowMs - retentionDays * 86_400_000;
  const dirs = await generationDirs(io, root);
  let kept = 0;
  for (const stamp of dirs) {
    const at = parseGenerationStamp(stamp);
    if (at === null || at >= cutoff) {
      kept++;
      continue;
    }
    const path = `${root}/${ARCHIVE_DIR}/${stamp}`;
    if (dirViolation(io, root, path)) {
      kept++;
      continue;
    }
    await io.removeDir(path);
    deleted.push(stamp);
  }
  return { deleted, kept };
}

/**
 * The listing: the root plus the archive, newest activity first.
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
  await pruneArchive(io, root, { now, retentionDays: options.retentionDays });

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
    generation: candidate.generation,
    startedAt,
    lastActivityAt,
    bytes: candidate.bytes,
    events: last.seq ?? null,
    status: statusOf(candidate.activityMs, now),
  };
}

function statusOf(activityMs: number, now: Date): TaskRunStatus {
  if (!activityMs) return "unknown";
  const idleMs = now.getTime() - activityMs;
  if (idleMs < 0) return "unknown";
  return idleMs <= RUNNING_WINDOW_MS ? "running" : "completed";
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
 * Null when no such run exists in the root or the archive, or when its id is not
 * a task id at all — the route turns that into a 404, and nothing about an
 * arbitrary string reaches the filesystem.
 */
export async function readTaskRunEvents(
  io: TaskLogIo,
  root: string,
  taskId: string,
  options: { after?: number; limit?: number } = {},
): Promise<TaskRunEventsPage | null> {
  if (!isTaskId(taskId)) return null;
  const generations = await generationDirs(io, root);
  const pair = await locatePair(io, root, taskId, generations);
  if (!pair.logPath && !pair.eventsPath) return null;

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
    generation: pair.generation,
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
    options?: { after?: number; limit?: number },
  ): Promise<TaskRunEventsPage | null>;
  sweep(): Promise<SweepResult>;
}

export function createTaskLogStore(
  options: { root?: string; io?: TaskLogIo; retentionDays?: number; now?: () => Date } = {},
): TaskLogStore {
  const io = options.io ?? fsTaskLogIo;
  const root = normalizePosixPath(
    options.root ?? process.env.TASK_LOG_DIR ?? TASK_LOG_ROOT_DEFAULT,
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
    sweep: () => sweepTaskLogs(io, root, { now }),
  };
}
