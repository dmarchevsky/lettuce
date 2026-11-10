import { describe, expect, test } from "bun:test";
import { scopeKeyOf } from "./buffer.ts";
import { RuntimeStartCache, STALE_AFTER_MS, startScopeOf } from "./runtime-start-cache.ts";

/**
 * A repeat conversation open used to cost a state replay, which on a slow disk is
 * seconds of the whole app-server answering nobody. The BFF can answer it
 * instead — but only when it is certain, so the refusals matter more than the
 * answers, and they are what these pin down.
 */

const START = {
  type: "runtime_start",
  request_id: "web-1",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  wait_for_replay: true,
  cwd: "/work/agent-1",
};

const scope = startScopeOf(START, scopeKeyOf);
const SCOPE = scopeKeyOf("agent-1", "conv-1");
const CWD = "/work/agent-1";

describe("startScopeOf", () => {
  test("a plain open is answerable, at its cwd", () => {
    expect(scope).toEqual({ scopeKey: SCOPE, cwd: CWD });
  });

  test("only a start is a start", () => {
    // The fields are what makes an `input` carry the same shape; the type is
    // what makes it a request to start anything.
    expect(startScopeOf({ ...START, type: "input" }, scopeKeyOf)).toBeNull();
  });

  test("any other parameter is the app-server's question, not the BFF's", () => {
    for (const extra of [
      { mode: "acceptEdits" },
      { external_tools: [] },
      { execution_settings: { reasoning: true } },
      { create_conversation: { agent_id: "agent-1", body: {} } },
      { create_agent: { body: {} } },
      { skill_sources: ["global"] },
      { force_device_status: true },
      // An unknown field is refused rather than assumed harmless: it may be the
      // one thing the browser was actually asking for.
      { some_future_option: 1 },
    ]) {
      expect(startScopeOf({ ...START, ...extra }, scopeKeyOf)).toBeNull();
    }
  });

  test("a start that never asked to wait for the replay is not a replay to skip", () => {
    expect(startScopeOf({ ...START, wait_for_replay: false }, scopeKeyOf)).toBeNull();
    const { wait_for_replay: _omitted, ...rest } = START;
    expect(startScopeOf(rest, scopeKeyOf)).toBeNull();
  });

  test("an omitted cwd and a null cwd are different requests", () => {
    const { cwd: _cwd, ...noCwd } = START;
    expect(startScopeOf(noCwd, scopeKeyOf)?.cwd).toBe("(omitted)");
    expect(startScopeOf({ ...START, cwd: null }, scopeKeyOf)?.cwd).toBe("(null)");
  });
});

/** A clock the test turns, because a busy claim is only good for a minute. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const busy = {
  type: "update_device_status",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  device_status: { is_processing: true },
} as never;
const idle = {
  type: "update_device_status",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  device_status: { is_processing: false },
} as never;
const queued = {
  type: "update_queue",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  queue: [{ id: "q1" }],
} as never;
const loopBusy = {
  type: "update_loop_status",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  loop_status: { status: "RUNNING" },
} as never;
const loopIdle = {
  type: "update_loop_status",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  loop_status: { status: "WAITING_ON_INPUT" },
} as never;
const subagents = {
  type: "update_subagent_state",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  subagents: [{ subagent_id: "sub-1", name: "worker", state: "running" }],
} as never;

describe("RuntimeStartCache", () => {
  test("an unseen conversation is not answerable", () => {
    expect(new RuntimeStartCache().replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("a started runtime with nothing routed yet says nothing about live state", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("frames from a start's own replay are kept before its answer", () => {
    const cache = new RuntimeStartCache();
    // Upstream's order: the replay is emitted, then the response resolves.
    cache.noteFrame(SCOPE, idle, 1);
    cache.remember(SCOPE, CWD, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([idle]);
  });

  test("frames from before a reconnect are not this connection's state", () => {
    const cache = new RuntimeStartCache();
    cache.noteFrame(SCOPE, busy, 1);
    cache.noteFrame(SCOPE, idle, 2);
    cache.remember(SCOPE, CWD, 2);
    expect(cache.replayFor(SCOPE, CWD, 2)).toEqual([idle]);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("a remembered start replays the newest live state it has", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, busy, 1);
    cache.noteFrame(SCOPE, queued, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([busy, queued]);
  });

  test("a running subagent rides along, in the order the replay emits them", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    cache.noteFrame(SCOPE, loopIdle, 1);
    cache.noteFrame(SCOPE, queued, 1);
    cache.noteFrame(SCOPE, subagents, 1);
    // `emitStateSync` order, so a browser cannot tell the two answers apart.
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([idle, loopIdle, queued, subagents]);
  });

  test("the newest frame replaces the one before it", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, busy, 1);
    cache.noteFrame(SCOPE, idle, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([idle]);
  });

  test("a different cwd is a different runtime", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    expect(cache.replayFor(SCOPE, "/elsewhere", 1)).toBeNull();
  });

  test("a start from another connection is not this connection's answer", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    expect(cache.replayFor(SCOPE, CWD, 2)).toBeNull();
  });

  test("an idle conversation stays answerable however long it has been quiet", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    t.advance(STALE_AFTER_MS * 10);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([idle]);
  });

  test("a busy conversation that has gone silent is a claim, not an observation", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, busy, 1);
    t.advance(STALE_AFTER_MS + 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
    // Inside the window the frame is still what the app-server last said.
    cache.noteFrame(SCOPE, busy, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([busy]);
  });

  test("a loop claiming work counts as busy, not only a device status", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    cache.noteFrame(SCOPE, loopBusy, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([idle, loopBusy]);
    t.advance(STALE_AFTER_MS + 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("a loop back at the input prompt is idle", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, loopIdle, 1);
    t.advance(STALE_AFTER_MS * 3);
    expect(cache.replayFor(SCOPE, CWD, 1)).toEqual([loopIdle]);
  });

  test("an approval waiting on a human makes the conversation unanswerable", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, busy, 1);
    // The replay a skipped start would have re-emitted the approval card, so the
    // answer goes back to the app-server until the next start re-remembers it.
    cache.askApproval(SCOPE);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
    cache.remember(SCOPE, CWD, 1);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("a turn that ended forgets the conversation", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    cache.forget(SCOPE);
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });

  test("a reconnect forgets every conversation: the server may have restarted", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(SCOPE, idle, 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("only the live-state frames are kept", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, CWD, 1);
    cache.noteFrame(
      SCOPE,
      {
        type: "assistant_turn_message",
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      } as never,
      1,
    );
    expect(cache.replayFor(SCOPE, CWD, 1)).toBeNull();
  });
});
