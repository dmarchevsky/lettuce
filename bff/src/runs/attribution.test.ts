import { describe, expect, test } from "bun:test";
import {
  agentIdFromCwd,
  agentIdFromWorkspaceSlug,
  parseAgentScope,
  scanBudget,
  splitRunsByAgent,
} from "./attribution.ts";

describe("the workspace is the attribution", () => {
  test("an agent's own workspace names it", () => {
    expect(agentIdFromCwd("/work/agent-1")).toBe("agent-1");
    // A worker may cd deeper; the owner is still whoever owns the workspace.
    expect(agentIdFromCwd("/work/agent-1/apps/api")).toBe("agent-1");
  });

  test("a run with no workspace of its own names nobody", () => {
    // Cron- and channel-fired runtimes run in `/work` itself.
    expect(agentIdFromCwd("/work")).toBeNull();
    expect(agentIdFromCwd("/work/")).toBeNull();
    expect(agentIdFromCwd("/tmp/work")).toBeNull();
    expect(agentIdFromCwd("/workish/agent-1")).toBeNull();
    expect(agentIdFromCwd("work/agent-1")).toBeNull();
    expect(agentIdFromCwd(null)).toBeNull();
    expect(agentIdFromCwd(undefined)).toBeNull();
    expect(agentIdFromCwd("")).toBeNull();
  });

  test("a first segment that cannot be an agent id is not one", () => {
    expect(agentIdFromCwd("/work/../etc")).toBeNull();
    expect(agentIdFromCwd("/work/.")).toBeNull();
    expect(agentIdFromCwd("/work/a b")).toBeNull();
    expect(agentIdFromCwd("/work/a/b")).toBe("a");
  });
});

describe("Claude's directory slug", () => {
  test("the slug of a workspace names the same agent", () => {
    expect(agentIdFromWorkspaceSlug("-work-agent-7")).toBe("agent-7");
    // Agent ids are dashes-and-words, so a slug still round-trips: the slug has
    // no separators left to cut on, which is the whole trick and its whole limit.
    expect(agentIdFromWorkspaceSlug("-work-a-b")).toBe("a-b");
  });

  test("anything else names nobody", () => {
    expect(agentIdFromWorkspaceSlug("-work")).toBeNull();
    expect(agentIdFromWorkspaceSlug("-tmp-work")).toBeNull();
    expect(agentIdFromWorkspaceSlug("")).toBeNull();
    expect(agentIdFromWorkspaceSlug(null)).toBeNull();
  });
});

describe("the filter's arithmetic", () => {
  const runs = [
    { id: 1, agentId: "a" as string | null },
    { id: 2, agentId: null },
    { id: 3, agentId: "a" as string | null },
    { id: 4, agentId: "b" as string | null },
  ];

  test("it keeps the agent's own and counts the rest of what was scanned", () => {
    const scoped = splitRunsByAgent(runs, "a", 10);
    expect(scoped.runs.map((run) => run.id)).toEqual([1, 3]);
    expect(scoped.other).toBe(2);
    // The count is of what the scan read, so it never promises more than it knows.
    expect(splitRunsByAgent(runs, "a", 1).other).toBe(2);
    expect(splitRunsByAgent(runs, "nobody", 10).runs).toEqual([]);
  });

  test("an unknown agent id is a bad request, not an empty list", () => {
    expect(parseAgentScope(undefined)?.agentId).toBeNull();
    expect(parseAgentScope("")?.agentId).toBeNull();
    expect(parseAgentScope("agent-1")?.agentId).toBe("agent-1");
    expect(parseAgentScope("two words")).toBeNull();
    expect(parseAgentScope("../etc")).toBeNull();
  });

  test("a filtered scan reads past its page, but only so far", () => {
    expect(scanBudget(8)).toBe(32);
  });
});
