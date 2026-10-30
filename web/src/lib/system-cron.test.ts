import { describe, expect, test } from "bun:test";
import { jobsForAgent, type SystemCronJob } from "./system-cron.ts";

const job = (name: string, agentId: string | null): SystemCronJob => ({
  name,
  agentId,
  description: null,
  entries: [{ schedule: "0 7 * * *", command: "x.sh" }],
  live: true,
});

const JOBS = [job("mine", "agent-a"), job("theirs", "agent-b"), job("shared", null)];

describe("jobsForAgent", () => {
  test("the agent's own jobs and owner-less ones, not another agent's", () => {
    const shown = jobsForAgent(JOBS, "agent-a", ["agent-a", "agent-b"]);
    expect(shown.map((entry) => entry.job.name)).toEqual(["mine", "shared"]);
    expect(shown.map((entry) => entry.owner)).toEqual(["self", "none"]);
  });

  test("a job whose agent no longer exists shows under every agent", () => {
    // Hidden everywhere, it would keep running with nothing in the UI saying so.
    const shown = jobsForAgent(JOBS, "agent-a", ["agent-a"]);
    expect(shown.map((entry) => [entry.job.name, entry.owner])).toEqual([
      ["mine", "self"],
      ["theirs", "gone"],
      ["shared", "none"],
    ]);
  });

  test("before the agent list loads, no owner is taken for gone", () => {
    expect(jobsForAgent(JOBS, "agent-a", []).map((entry) => entry.job.name)).toEqual([
      "mine",
      "shared",
    ]);
  });
});
