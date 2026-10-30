import { describe, expect, test } from "bun:test";
import {
  LIVE_CRON_DIR,
  listSystemCron,
  parseCronFile,
  SYSTEM_CRON_DIR,
  type SystemCronIo,
  type SystemCronJob,
  withTopLevelOwners,
} from "./system-cron.ts";

const JOB = [
  "# agent: agent-a",
  "# description: Syncs the sensors",
  "*/15 * * * * root /usr/local/bin/agent-env /work/a/sync.sh >> /work/a/sync.log 2>&1",
  "",
].join("\n");

/** An io over an in-memory tree; a path mapped to an Error throws on read. */
function ioOf(files: Record<string, string | Error>): SystemCronIo {
  return {
    async read(path) {
      const file = files[path];
      if (file instanceof Error) throw file;
      return file ?? null;
    },
    async listFiles(dir) {
      const names = Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1));
      return names.length > 0 ? names : null;
    },
  };
}

describe("parseCronFile", () => {
  test("reads the owner, the description and the job line", () => {
    expect(parseCronFile(JOB)).toEqual({
      agentId: "agent-a",
      description: "Syncs the sensors",
      entries: [
        {
          schedule: "*/15 * * * *",
          command: "/usr/local/bin/agent-env /work/a/sync.sh >> /work/a/sync.log 2>&1",
        },
      ],
    });
  });

  test("skips other comments, env lines and blank lines", () => {
    const file = parseCronFile(
      '# Installed by hand\nPATH=/usr/bin:/bin\nMAILTO=""\n\n* * * * * root run.sh\n',
    );
    expect(file).toEqual({
      agentId: null,
      description: null,
      entries: [{ schedule: "* * * * *", command: "run.sh" }],
    });
  });

  test("takes @keyword schedules and keeps every job line", () => {
    expect(parseCronFile("@daily root a.sh\n0 7 * * 1-5 root b.sh --flag  x\n").entries).toEqual([
      { schedule: "@daily", command: "a.sh" },
      { schedule: "0 7 * * 1-5", command: "b.sh --flag  x" },
    ]);
  });

  test("an unexpanded or empty owner is no owner", () => {
    expect(parseCronFile("# agent: $LETTA_AGENT_ID\n* * * * * root x").agentId).toBeNull();
    expect(parseCronFile("# agent:\n* * * * * root x").agentId).toBeNull();
  });

  test("a line without a user and a command is not a job", () => {
    expect(parseCronFile("0 7 * * * root\n0 7 * *\n").entries).toEqual([]);
  });
});

describe("listSystemCron", () => {
  test("lists every job with its owner, by name", async () => {
    // Which agent sees which is the Tasks tab's call: only it knows which agents exist.
    const io = ioOf({
      [`${SYSTEM_CRON_DIR}/theirs`]: JOB.replace("agent-a", "agent-b"),
      [`${SYSTEM_CRON_DIR}/mine`]: JOB,
      [`${SYSTEM_CRON_DIR}/shared`]: "0 3 * * 0 root backup.sh\n",
    });
    expect((await listSystemCron(io)).map((job) => [job.name, job.agentId])).toEqual([
      ["mine", "agent-a"],
      ["shared", null],
      ["theirs", "agent-b"],
    ]);
  });

  test("a live copy that cannot be read is not live, not a missing job", async () => {
    const io = ioOf({
      [`${SYSTEM_CRON_DIR}/job`]: JOB,
      [`${LIVE_CRON_DIR}/job`]: new Error("EACCES"),
    });
    expect((await listSystemCron(io)).map((job) => [job.name, job.live])).toEqual([["job", false]]);
  });

  test("live only when /etc/cron.d holds the same file", async () => {
    const io = ioOf({
      [`${SYSTEM_CRON_DIR}/same`]: JOB,
      [`${LIVE_CRON_DIR}/same`]: JOB,
      [`${SYSTEM_CRON_DIR}/missing`]: JOB,
      [`${SYSTEM_CRON_DIR}/stale`]: JOB,
      [`${LIVE_CRON_DIR}/stale`]: JOB.replace("*/15", "*/30"),
    });
    const live = Object.fromEntries((await listSystemCron(io)).map((job) => [job.name, job.live]));
    expect(live).toEqual({ missing: false, same: true, stale: false });
  });

  test("skips names cron would skip, files without a job, and unreadable files", async () => {
    const io = ioOf({
      [`${SYSTEM_CRON_DIR}/.placeholder`]: JOB,
      [`${SYSTEM_CRON_DIR}/job.sh`]: JOB,
      [`${SYSTEM_CRON_DIR}/comments-only`]: "# agent: agent-a\n",
      [`${SYSTEM_CRON_DIR}/broken`]: new Error("EACCES"),
      [`${SYSTEM_CRON_DIR}/ok`]: JOB,
    });
    expect((await listSystemCron(io)).map((job) => job.name)).toEqual(["ok"]);
  });

  test("no folder yet is an empty list", async () => {
    expect(await listSystemCron(ioOf({}))).toEqual([]);
  });
});

describe("withTopLevelOwners", () => {
  const job = (name: string, agentId: string | null): SystemCronJob => ({
    name,
    agentId,
    description: null,
    entries: [{ schedule: "* * * * *", command: "x" }],
    live: true,
  });

  test("a subagent's job belongs to the agent that started it", async () => {
    // letta-code hides subagents from agent_list, so the Tasks tab would call the
    // subagent's id gone; the top of the `parent:` chain is the agent the user knows.
    const chains: Record<string, string[]> = {
      "agent-sub": ["agent-sub", "agent-mid", "agent-top"],
      "agent-top": ["agent-top"],
    };
    const jobs = await withTopLevelOwners(
      [job("a", "agent-sub"), job("b", "agent-top"), job("c", null)],
      async (id) => chains[id] ?? [id],
    );
    expect(jobs.map((entry) => entry.agentId)).toEqual(["agent-top", "agent-top", null]);
  });

  test("an owner whose chain cannot be read stays as written", async () => {
    const jobs = await withTopLevelOwners([job("a", "agent-gone")], async () => {
      throw new Error("not found");
    });
    expect(jobs[0]?.agentId).toBe("agent-gone");
  });
});
