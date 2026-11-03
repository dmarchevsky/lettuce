import { describe, expect, test } from "bun:test";
import type { LiveSubagent } from "../lib/subagents.ts";
import { readLiveSubagents } from "../lib/subagents.ts";
import { readBackgroundProcesses } from "./use-conversation.ts";

function live(over: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    status: "running",
    subagentType: "general-purpose",
    description: "summarise the repo",
    toolCalls: [],
    progress: [],
    totalTokens: 0,
    durationMs: 0,
    ...over,
  };
}

/**
 * Since letta-code 0.33 the snapshot builder emits workflows natively as
 * `kind: "workflow"` (`WorkflowBackgroundProcessSummary`). Before that they
 * arrived as `kind: "bash"`, and an allowlist that forgot the new kind would
 * silently drop every running workflow from the Tasks tab.
 */
describe("background process parsing", () => {
  test("a native workflow keeps its kind and description", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "workflow_1",
        kind: "workflow",
        description: "nightly-digest",
        started_at_ms: 1,
        status: "running",
      },
    ]);
    expect(process?.kind).toBe("workflow");
    expect(process?.label).toBe("nightly-digest");
  });

  test("a shell command that starts with 'workflow ' stays a shell job", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "bash_7",
        kind: "bash",
        command: "workflow --help",
        status: "running",
        exit_code: null,
      },
    ]);
    expect(process?.kind).toBe("bash");
    expect(process?.label).toBe("workflow --help");
  });

  test("a workflow is never stoppable", () => {
    // stopMonitor upstream refuses anything whose process.kind !== "monitor",
    // so offering Stop for a workflow would always fail.
    const [process] = readBackgroundProcesses([
      { process_id: "workflow_2", kind: "workflow", description: "x", status: "running" },
    ]);
    expect(process?.stoppable).toBe(false);
  });

  test("a monitor is still stoppable while running", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "monitor_1",
        kind: "monitor",
        description: "watch build",
        status: "running",
        persistent: true,
      },
    ]);
    expect(process?.kind).toBe("monitor");
    expect(process?.stoppable).toBe(true);
  });

  test("a finished monitor is not stoppable", () => {
    const [process] = readBackgroundProcesses([
      { process_id: "monitor_2", kind: "monitor", description: "done", status: "exited" },
    ]);
    expect(process?.stoppable).toBe(false);
  });

  test("an agent task keeps its description as the label", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "task_1",
        kind: "agent_task",
        task_type: "general-purpose",
        description: "summarise the repo",
        status: "running",
      },
    ]);
    expect(process?.kind).toBe("agent_task");
    expect(process?.label).toBe("summarise the repo");
  });

  test("unknown kinds and malformed entries are dropped", () => {
    expect(readBackgroundProcesses([{ process_id: "x_1", kind: "mystery" }])).toEqual([]);
    expect(readBackgroundProcesses([{ kind: "bash", command: "ls" }])).toEqual([]);
    expect(readBackgroundProcesses("nope")).toEqual([]);
    expect(readBackgroundProcesses([])).toEqual([]);
  });

  // A subagent row is stoppable only while the snapshot list still names its child agent —
  // `subagent_stop` takes that id, not the process id (letta-code 0.34.16).
  const runningTask = {
    process_id: "task_1",
    subagent_id: "sub_1",
    kind: "agent_task",
    description: "summarise the repo",
    status: "running",
  };

  test("a subagent with a live child agent is stoppable", () => {
    const [process] = readBackgroundProcesses([runningTask], {
      sub_1: live({ agentId: "agent_9" }),
    });
    expect(process?.subagentId).toBe("sub_1");
    expect(process?.stoppable).toBe(true);
  });

  test("a subagent the app-server no longer owns has no Stop", () => {
    // No snapshot (never had one, or an app-server restart dropped it) …
    expect(readBackgroundProcesses([runningTask])[0]?.stoppable).toBe(false);
    // … or a snapshot whose child carries no agent id.
    expect(readBackgroundProcesses([runningTask], {})[0]?.stoppable).toBe(false);
    expect(readBackgroundProcesses([runningTask], { sub_1: live() })[0]?.stoppable).toBe(false);
  });

  test("a finished subagent is not stoppable", () => {
    // Leaving a finished snapshot out of the live map is what takes the Stop away.
    const snapshots = [{ subagent_id: "sub_1", agent_id: "agent_9", status: "completed" }];
    const liveMap = readLiveSubagents(snapshots);
    const [process] = readBackgroundProcesses([{ ...runningTask, status: "completed" }], liveMap);
    expect(liveMap).toEqual({});
    expect(process?.stoppable).toBe(false);
  });

  test("readLiveSubagents keeps live snapshots whole", () => {
    const parsed = readLiveSubagents([
      {
        subagent_id: "sub_1",
        agent_id: "agent_9",
        status: "running",
        subagent_type: "codex",
        description: "fix flaky test",
        tool_call_id: "tc_1",
        tool_calls: [
          { id: "a", name: "Bash", args: '{"command":"bun test"}' },
          { id: "b", name: "Edit", args: '{"file_path":"web/src/app.tsx"}' },
        ],
        total_tokens: 4800,
        duration_ms: 60_400,
      },
      { subagent_id: "sub_2", status: "pending" }, // a child id is not known yet
      { subagent_id: "sub_3", agent_id: "agent_11", status: "error" },
      { agent_id: "agent_12", status: "running" },
      null,
    ]);
    expect(Object.keys(parsed)).toEqual(["sub_1", "sub_2"]);
    expect(parsed.sub_1).toEqual({
      status: "running",
      subagentType: "codex",
      description: "fix flaky test",
      toolCallId: "tc_1",
      agentId: "agent_9",
      toolCalls: [
        { name: "Bash", args: '{"command":"bun test"}' },
        { name: "Edit", args: '{"file_path":"web/src/app.tsx"}' },
      ],
      progress: [],
      totalTokens: 4800,
      durationMs: 60_400,
    });
    expect(readLiveSubagents(undefined)).toEqual({});
  });

  test("a workflow summary keeps its progress counts and phases", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "workflow_3",
        kind: "workflow",
        description: "release sweep",
        status: "running",
        progress: {
          agents_total: 8,
          agents_done: 5,
          agents_failed: 1,
          agents_running: 2,
          total_tokens: 140_000,
          phases: [
            {
              title: "plan",
              agents_total: 4,
              agents_done: 4,
              agents_failed: 0,
              agents_running: 0,
              total_tokens: 10,
            },
            {
              title: "build",
              agents_total: 4,
              agents_done: 1,
              agents_failed: 1,
              agents_running: 2,
              total_tokens: 20,
            },
          ],
        },
      },
    ]);
    expect(process?.workflow).toEqual({
      total: 8,
      done: 5,
      failed: 1,
      running: 2,
      tokens: 140_000,
      phases: [
        { title: "plan", total: 4, done: 4, failed: 0, running: 0, tokens: 10 },
        { title: "build", total: 4, done: 1, failed: 1, running: 2, tokens: 20 },
      ],
    });
  });

  test("a workflow without progress on the wire gets no workflow field", () => {
    const [bare] = readBackgroundProcesses([
      { process_id: "workflow_4", kind: "workflow", description: "x", status: "running" },
    ]);
    const [empty] = readBackgroundProcesses([
      {
        process_id: "workflow_5",
        kind: "workflow",
        description: "y",
        status: "running",
        progress: {},
      },
    ]);
    expect(bare?.workflow).toBeUndefined();
    expect(empty?.workflow).toBeUndefined();
  });
});
