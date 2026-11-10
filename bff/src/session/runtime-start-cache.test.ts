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

describe("startScopeOf", () => {
  test("a plain open is answerable, at its cwd", () => {
    expect(scope).toEqual({ scopeKey: SCOPE, cwd: "/work/agent-1" });
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

/** A clock the test turns, because staleness is about a minute of silence. */
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

describe("RuntimeStartCache", () => {
  test("an unseen conversation is not answerable", () => {
    expect(new RuntimeStartCache().replayFor(SCOPE, "/work/agent-1", 1)).toBeNull();
  });

  test("a started runtime with nothing routed yet says nothing about live state", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toBeNull();
  });

  test("a remembered start replays the newest live state it has", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, busy);
    cache.noteFrame(SCOPE, queued);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toEqual([busy, queued]);
  });

  test("the newest frame replaces the one before it", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, busy);
    cache.noteFrame(SCOPE, idle);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toEqual([idle]);
  });

  test("a different cwd is a different runtime", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, idle);
    expect(cache.replayFor(SCOPE, "/elsewhere", 1)).toBeNull();
  });

  test("a start from another connection is not this connection's answer", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, idle);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 2)).toBeNull();
  });

  test("an idle conversation stays answerable however long it has been quiet", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, idle);
    t.advance(STALE_AFTER_MS * 10);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toEqual([idle]);
  });

  test("a busy conversation that has gone silent is a claim, not an observation", () => {
    const t = clock();
    const cache = new RuntimeStartCache(t.now);
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, busy);
    t.advance(STALE_AFTER_MS + 1);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toBeNull();
    // Inside the window the frame is still what the app-server last said.
    cache.noteFrame(SCOPE, busy);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toEqual([busy]);
  });

  test("a failed turn forgets the conversation", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, idle);
    cache.forget(SCOPE);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toBeNull();
  });

  test("a reconnect forgets every conversation: the server may have restarted", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, idle);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("only the live-state frames are kept", () => {
    const cache = new RuntimeStartCache();
    cache.remember(SCOPE, "/work/agent-1", 1);
    cache.noteFrame(SCOPE, {
      type: "assistant_turn_message",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    } as never);
    expect(cache.replayFor(SCOPE, "/work/agent-1", 1)).toBeNull();
  });
});
