import { expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { RouteEnv } from "../route-env.ts";
import {
  createTaskLogStore,
  DEFAULT_RETENTION_DAYS,
  fsTaskLogIo,
  isRunDir,
  isTaskId,
  listTaskRuns,
  parseRetentionDays,
  pruneRunDirs,
  readTaskRunEvents,
} from "./task-logs.ts";
import { registerTaskRunRoutes } from "./task-routes.ts";

/**
 * These tests drive the real `fsTaskLogIo` against a scratch directory, because
 * the things most likely to be wrong here — mtime order, a symlink that points out
 * of the root, a run directory that is not upstream's shape, and a pair whose two
 * halves disagree — cannot be faked without faking away the assertion.
 *
 * The layout is upstream's: one directory per process (`mkdtemp` under `TMPDIR`),
 * and inside it `<task_id>.log` beside `<task_id>.jsonl`. A task id is unique only
 * within its directory, so most fixtures sit in one directory and the collision
 * tests use two.
 */

/** Upstream's `mkdtemp` name: six characters, and that is the whole grammar. */
const RUN_A = "letta-background-aaaaaa";
const RUN_B = "letta-background-bbbbbb";

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "lettuce-task-logs-"));
}

/** `[Task started: …]` + `[subagent_type: …]`, exactly as upstream writes them. */
function startBlock(description: string, subagentType: string): string {
  return `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n\n`;
}

/** The closing line upstream appends after the report — the only proof of an ending. */
const COMPLETED = "[Task completed]\n";
const FAILED = "[error] it blew up\n\n[Task failed]\n";

function record(seq: number, at: string, event: Record<string, unknown>): string {
  return `${JSON.stringify({ seq, at, ...event })}\n`;
}

function writePair(
  root: string,
  taskId: string,
  options: {
    description?: string | null;
    subagentType?: string;
    events?: string;
    /** Written verbatim instead of as a start block — the junk case. */
    raw?: string;
    mtimeSeconds?: number;
    /** The process directory; a fixture that cares passes two of them. */
    runDir?: string;
    /** Appends upstream's `[Task completed]` / `[Task failed]` line. */
    closing?: string | null;
  } = {},
): string {
  const dir = join(root, options.runDir ?? RUN_A);
  mkdirSync(dir, { recursive: true });
  const body =
    (options.raw ??
      startBlock(
        options.description ?? "Summarize the changelog",
        options.subagentType ?? "general-purpose",
      )) + (options.closing ?? "");
  writeFileSync(join(dir, `${taskId}.log`), body);
  if (options.events !== undefined) writeFileSync(join(dir, `${taskId}.jsonl`), options.events);
  if (options.mtimeSeconds !== undefined) {
    const at = options.mtimeSeconds;
    utimesSync(join(dir, `${taskId}.log`), at, at);
    try {
      utimesSync(join(dir, `${taskId}.jsonl`), at, at);
    } catch {
      // no event half to age
    }
  }
  return dir;
}

/** Age a whole run directory, so retention sees a boot from before the window. */
function ageDir(dir: string, secondsAgo: number): void {
  utimesSync(dir, secondsAgo, secondsAgo);
}

const NOW = new Date("2026-11-21T12:00:00.000Z");
const DAY = 86_400_000;

test("the listing reads the start block, orders by mtime, and skips what is not a task", async () => {
  const root = scratchRoot();
  // Older, so it sorts second; its event half is older too, so `bytes` sums both.
  writePair(root, "task_1", {
    description: "Fix the failing math test",
    subagentType: "general-purpose",
    events: record(1, "2026-11-20T10:00:00.000Z", { type: "text", text: "on it" }),
    closing: COMPLETED,
    mtimeSeconds: (NOW.getTime() - 2 * DAY) / 1000,
  });
  writePair(root, "task_2", {
    description: "Write the release notes",
    subagentType: "claude-code",
    events: record(1, "2026-11-21T11:58:00.000Z", { type: "text", text: "done" }),
    mtimeSeconds: (NOW.getTime() - 60_000) / 1000,
  });
  // The nine other call sites of `createBackgroundOutputFile`: names this module
  // must not turn into phantom runs, and one task-named file with no start block.
  writePair(root, "bash_1", { raw: "command output\n" });
  writePair(root, "task_3", { raw: "" });
  writePair(root, "task_4", { raw: "monitor output, no start block\n" });
  // A `.jsonl` with no `.log` has no start block to read, so it is not a row.
  writeFileSync(
    join(root, RUN_A, "task_5.jsonl"),
    record(1, "2026-11-21T11:00:00.000Z", { type: "text", text: "x" }),
  );
  // A directory that is not upstream's shape is not a run: not listed, not read.
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "task_9.log"), startBlock("Not a run", "general-purpose"));

  const list = await listTaskRuns(fsTaskLogIo, root, {
    now: NOW,
    retentionDays: DEFAULT_RETENTION_DAYS,
  });

  expect(list.runs.map((run) => run.taskId)).toEqual(["task_2", "task_1"]);
  const [second, first] = list.runs;
  expect(first?.description).toBe("Fix the failing math test");
  expect(first?.subagentType).toBe("general-purpose");
  expect(first?.kind).toBe("subagent");
  expect(first?.runDir).toBe(RUN_A);
  expect(first?.startedAt).toBe("2026-11-20T10:00:00.000Z");
  expect(first?.events).toBe(1);
  expect(first?.bytes).toBeGreaterThan(0);
  // Touched a minute before `now`, so the row may say the run is live; the older
  // one closed itself with upstream's own line, so it may say completed.
  expect(second?.status).toBe("running");
  expect(first?.status).toBe("completed");
  expect(list.runs.map((run) => run.kind)).toContain("claude-code");
  expect(list.next).toBeNull();
  expect(list.has_more).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("a run whose log only stopped is stopped, and a failed one is failed", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "Crashed",
    closing: FAILED,
    mtimeSeconds: (NOW.getTime() - 2 * DAY) / 1000,
  });
  writePair(root, "task_2", {
    description: "Killed mid-run",
    mtimeSeconds: (NOW.getTime() - 2 * DAY) / 1000,
  });

  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  const byTask = Object.fromEntries(list.runs.map((run) => [run.taskId, run.status]));
  expect(byTask.task_1).toBe("failed");
  // No closing line is not a completion: the file stopped writing, and that is
  // all it proves. Calling this "completed" is the lie the whole function exists
  // to avoid.
  expect(byTask.task_2).toBe("stopped");
  rmSync(root, { recursive: true, force: true });
});

test("two same-named runs in two directories are two rows, each with its own transcript", async () => {
  const root = scratchRoot();
  // The collision the per-process directory exists to make impossible: upstream
  // counts from `task_1` in every process, so a parent and a nested subagent (or
  // two boots) both own the name. In separate directories that is harmless.
  writePair(root, "task_1", {
    description: "Parent",
    runDir: RUN_A,
    events: record(1, "2026-11-21T10:00:00.000Z", { type: "text", text: "parent" }),
    closing: COMPLETED,
    mtimeSeconds: (NOW.getTime() - 60_000) / 1000,
  });
  writePair(root, "task_1", {
    description: "Nested",
    runDir: RUN_B,
    events: record(1, "2026-11-21T10:30:00.000Z", { type: "text", text: "nested" }),
    mtimeSeconds: (NOW.getTime() - 30_000) / 1000,
  });

  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs.map((run) => `${run.runDir}/${run.taskId}`)).toEqual([
    `${RUN_B}/task_1`,
    `${RUN_A}/task_1`,
  ]);
  expect(list.runs.map((run) => run.description)).toEqual(["Nested", "Parent"]);

  // Each row names its own directory, and reading one never opens the other.
  const nested = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { runDir: RUN_B });
  expect(nested?.runDir).toBe(RUN_B);
  expect((nested?.events[0] as { text?: string })?.text).toBe("nested");
  const parent = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { runDir: RUN_A });
  expect(parent?.runDir).toBe(RUN_A);
  expect((parent?.events[0] as { text?: string })?.text).toBe("parent");
  // Without a directory named, the newest one holding the id answers — the row the
  // operator sees first, never an arbitrary one.
  const newest = await readTaskRunEvents(fsTaskLogIo, root, "task_1");
  expect(newest?.runDir).toBe(RUN_B);
  rmSync(root, { recursive: true, force: true });
});

test("a page is a page: the cursor walks candidates, junk costs a read not a row", async () => {
  const root = scratchRoot();
  for (const [taskId, at] of [
    ["task_1", NOW.getTime() - 3 * DAY],
    ["task_2", NOW.getTime() - 2 * DAY],
    ["task_3", NOW.getTime() - 1 * DAY],
  ] as const) {
    writePair(root, taskId, { description: `Run ${taskId}`, mtimeSeconds: at / 1000 });
  }
  writePair(root, "task_9", { raw: "not a task\n", mtimeSeconds: (NOW.getTime() - 90_000) / 1000 });

  const page = await listTaskRuns(fsTaskLogIo, root, { now: NOW, limit: 2 });
  expect(page.runs.map((run) => run.taskId)).toEqual(["task_3", "task_2"]);
  expect(page.has_more).toBe(true);
  expect(typeof page.next).toBe("number");

  const next = await listTaskRuns(fsTaskLogIo, root, {
    now: NOW,
    limit: 2,
    cursor: page.next ?? 0,
  });
  expect(next.runs.map((run) => run.taskId)).toEqual(["task_1"]);
  expect(next.has_more).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("an absent root is an empty list, not a throw", async () => {
  const list = await listTaskRuns(fsTaskLogIo, "/nonexistent/lettuce-task-logs", { now: NOW });
  expect(list).toEqual({ runs: [], next: null, has_more: false });
});

test("events page by line offset, and upstream's own markers come back untouched", async () => {
  const root = scratchRoot();
  const big = `build output line\n[truncated 987654 bytes]`;
  const events =
    record(1, "2026-11-21T10:00:00.000Z", { type: "text", text: "starting" }) +
    record(2, "2026-11-21T10:00:01.000Z", {
      type: "tool_call",
      id: "call_1",
      name: "Bash",
      input: { command: "bun test" },
    }) +
    record(3, "2026-11-21T10:00:09.000Z", {
      type: "tool_result",
      tool_call_id: "call_1",
      name: "Bash",
      is_error: true,
      output: big,
    }) +
    record(4, "2026-11-21T10:00:10.000Z", { type: "events_missed", missed: 42 }) +
    record(5, "2026-11-21T10:00:11.000Z", { type: "reasoning", text: "hmm" });
  writePair(root, "task_1", { description: "Run the suite", events });

  const first = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 2 });
  expect(first?.events.map((event) => event.seq)).toEqual([1, 2]);
  expect(first?.next).toBe(2);
  expect(first?.has_more).toBe(true);

  const rest = await readTaskRunEvents(fsTaskLogIo, root, "task_1", {
    after: first?.next ?? 0,
    limit: 10,
  });
  expect(rest?.events.map((event) => event.seq)).toEqual([3, 4, 5]);
  expect(rest?.has_more).toBe(false);
  expect(rest?.next).toBe(5);

  const toolResult = rest?.events.find((event) => event.type === "tool_result");
  // The truncation marker is upstream's sentence inside the output, not a fact
  // to reinterpret: it arrives verbatim, `is_error` included.
  expect(toolResult?.output).toBe(big);
  expect(toolResult?.is_error).toBe(true);
  const missed = rest?.events.find((event) => event.type === "events_missed");
  expect(missed).toMatchObject({ seq: 4, missed: 42 });
  rmSync(root, { recursive: true, force: true });
});

test("a line the writer has not finished is left for the next read", async () => {
  const root = scratchRoot();
  const events = record(1, "2026-11-21T10:00:00.000Z", { type: "text", text: "one" });
  writePair(root, "task_1", { description: "Live run", events });
  const live = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 10 });
  expect(live?.events).toHaveLength(1);
  expect(live?.has_more).toBe(false);

  // The run appends: one more whole record, then a half-written one.
  appendFileSync(
    join(root, RUN_A, "task_1.jsonl"),
    record(2, "2026-11-21T10:00:02.000Z", { type: "text", text: "two" }),
  );
  appendFileSync(join(root, RUN_A, "task_1.jsonl"), `{"seq":3,"at":"2026-11-2`);
  const grown = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 10 });
  expect(grown?.events.map((event) => event.seq)).toEqual([1, 2]);
  expect(grown?.has_more).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("retention deletes an aged run directory and never the newest one", async () => {
  const root = scratchRoot();
  const aged = (NOW.getTime() - 30 * DAY) / 1000;
  const old = writePair(root, "task_1", { description: "Old boot", mtimeSeconds: aged });
  ageDir(old, aged);
  // The newest directory is never touched even when its own entries are old: it
  // is whichever process is running now or was most recent, and that is what its
  // place in the listing says.
  const fresh = writePair(root, "task_1", {
    description: "This boot",
    runDir: RUN_B,
    mtimeSeconds: aged,
  });
  // A directory that is not upstream's shape is nobody's to delete, however old.
  const stranger = join(root, "notes");
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, "keep.txt"), "mine\n");
  ageDir(stranger, (NOW.getTime() - 90 * DAY) / 1000);

  const pruned = await pruneRunDirs(fsTaskLogIo, root, { now: NOW, retentionDays: 14 });
  expect(pruned.deleted).toEqual([RUN_A]);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(join(stranger, "keep.txt"))).toBe(true);

  // Zero keeps everything: a mis-set TASK_LOG_RETENTION_DAYS must not empty the tree.
  expect((await pruneRunDirs(fsTaskLogIo, root, { now: NOW, retentionDays: 0 })).deleted).toEqual(
    [],
  );
  rmSync(root, { recursive: true, force: true });
});

test("listing runs retention, so the pane is self-limiting without a scheduler", async () => {
  const root = scratchRoot();
  // A run directory aged past the window, with its files aged too: retention
  // reads the newest entry inside, which is the only fact that says nobody is
  // still writing there.
  const aged = (NOW.getTime() - 40 * DAY) / 1000;
  const old = writePair(root, "task_1", { description: "Old boot", mtimeSeconds: aged });
  ageDir(old, aged);
  writePair(root, "task_2", { description: "Now", runDir: RUN_B });

  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW, retentionDays: 14 });
  expect(existsSync(old)).toBe(false);
  expect(list.runs.map((run) => run.taskId)).toEqual(["task_2"]);
  rmSync(root, { recursive: true, force: true });
});

test("no id reaches the filesystem that is not a task id, and no link is followed out", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "Fine",
    events: record(1, "2026-11-21T10:00:00.000Z", { type: "text", text: "x" }),
  });
  for (const bad of [
    "..",
    "../etc/passwd",
    "task_1/../../etc/passwd",
    "task_1.log",
    "",
    "bash_1",
    "task_1 ",
    "TASK_1",
  ]) {
    expect(isTaskId(bad)).toBe(false);
    expect(await readTaskRunEvents(fsTaskLogIo, root, bad)).toBeNull();
  }
  expect(isTaskId("task_1")).toBe(true);

  // A run directory name is a path component from a URL, so it gets the same
  // treatment: only upstream's own shape is ever joined onto the root.
  for (const bad of [
    "..",
    "../..",
    "notes",
    "letta-background-aaaaa",
    "letta-background-aaaaaaa",
  ]) {
    expect(isRunDir(bad)).toBe(false);
    expect(await readTaskRunEvents(fsTaskLogIo, root, "task_1", { runDir: bad })).toBeNull();
  }
  expect(isRunDir(RUN_A)).toBe(true);

  // A pair reached through a symlink out of the root: the guard sees the link as
  // the last component and refuses, so the escape never becomes an open().
  const elsewhere = scratchRoot();
  writeFileSync(join(elsewhere, "secret.log"), "outside\n");
  symlinkSync(join(elsewhere, "secret.log"), join(root, RUN_A, "task_8.log"));
  expect(await readTaskRunEvents(fsTaskLogIo, root, "task_8")).toBeNull();
  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs.map((run) => run.taskId)).toEqual(["task_1"]);
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test("a bad retention value falls back rather than deleting everything", () => {
  expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
  expect(parseRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
  expect(parseRetentionDays("7")).toBe(7);
  expect(parseRetentionDays("0")).toBe(0);
  expect(parseRetentionDays("-3")).toBe(DEFAULT_RETENTION_DAYS);
  expect(parseRetentionDays("everything")).toBe(DEFAULT_RETENTION_DAYS);
});

test("the routes list, page, and refuse an id the listing could never produce", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "Route me",
    events:
      record(1, "2026-11-21T10:00:00.000Z", { type: "text", text: "one" }) +
      record(2, "2026-11-21T10:00:01.000Z", { type: "text", text: "two" }),
  });
  const app = new Hono<RouteEnv>();
  registerTaskRunRoutes(app, createTaskLogStore({ root, io: fsTaskLogIo, now: () => NOW }));

  const listed = await app.request("/api/task-runs?limit=1");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { runs: { taskId: string; runDir: string }[] };
  expect(body.runs[0]).toMatchObject({ taskId: "task_1", runDir: RUN_A });

  const events = await app.request("/api/task-runs/task_1/events?after=0&limit=1");
  expect(events.status).toBe(200);
  const page = (await events.json()) as { next: number; has_more: boolean; events: unknown[] };
  expect(page.events).toHaveLength(1);
  expect(page.has_more).toBe(true);

  // The directory the row carried is accepted; anything else is refused before a
  // path is built from it.
  const named = await app.request(`/api/task-runs/task_1/events?runDir=${RUN_A}`);
  expect(named.status).toBe(200);
  expect(((await named.json()) as { runDir: string }).runDir).toBe(RUN_A);
  expect(
    (await app.request(`/api/task-runs/task_1/events?runDir=${RUN_A.slice(0, -1)}`)).status,
  ).toBe(400);
  expect((await app.request("/api/task-runs/task_1/events?runDir=..")).status).toBe(400);
  // Traversal in the id itself is refused by the route's own grammar check.
  expect((await app.request("/api/task-runs/..%2f..%2fetc/events")).status).toBe(400);
  expect((await app.request("/api/task-runs/task_1%2f..%2f..%2flog/events")).status).toBe(400);
  rmSync(root, { recursive: true, force: true });
});

test("one over-long record is cut to a placeholder instead of buffered whole", async () => {
  const root = scratchRoot();
  // Three megabytes on one line, past MAX_LINE_BYTES: the reader must stop
  // accumulating at the bound rather than assemble the line and then measure it,
  // and the placeholder still says how big the record really was.
  const fat = "x".repeat(3 * 1024 * 1024);
  const fatRecord = record(1, "2026-11-20T10:00:00.000Z", {
    type: "tool_result",
    tool_call_id: "c",
    output: fat,
  });
  writePair(root, "task_1", {
    description: "Fat",
    events: fatRecord + record(2, "2026-11-20T10:00:01.000Z", { type: "text", text: "after" }),
  });

  const page = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 10 });
  expect(page?.events).toHaveLength(2);
  expect(page?.events[0]).toMatchObject({
    type: "oversized_record",
    bytes: fatRecord.trimEnd().length,
  });
  expect(String(page?.events[0]?.preview).length).toBeLessThanOrEqual(4 * 1024);
  expect(page?.events[1]).toMatchObject({ type: "text", text: "after" });
  rmSync(root, { recursive: true, force: true });
});

test("a fat line costs a page, not the run: the reader stops at the bound", async () => {
  const root = scratchRoot();
  // The regression this guards is memory, not correctness — a giant record used to
  // be assembled whole before being measured. Asserting the work it did, with a
  // ceiling loose enough that only deleting the bound can trip it: a timing
  // assertion would lose on a loaded machine, where `bun run verify` runs the
  // whole suite.
  const fat = "y".repeat(12 * 1024 * 1024);
  writePair(root, "task_1", {
    description: "Very fat",
    events: record(1, "2026-11-20T10:00:00.000Z", { type: "text", output: fat }),
  });

  const started = Date.now();
  const page = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 5 });
  const events = page?.events ?? [];
  expect(events).toHaveLength(1);
  expect((events[0] as { bytes?: number }).bytes).toBeGreaterThan(12 * 1024 * 1024);
  // The placeholder is a few kilobytes, whatever the record was: the bound worked.
  expect(JSON.stringify(events).length).toBeLessThan(1024 * 1024);
  expect(Date.now() - started).toBeLessThan(60_000);
  rmSync(root, { recursive: true, force: true });
});

test("a cursor past the end asks for nothing new rather than walking back", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "Short",
    events:
      record(1, "2026-11-20T10:00:00.000Z", { type: "text", text: "one" }) +
      record(2, "2026-11-20T10:00:01.000Z", { type: "text", text: "two" }),
  });

  const past = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 99_999, limit: 10 });
  expect(past?.events).toHaveLength(0);
  expect(past?.has_more).toBe(false);
  // The contract is "pass `next` back as `after`": a value past the end must not
  // send a caller backwards into records it already saw.
  expect(past?.next).toBe(99_999);
  rmSync(root, { recursive: true, force: true });
});

test("a marker the run quoted in its own output is not the run's ending", async () => {
  const root = scratchRoot();
  // A run whose job was reading a transcript can print `[Task completed]` and
  // then die. Upstream's marker is the file's last line, so a match anywhere in
  // the tail would report a death as a success — the exact lie the read is for.
  writePair(root, "task_1", {
    raw: `${startBlock("Read the old transcript", "general-purpose")}here it says: [Task completed]\n`,
    mtimeSeconds: (NOW.getTime() - 2 * DAY) / 1000,
  });
  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs[0]?.status).toBe("stopped");

  // And the real ending still counts, closing line last as upstream writes it.
  writePair(root, "task_2", {
    raw: `${startBlock("Read it again", "general-purpose")}output mentioning [Task completed] in the middle\n\nreport body\n\n${COMPLETED}`,
    mtimeSeconds: (NOW.getTime() - 2 * DAY) / 1000,
  });
  const both = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(both.runs.find((run) => run.taskId === "task_2")?.status).toBe("completed");
  rmSync(root, { recursive: true, force: true });
});

test("a run directory with nothing to judge ages by its own clock", async () => {
  const root = scratchRoot();
  // An empty directory (nothing inside, or only links out of the root) used to be
  // immortal: no entry to age by meant kept forever, and the live host has one.
  const empty = join(root, RUN_A);
  mkdirSync(empty, { recursive: true });
  ageDir(empty, (NOW.getTime() - 30 * DAY) / 1000);
  const fresh = join(root, RUN_B);
  mkdirSync(fresh, { recursive: true });

  const pruned = await pruneRunDirs(fsTaskLogIo, root, { now: NOW, retentionDays: 14 });
  expect(pruned.deleted).toEqual([RUN_A]);
  expect(existsSync(empty)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("a directory that went missing mid-prune is not an error", async () => {
  const root = scratchRoot();
  // Nothing here to prune, but the delete must agree: a directory can vanish
  // between the listing and the delete (a recreate, someone cleaning up) and that
  // is absence, not a failure the Runs pane should turn into a 500.
  await fsTaskLogIo.removeDir(join(root, RUN_A));
  expect((await pruneRunDirs(fsTaskLogIo, root, { now: NOW, retentionDays: 14 })).deleted).toEqual(
    [],
  );
  rmSync(root, { recursive: true, force: true });
});

test("a huge final record still leaves the run counted", async () => {
  const root = scratchRoot();
  // The event count comes from the last record's `seq`, read off a tail window.
  // A run whose last record is bigger than that window — one large tool result
  // closing the run — must widen the window rather than report no count, because
  // the sheet aims at the tail using it.
  const fat = JSON.stringify({
    seq: 7,
    at: "2026-11-20T10:00:07.000Z",
    type: "tool_result",
    text: "x".repeat(300_000),
  });
  writePair(root, "task_1", {
    description: "Big last record",
    events: record(1, "2026-11-20T10:00:01.000Z", { type: "text", text: "start" }) + `${fat}\n`,
  });
  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs[0]?.events).toBe(7);
  rmSync(root, { recursive: true, force: true });
});
