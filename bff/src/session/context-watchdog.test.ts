import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  ContextWatchdog,
  conversationOwnWindow,
  effectiveContextLimit,
  isContextExhaustionError,
  type WatchdogUpstream,
} from "./context-watchdog.ts";
import type { TurnUsageLog } from "./turn-usage.ts";

interface FakeUpstream {
  /** Conversation ids the watchdog compacted, in order. */
  compacted: string[];
  upstream: WatchdogUpstream;
}

function fakeUpstream(limitTokens: number | null = 128_000): FakeUpstream {
  const compacted: string[] = [];
  const request = async (command: any): Promise<any> => {
    if (command.type === "agent_retrieve") {
      return {
        type: "agent_retrieve_response",
        request_id: command.request_id,
        success: true,
        agent: limitTokens ? { model_settings: { context_window_limit: limitTokens } } : {},
      };
    }
    if (command.type === "conversation_retrieve") {
      return {
        type: "conversation_retrieve_response",
        request_id: command.request_id,
        success: true,
        conversation: {},
      };
    }
    if (command.type === "conversation_compact") {
      compacted.push(String(command.conversation_id));
      return {
        type: "conversation_compact_response",
        request_id: command.request_id,
        success: true,
        compaction: null,
      };
    }
    throw new Error(`unexpected command ${command.type}`);
  };
  return { compacted, upstream: { request, isReady: () => true } as unknown as WatchdogUpstream };
}

/** A usage log whose last finished turn sat at `contextTokens`, and nothing else. */
function usageLog(contextTokens: number): TurnUsageLog {
  return {
    get: () => ({ last: { contextTokens }, current: null }),
    observe: () => {},
  } as unknown as TurnUsageLog;
}

function finished(error?: string): WsProtocolMessage {
  return {
    type: "turn_finished",
    turn_id: "t1",
    stop_reason: error ? "error" : "end_turn",
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    ...(error ? { error } : {}),
  } as unknown as WsProtocolMessage;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function watchdog(deps: {
  ratio: number;
  contextTokens: number;
  upstream: FakeUpstream;
  now?: () => number;
  compactPoint?: number | null;
}) {
  return new ContextWatchdog({
    ratio: deps.ratio,
    usage: usageLog(deps.contextTokens),
    upstream: deps.upstream.upstream,
    log: () => {},
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.compactPoint !== undefined ? { compactPoint: () => deps.compactPoint ?? null } : {}),
  });
}

describe("conversationOwnWindow / effectiveContextLimit", () => {
  const agent = { model_settings: { context_window_limit: 241_664 } };

  test("a nested-only window still reads, because the engine reads it", () => {
    // Upstream's `letta model set --conversation --model-settings` leaves the
    // top-level field absent (verified against a live app-server), so a reader
    // that stops at top level sees an unsized conversation and calls the agent's
    // window the conversation's — the shape where the sheet and the engine part.
    const conversation = { model_settings: { context_window_limit: 128_000 } };
    expect(conversationOwnWindow(conversation)).toBe(128_000);
    expect(effectiveContextLimit(agent, conversation)).toBe(128_000);
  });

  test("top level outranks nested, which is what makes the write converge", () => {
    // `/context-limit` writes the top-level field only. If nested outranked it,
    // every fix this flow performs would report a mismatch forever after.
    expect(conversationOwnWindow({ context_window_limit: 262_144 })).toBe(262_144);
    expect(
      conversationOwnWindow({
        context_window_limit: 108_288,
        model_settings: { context_window_limit: 128_000 },
      }),
    ).toBe(108_288);
  });

  test("no own window means the agent's, which is not a conversation scope", () => {
    expect(conversationOwnWindow({})).toBeNull();
    expect(conversationOwnWindow(null)).toBeNull();
    expect(effectiveContextLimit(agent, {})).toBe(241_664);
  });
});

describe("isContextExhaustionError", () => {
  test("catches how llama.cpp actually writes it", () => {
    // Upstream's own classifier wants "exceeds the context", which this is not.
    expect(
      isContextExhaustionError(
        '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it"}}',
      ),
    ).toBe(true);
    expect(isContextExhaustionError("Context length exceeded")).toBe(true);
    expect(isContextExhaustionError("prompt is too long: 130000 tokens")).toBe(true);
  });

  test("does not catch an unrelated failure", () => {
    expect(isContextExhaustionError("Upstream timed out after 600s")).toBe(false);
    expect(isContextExhaustionError("Invalid model handle")).toBe(false);
  });
});

describe("effectiveContextLimit", () => {
  test("conversation wins, then the agent, then letta-code's default", () => {
    const agent = { model_settings: { context_window_limit: 128_000 } };
    expect(effectiveContextLimit(agent, { context_window_limit: 262_144 })).toBe(262_144);
    expect(effectiveContextLimit(agent, {})).toBe(128_000);
    expect(effectiveContextLimit({}, null)).toBe(128_000);
  });
});

describe("ContextWatchdog", () => {
  test("an over-sized window cannot hide a full conversation from the ratio", async () => {
    // The exact arithmetic that let a conversation sit past its compaction point
    // unnoticed: 234 979 of an inflated 262 144 window is 89.7 %, under the 0.9
    // trigger — while the room it really had was 225 280. The window is a claim;
    // the compact point, once known, is the measurement.
    const upstream = fakeUpstream(262_144);
    watchdog({
      ratio: 0.9,
      contextTokens: 234_979,
      upstream,
      compactPoint: null,
    }).observe(finished());
    await settle();
    expect(upstream.compacted).toEqual([]);

    const withHonest = fakeUpstream(262_144);
    watchdog({
      ratio: 0.9,
      contextTokens: 234_979,
      upstream: withHonest,
      compactPoint: 225_280,
    }).observe(finished());
    await settle();
    expect(withHonest.compacted).toEqual(["conv-1"]);
  });

  test("a compact point larger than the window never loosens the trigger", async () => {
    // The smaller claim is the measure: a scope whose declaration promises more
    // room than its own window must not be told it has room it cannot use.
    // 120 000 of a 128 000 window compacts, whatever the compact point claims.
    const upstream = fakeUpstream(128_000);
    watchdog({
      ratio: 0.9,
      contextTokens: 120_000,
      upstream,
      compactPoint: 225_280,
    }).observe(finished());
    await settle();
    expect(upstream.compacted).toEqual(["conv-1"]);
  });

  test("compacts a conversation that filled its declared window", async () => {
    const upstream = fakeUpstream(128_000);
    watchdog({ ratio: 0.9, contextTokens: 120_000, upstream }).observe(finished());
    await settle();
    expect(upstream.compacted).toEqual(["conv-1"]);
  });

  test("leaves a conversation with room alone", async () => {
    const upstream = fakeUpstream(128_000);
    watchdog({ ratio: 0.9, contextTokens: 50_000, upstream }).observe(finished());
    await settle();
    expect(upstream.compacted).toEqual([]);
  });

  test("compacts after a provider refusal even when the ratio looks fine", async () => {
    const upstream = fakeUpstream(128_000);
    const log: string[] = [];
    new ContextWatchdog({
      ratio: 0.9,
      usage: usageLog(40_000),
      upstream: upstream.upstream,
      log: (message) => log.push(message),
    }).observe(finished("the request exceeds the available context size, try increasing it"));
    await settle();
    expect(upstream.compacted).toEqual(["conv-1"]);
    expect(log.join(" ")).toContain("provider refused");
  });

  test("gives one conversation one compaction per cooldown", async () => {
    const upstream = fakeUpstream(128_000);
    let now = 1_000;
    const watcher = watchdog({
      ratio: 0.9,
      contextTokens: 120_000,
      upstream,
      now: () => now,
    });
    watcher.observe(finished());
    await settle();
    watcher.observe(finished());
    await settle();
    expect(upstream.compacted).toEqual(["conv-1"]);
    now += 61_000;
    watcher.observe(finished());
    await settle();
    expect(upstream.compacted).toEqual(["conv-1", "conv-1"]);
  });

  test("ratio 0 switches it off entirely", async () => {
    const upstream = fakeUpstream(128_000);
    watchdog({ ratio: 0, contextTokens: 120_000, upstream }).observe(
      finished("context length exceeded"),
    );
    await settle();
    expect(upstream.compacted).toEqual([]);
  });
});
