import { expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  generationStamp,
  isTaskId,
  listTaskRuns,
  parseGenerationStamp,
  parseRetentionDays,
  pruneArchive,
  readTaskRunEvents,
  sweepTaskLogs,
} from "./task-logs.ts";
import { registerTaskRunRoutes } from "./task-routes.ts";

/**
 * These tests drive the real `fsTaskLogIo` against a scratch directory, because
 * the three things most likely to be wrong here — mtime order, a symlink that
 * points out of the root, and a rename that really moved both halves of a pair —
 * cannot be faked without faking away the assertion.
 */

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "lettuce-task-logs-"));
}

/** `[Task started: …]` + `[subagent_type: …]`, exactly as upstream writes them. */
function startBlock(description: string, subagentType: string): string {
  return `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n\n`;
}

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
  } = {},
): void {
  const body =
    options.raw ??
    startBlock(
      options.description ?? "Summarize the changelog",
      options.subagentType ?? "general-purpose",
    );
  writeFileSync(join(root, `${taskId}.log`), body);
  if (options.events !== undefined) writeFileSync(join(root, `${taskId}.jsonl`), options.events);
  if (options.mtimeSeconds !== undefined) {
    const at = options.mtimeSeconds;
    utimesSync(join(root, `${taskId}.log`), at, at);
    try {
      utimesSync(join(root, `${taskId}.jsonl`), at, at);
    } catch {
      // no event half to age
    }
  }
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
    join(root, "task_5.jsonl"),
    record(1, "2026-11-21T11:00:00.000Z", { type: "text", text: "x" }),
  );

  const list = await listTaskRuns(fsTaskLogIo, root, {
    now: NOW,
    retentionDays: DEFAULT_RETENTION_DAYS,
  });

  expect(list.runs.map((run) => run.taskId)).toEqual(["task_2", "task_1"]);
  const [second, first] = list.runs;
  expect(first?.description).toBe("Fix the failing math test");
  expect(first?.subagentType).toBe("general-purpose");
  expect(first?.kind).toBe("subagent");
  expect(first?.startedAt).toBe("2026-11-20T10:00:00.000Z");
  expect(first?.events).toBe(1);
  expect(first?.generation).toBeNull();
  expect(first?.bytes).toBeGreaterThan(0);
  // Touched a minute before `now`, so the row may say the run is live.
  expect(second?.status).toBe("running");
  expect(first?.status).toBe("completed");
  expect(list.runs.map((run) => run.kind)).toContain("claude-code");
  expect(list.next).toBeNull();
  expect(list.has_more).toBe(false);
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
    join(root, "task_1.jsonl"),
    record(2, "2026-11-21T10:00:02.000Z", { type: "text", text: "two" }),
  );
  appendFileSync(join(root, "task_1.jsonl"), `{"seq":3,"at":"2026-11-2`);
  const grown = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 10 });
  expect(grown?.events.map((event) => event.seq)).toEqual([1, 2]);
  expect(grown?.has_more).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("the sweep moves whole task pairs into the named generation and leaves everything else", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "One",
    events: record(1, "2026-11-20T10:00:00.000Z", { type: "text", text: "a" }),
  });
  writePair(root, "task_2", { description: "Two" });
  writePair(root, "bash_1", { raw: "command output\n" });
  writePair(root, "task_3", { raw: "no start block\n" });
  mkdirSync(join(root, "task_4.log"));
  writeFileSync(join(root, "outside.jsonl"), "not ours\n");
  symlinkSync(join(root, "outside.jsonl"), join(root, "task_9.log"));

  // `settleMs: 0`: the fixture's files were written this second, and the real
  // default would (correctly) call them still-being-written and leave them.
  const result = await sweepTaskLogs(fsTaskLogIo, root, {
    generation: "2026-11-21T14-03-22Z",
    settleMs: 0,
  });
  const dir = join(root, "archive", "2026-11-21T14-03-22Z");

  expect(result.generation).toBe("2026-11-21T14-03-22Z");
  expect(result.moved.slice().sort()).toEqual([
    "task_1.jsonl",
    "task_1.log",
    "task_2.log",
    "task_3.log",
  ]);
  expect(result.skipped.sort()).toEqual(["task_4.log", "task_9.log"]);
  expect(readFileSync(join(dir, "task_1.log"), "utf8")).toContain("[Task started: One]");
  // Non-task names and anything that is not a plain file stay where they were.
  expect(readFileSync(join(root, "bash_1.log"), "utf8")).toBe("command output\n");
  expect(readFileSync(join(root, "outside.jsonl"), "utf8")).toBe("not ours\n");
  // The link is still a link pointing at a file this module never moved.
  expect(readFileSync(join(root, "task_9.log"), "utf8")).toBe("not ours\n");

  // Idempotent: nothing left in the root to move, and no second directory.
  const again = await sweepTaskLogs(fsTaskLogIo, root, {
    generation: "2026-11-21T14-09-00Z",
    settleMs: 0,
  });
  expect(again).toMatchObject({ generation: null, moved: [] });
  rmSync(root, { recursive: true, force: true });
});

test("an empty root sweeps to nothing and creates no archive directory", async () => {
  const root = scratchRoot();
  const result = await sweepTaskLogs(fsTaskLogIo, root, { now: () => NOW });
  expect(result).toEqual({ generation: null, moved: [], skipped: [] });
  let archiveExists = true;
  try {
    utimesSync(join(root, "archive"), 1, 1);
  } catch {
    archiveExists = false;
  }
  expect(archiveExists).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("retention deletes only generation dirs it can date and can prove are expired", async () => {
  const root = scratchRoot();
  const expired = generationStamp(new Date(NOW.getTime() - 30 * DAY));
  const fresh = generationStamp(new Date(NOW.getTime() - 1 * DAY));
  for (const stamp of [expired, fresh]) {
    mkdirSync(join(root, "archive", stamp), { recursive: true });
    writeFileSync(join(root, "archive", stamp, "task_1.log"), startBlock("Old", "general-purpose"));
  }
  // A directory the sweep never wrote is nobody's to date, so it is nobody's to delete.
  mkdirSync(join(root, "archive", "notes"), { recursive: true });

  const pruned = await pruneArchive(fsTaskLogIo, root, { now: NOW, retentionDays: 14 });
  expect(pruned.deleted).toEqual([expired]);
  // `kept` counts the generations it could date. `notes` is not one of the
  // module's, so it is not counted either — it is simply not the module's.
  expect(pruned.kept).toBe(1);
  let gone = false;
  try {
    utimesSync(join(root, "archive", expired), 1, 1);
  } catch {
    gone = true;
  }
  expect(gone).toBe(true);
  utimesSync(join(root, "archive", fresh), 1, 1);
  utimesSync(join(root, "archive", "notes"), 1, 1);

  // Zero keeps everything: a mis-set TASK_LOG_RETENTION_DAYS must not empty the archive.
  expect((await pruneArchive(fsTaskLogIo, root, { now: NOW, retentionDays: 0 })).deleted).toEqual(
    [],
  );
  rmSync(root, { recursive: true, force: true });
});

test("listing runs retention, so the pane is self-limiting without a scheduler", async () => {
  const root = scratchRoot();
  const expired = generationStamp(new Date(NOW.getTime() - 40 * DAY));
  mkdirSync(join(root, "archive", expired), { recursive: true });
  writePair(root, "task_1", { description: "Now" });
  await listTaskRuns(fsTaskLogIo, root, { now: NOW, retentionDays: 14 });
  let gone = false;
  try {
    utimesSync(join(root, "archive", expired), 1, 1);
  } catch {
    gone = true;
  }
  expect(gone).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("an archived run lists with its generation and still opens", async () => {
  const root = scratchRoot();
  const stamp = generationStamp(new Date(NOW.getTime() - DAY));
  mkdirSync(join(root, "archive", stamp), { recursive: true });
  writeFileSync(
    join(root, "archive", stamp, "task_7.log"),
    startBlock("Yesterday's run", "general-purpose"),
  );
  writeFileSync(
    join(root, "archive", stamp, "task_7.jsonl"),
    record(1, "2026-11-20T09:00:00.000Z", { type: "text", text: "yesterday" }),
  );

  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs.map((run) => run.taskId)).toEqual(["task_7"]);
  expect(list.runs[0]?.generation).toBe(stamp);
  const page = await readTaskRunEvents(fsTaskLogIo, root, "task_7");
  expect(page?.generation).toBe(stamp);
  expect(page?.events).toHaveLength(1);
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

  // A pair reached through a symlink out of the root: the guard sees the link as
  // the last component and refuses, so the escape never becomes an open().
  const elsewhere = scratchRoot();
  writeFileSync(join(elsewhere, "secret.log"), "outside\n");
  symlinkSync(join(elsewhere, "secret.log"), join(root, "task_8.log"));
  expect(await readTaskRunEvents(fsTaskLogIo, root, "task_8")).toBeNull();
  const list = await listTaskRuns(fsTaskLogIo, root, { now: NOW });
  expect(list.runs.map((run) => run.taskId)).toEqual(["task_1"]);
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test("generation stamps round-trip, and a bad retention value falls back", () => {
  const stamp = generationStamp(NOW);
  expect(stamp).toBe("2026-11-21T12-00-00Z");
  expect(parseGenerationStamp(stamp)).toBe(NOW.getTime());
  expect(parseGenerationStamp("2026-13-45T99-99-99Z")).toBeNull();
  expect(parseGenerationStamp("notes")).toBeNull();
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
  const body = (await listed.json()) as { runs: { taskId: string }[]; next: number | null };
  expect(body.runs.map((run) => run.taskId)).toEqual(["task_1"]);

  const events = await app.request("/api/task-runs/task_1/events?after=0&limit=1");
  expect(events.status).toBe(200);
  const page = (await events.json()) as { next: number; has_more: boolean; events: unknown[] };
  expect(page.events).toHaveLength(1);
  expect(page.has_more).toBe(true);
  const second = await app.request(`/api/task-runs/task_1/events?after=${page.next}`);
  expect(((await second.json()) as { events: unknown[] }).events).toHaveLength(1);

  expect((await app.request("/api/task-runs/not-a-task/events")).status).toBe(400);
  expect((await app.request("/api/task-runs/task_404/events")).status).toBe(404);
  // Encoded traversal reaches the handler and is refused there — the id grammar is
  // the gate, not the router's idea of a path.
  expect((await app.request("/api/task-runs/..%2f..%2fetc/events")).status).toBe(400);
  expect((await app.request("/api/task-runs/task_1%2f..%2f..%2flog/events")).status).toBe(400);
  rmSync(root, { recursive: true, force: true });
});

test("the sweep leaves a pair this process may still be writing", async () => {
  const root = scratchRoot();
  // One hour old and one written this second: only the settled one is movable.
  writePair(root, "task_1", { description: "Old", mtimeSeconds: (Date.now() - 3_600_000) / 1000 });
  writePair(root, "task_2", { description: "Live" });

  const result = await sweepTaskLogs(fsTaskLogIo, root, { generation: "2026-11-21T14-03-22Z" });
  const dir = join(root, "archive", "2026-11-21T14-03-22Z");

  expect(result.moved.sort()).toEqual(["task_1.log"]);
  expect(result.skipped).toEqual(["task_2.log"]);
  expect(existsSync(join(dir, "task_1.log"))).toBe(true);
  // The live run's file is where its writer will append to next. Upstream re-opens
  // by path on every write, so a move here would leave the transcript in two files.
  expect(existsSync(join(root, "task_2.log"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("a reused task id reads the generation it was asked for", async () => {
  const root = scratchRoot();
  // The whole point of the generation: upstream restarts its counter, so the same
  // `task_1` names two different runs, and a row for the old one must not open
  // the new one's transcript.
  writePair(root, "task_1", {
    description: "First run",
    events: record(1, "2026-11-20T10:00:00.000Z", { type: "text", text: "first" }),
    mtimeSeconds: (Date.now() - 3_600_000) / 1000,
  });
  const swept = await sweepTaskLogs(fsTaskLogIo, root, { generation: "2026-11-21T14-03-22Z" });
  expect(swept.moved.length).toBe(2);
  writePair(root, "task_1", {
    description: "Second run",
    events: record(1, "2026-11-21T15:00:00.000Z", { type: "text", text: "second" }),
  });

  // The current name means the current run; the archived row needs its stamp.
  const current = await readTaskRunEvents(fsTaskLogIo, root, "task_1");
  expect(current?.generation).toBeNull();
  expect((current?.events[0] as { text?: string })?.text).toBe("second");

  const archived = await readTaskRunEvents(fsTaskLogIo, root, "task_1", {
    generation: "2026-11-21T14-03-22Z",
  });
  expect(archived?.generation).toBe("2026-11-21T14-03-22Z");
  expect((archived?.events[0] as { text?: string })?.text).toBe("first");

  // And the routes carry it, because that is where the row got it from.
  const app = new Hono<RouteEnv>();
  const store = createTaskLogStore({ root });
  registerTaskRunRoutes(app, store);
  const viaRoute = await app.request(
    "/api/task-runs/task_1/events?generation=2026-11-21T14-03-22Z",
  );
  const page = (await viaRoute.json()) as { generation: string; events: { text?: string }[] };
  expect(page.generation).toBe("2026-11-21T14-03-22Z");
  expect(page.events[0]?.text).toBe("first");
  // A stamp is a directory name the module wrote, so only its shape is accepted.
  expect((await app.request("/api/task-runs/task_1/events?generation=..%2Farchive")).status).toBe(
    400,
  );
  rmSync(root, { recursive: true, force: true });
});

test("one over-long record is cut instead of buffered whole", async () => {
  const root = scratchRoot();
  const fat = "x".repeat(3 * 1024 * 1024);
  writePair(root, "task_1", {
    description: "Fat",
    events:
      record(1, "2026-11-20T10:00:00.000Z", {
        type: "tool_result",
        tool_call_id: "c",
        output: fat,
      }) + record(2, "2026-11-20T10:00:01.000Z", { type: "text", text: "after" }),
  });

  const page = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 0, limit: 10 });
  expect(page?.events.map((event) => (event as { type?: string }).type)).toEqual([
    "oversized_record",
    "text",
  ]);
  const first = page?.events[0] as { bytes: number; preview: string };
  expect(first.bytes).toBeGreaterThan(3 * 1024 * 1024 - 200);
  expect(first.preview.length).toBeLessThan(8 * 1024);
  // The records around it are untouched: the bound is per record, not per page.
  const second = page?.events[1] as { text: string } | undefined;
  expect(second?.text).toBe("after");
  rmSync(root, { recursive: true, force: true });
});

test("a cursor past the end asks for nothing new rather than walking back", async () => {
  const root = scratchRoot();
  writePair(root, "task_1", {
    description: "Short",
    events:
      record(1, "2026-11-20T10:00:00.000Z", { type: "text", text: "a" }) +
      record(2, "2026-11-20T10:00:01.000Z", { type: "text", text: "b" }),
  });

  const page = await readTaskRunEvents(fsTaskLogIo, root, "task_1", { after: 100_000, limit: 10 });
  expect(page?.events).toEqual([]);
  // The contract is "pass `next` back as `after`"; a `next` below the caller's
  // cursor would send a tail-aiming reader backwards through a log it already has.
  expect(page?.next).toBeGreaterThanOrEqual(100_000);
  expect(page?.has_more).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
