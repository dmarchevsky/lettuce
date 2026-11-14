import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import type { WatchdogUpstream } from "./context-watchdog.ts";
import { StepLimitWatchdog, stepLimitMessage } from "./step-limit-watchdog.ts";

const RUNTIME = { agent_id: "agent-1", conversation_id: "conv-1" };

function delta(messageType: string, extra: Record<string, unknown> = {}): WsProtocolMessage {
  return {
    type: "stream_delta",
    runtime: RUNTIME,
    delta: { message_type: messageType, ...extra },
  } as unknown as WsProtocolMessage;
}

const toolCall = (runId?: string) =>
  delta("approval_request_message", {
    tool_call: { name: "Bash" },
    ...(runId ? { run_id: runId } : {}),
  });
const usage = () => delta("usage_statistics", { step_count: 1, prompt_tokens: 10 });
const answer = () => delta("assistant_message", { content: "done" });
const interrupted = () => delta("status", { message: "Interrupted", level: "warning" });
const compaction = () => delta("event_message", { event_type: "compaction" });

function finished(stopReason: string, extra: Record<string, unknown> = {}): WsProtocolMessage {
  return {
    type: "turn_finished",
    turn_id: "turn-1",
    run_id: "run-1",
    stop_reason: stopReason,
    runtime: RUNTIME,
    ...extra,
  } as unknown as WsProtocolMessage;
}

function setup(opts: { limit: number | null; aborted?: boolean; fail?: boolean }) {
  const commands: Record<string, unknown>[] = [];
  const upstream = {
    request: async (command: any): Promise<any> => {
      commands.push(command);
      if (command.type === "resume_queue") {
        return { type: "resume_queue_response", request_id: command.request_id, success: true };
      }
      if (command.type !== "abort_message") throw new Error(`unexpected ${command.type}`);
      if (opts.fail) throw new Error("socket closed");
      return {
        type: "abort_message_response",
        request_id: command.request_id,
        runtime: command.runtime,
        aborted: opts.aborted ?? true,
        success: true,
      };
    },
    isReady: () => true,
  } as unknown as WatchdogUpstream;
  const watchdog = new StepLimitWatchdog({
    limitFor: (agentId) => (agentId === "agent-1" ? opts.limit : null),
    upstream,
    log: () => {},
    now: () => new Date("2026-11-13T10:00:00Z"),
  });
  // The order index.ts runs them in: translate first, then observe each frame it yields.
  const feed = (frame: WsProtocolMessage): WsProtocolMessage[] => {
    const out = watchdog.translate(frame);
    for (const f of out) watchdog.observe(f);
    return out;
  };
  /** One model step that asked for a tool. */
  const toolStep = (runId?: string) => {
    feed(toolCall(runId));
    feed(usage());
  };
  const sent = (type: string) => commands.filter((c) => c.type === type);
  return { feed, toolStep, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("StepLimitWatchdog", () => {
  test("stops the turn once, at the step that reaches the limit", async () => {
    const { toolStep, sent } = setup({ limit: 3 });
    toolStep();
    toolStep();
    expect(sent("abort_message")).toEqual([]);
    toolStep();
    expect(sent("abort_message")).toHaveLength(1);
    expect(sent("abort_message")[0]?.runtime).toEqual(RUNTIME);
    // A step that slips past the abort does not send a second one.
    toolStep();
    await settle();
    expect(sent("abort_message")).toHaveLength(1);
  });

  test("a compaction mid-turn does not reset the count", () => {
    const { feed, toolStep, sent } = setup({ limit: 3 });
    toolStep();
    toolStep();
    feed(compaction());
    feed(delta("summary_message", { summary: "…" }));
    toolStep();
    expect(sent("abort_message")).toHaveLength(1);
  });

  test("the abort names the turn's run when the stream carried one", () => {
    const { toolStep, sent } = setup({ limit: 1 });
    toolStep("run-7");
    expect(sent("abort_message")[0]?.run_id).toBe("run-7");
  });

  test("without a run id in the stream the abort is scoped by conversation alone", () => {
    const { toolStep, sent } = setup({ limit: 1 });
    toolStep();
    expect("run_id" in (sent("abort_message")[0] ?? {})).toBe(false);
  });

  test("leaves a final answer alone, even at the limit", () => {
    const { feed, toolStep, sent } = setup({ limit: 2 });
    toolStep();
    feed(answer());
    feed(usage());
    expect(sent("abort_message")).toEqual([]);
  });

  test("a tool call from a step that failed before its usage does not carry over", () => {
    const { feed, toolStep, sent } = setup({ limit: 2 });
    toolStep();
    feed(toolCall());
    feed(delta("retry", { message: "provider error", attempt: 1 }));
    // The retried step answers without tools.
    feed(answer());
    feed(usage());
    expect(sent("abort_message")).toEqual([]);
  });

  test("an agent without a limit is never stopped", () => {
    const { toolStep, sent } = setup({ limit: null });
    for (let i = 0; i < 50; i++) toolStep();
    expect(sent("abort_message")).toEqual([]);
  });

  test("a subagent's steps do not count against the parent", () => {
    const { feed, toolStep, sent } = setup({ limit: 2 });
    toolStep();
    for (let i = 0; i < 5; i++) {
      feed({ ...toolCall(), subagent_id: "sub-1" } as WsProtocolMessage);
      feed({ ...usage(), subagent_id: "sub-1" } as WsProtocolMessage);
    }
    expect(sent("abort_message")).toEqual([]);
  });

  test("the count starts over with each turn", () => {
    const { feed, toolStep, sent } = setup({ limit: 2 });
    toolStep();
    feed(answer());
    feed(usage());
    feed(finished("end_turn"));
    toolStep();
    expect(sent("abort_message")).toEqual([]);
    toolStep();
    expect(sent("abort_message")).toHaveLength(1);
  });

  test("reports its own stop as upstream's max_steps, with the loop_error first", async () => {
    const { feed, toolStep } = setup({ limit: 2 });
    toolStep();
    toolStep();
    await settle();
    const out = feed(finished("cancelled"));
    const message = stepLimitMessage(2, 2);
    expect(message).toBe("Model call limit reached (2/2 calls)");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: "stream_delta",
      runtime: RUNTIME,
      delta: {
        id: "step-limit-turn-1",
        message_type: "loop_error",
        run_id: "run-1",
        message,
        stop_reason: "max_steps",
        is_terminal: true,
      },
    });
    expect(out[1]).toMatchObject({
      type: "turn_finished",
      turn_id: "turn-1",
      stop_reason: "max_steps",
      error: message,
    });
  });

  test("drops the abort's Interrupted line, and only for the stopped turn", async () => {
    const { feed, toolStep } = setup({ limit: 1 });
    const before = interrupted();
    expect(feed(before)).toEqual([before]);
    toolStep();
    await settle();
    expect(feed(interrupted())).toEqual([]);
    feed(finished("cancelled"));
    const after = interrupted();
    expect(feed(after)).toEqual([after]);
  });

  test("releases the queue the abort parked once the stopped turn finished", async () => {
    const { feed, toolStep, sent } = setup({ limit: 1 });
    toolStep();
    await settle();
    expect(sent("resume_queue")).toEqual([]);
    feed(finished("cancelled"));
    await settle();
    expect(sent("resume_queue")).toHaveLength(1);
    expect(sent("resume_queue")[0]?.runtime).toEqual(RUNTIME);
  });

  test("releases the queue when the turn finished before the abort was confirmed", async () => {
    const { feed, toolStep, sent } = setup({ limit: 1 });
    toolStep();
    // The finish lands before the abort's answer: not rewritten, since the stop
    // is not confirmed yet, but the queue the abort parked is still released.
    const frame = finished("cancelled");
    expect(feed(frame)).toEqual([frame]);
    await settle();
    expect(sent("resume_queue")).toHaveLength(1);
  });

  test("a user's Stop passes through untouched", () => {
    const { feed, toolStep, sent } = setup({ limit: 5 });
    toolStep();
    const frame = finished("cancelled");
    expect(feed(frame)).toEqual([frame]);
    expect(sent("resume_queue")).toEqual([]);
  });

  test("when the user's Stop got there first, the finish stays theirs", async () => {
    const { feed, toolStep, sent } = setup({ limit: 1, aborted: false });
    toolStep();
    await settle();
    const frame = finished("cancelled");
    expect(feed(frame)).toEqual([frame]);
    await settle();
    expect(sent("resume_queue")).toEqual([]);
  });

  test("a failed abort is not reported as a stop", async () => {
    const { feed, toolStep } = setup({ limit: 1, fail: true });
    toolStep();
    await settle();
    const frame = finished("cancelled");
    expect(feed(frame)).toEqual([frame]);
  });

  test("only the stopped turn's finish is rewritten", async () => {
    const { feed, toolStep } = setup({ limit: 1 });
    toolStep();
    await settle();
    expect(feed(finished("cancelled"))).toHaveLength(2);
    const next = finished("cancelled", { turn_id: "turn-2" });
    expect(feed(next)).toEqual([next]);
  });

  test("other frames pass through translate unchanged", () => {
    const { feed } = setup({ limit: 1 });
    const frame = finished("end_turn");
    expect(feed(frame)).toEqual([frame]);
    const d = answer();
    expect(feed(d)).toEqual([d]);
  });
});
