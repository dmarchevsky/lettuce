import { describe, expect, test } from "bun:test";
import {
  agentIdFromCwd,
  agentIdFromWorkspaceSlug,
  parseAgentScope,
  scanBudget,
  splitRunsByAgent,
  workspaceAgentIds,
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
  const workspaces = workspaceAgentIds(["agent-7", "a-b", "smoke-probe.md", "notes.txt"]);

  test("the slug of a workspace names the same agent", () => {
    expect(agentIdFromWorkspaceSlug("-work-agent-7", workspaces)).toBe("agent-7");
    // Agent ids are dashes-and-words, so a slug still round-trips: the slug has
    // no separators left to cut on, which is the whole trick and its whole limit.
    expect(agentIdFromWorkspaceSlug("-work-a-b", workspaces)).toBe("a-b");
  });

  test("a slug that reads as an id but is a deeper path names nobody", () => {
    // `/work/agent-7/apps/api` and an agent called `agent-7-apps-api` slug to the
    // same string, and the shape cannot tell them apart — so the claim needs the
    // workspace listing to stand behind it. Without it: no owner, no phantom.
    expect(agentIdFromWorkspaceSlug("-work-agent-7-apps-api", workspaces)).toBeNull();
    expect(agentIdFromWorkspaceSlug("-work-agent-7", new Set())).toBeNull();
  });

  test("anything else names nobody", () => {
    expect(agentIdFromWorkspaceSlug("-work", workspaces)).toBeNull();
    expect(agentIdFromWorkspaceSlug("-tmp-work", workspaces)).toBeNull();
    expect(agentIdFromWorkspaceSlug("", workspaces)).toBeNull();
    expect(agentIdFromWorkspaceSlug(null, workspaces)).toBeNull();
    // Only agent-shaped directory names count as workspaces.
    expect(workspaceAgentIds(null)).toEqual(new Set());
    expect([...workspaceAgentIds(["agent-7", "not an id"])]).toEqual(["agent-7"]);
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
