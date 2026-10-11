import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { scopeKeyOf } from "./buffer.ts";
import type { TurnUsageRecord } from "./turn-usage.ts";
import { addUsage, readUsageStatistics, TURN_USAGE_SCOPES, TurnUsageLog } from "./turn-usage.ts";

const runtime = (conversationId = "conv-1") => ({
  agent_id: "agent-1",
  conversation_id: conversationId,
});

function step(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "stream_delta",
    runtime: runtime(),
    delta: { message_type: "usage_statistics", ...fields },
    ...extra,
  } as unknown as WsProtocolMessage;
}

function finished(conversationId = "conv-1", usage?: Record<string, unknown>) {
  return {
    type: "turn_finished",
    turn_id: "t1",
    stop_reason: "end_turn",
    runtime: runtime(conversationId),
    ...(usage ? { usage } : {}),
  } as unknown as WsProtocolMessage;
}

const key = scopeKeyOf("agent-1", "conv-1");

describe("readUsageStatistics", () => {
  test("splits the prompt into evaluated and cached, as pi-ai reports it", () => {
    expect(
      readUsageStatistics({
        message_type: "usage_statistics",
        prompt_tokens: 790,
        cached_input_tokens: 84_000,
        cache_write_tokens: 0,
        completion_tokens: 548,
        reasoning_tokens: 18,
        context_tokens: 85_198,
      }),
    ).toEqual({
      promptTokens: 790,
      cachedTokens: 84_000,
      lastPromptTokens: 84_790,
      lastCachedTokens: 84_000,
      cacheReported: true,
      completionTokens: 548,
      reasoningTokens: 18,
      steps: 1,
      contextTokens: 85_198,
    });
  });

  test("cache writes count as evaluated; no cache fields means not reported", () => {
    expect(readUsageStatistics({ prompt_tokens: 10, cache_write_tokens: 5 })).toMatchObject({
      promptTokens: 15,
      lastPromptTokens: 15,
      cacheReported: true,
    });
    expect(readUsageStatistics({ prompt_tokens: "x" })).toMatchObject({
      promptTokens: 0,
      cacheReported: false,
    });
    expect(readUsageStatistics(null)).toBeNull();
  });
});

describe("addUsage", () => {
  test("sums across steps; the last prompt and the context level are the latest", () => {
    const a = readUsageStatistics({
      prompt_tokens: 117_000,
      cached_input_tokens: 0,
      completion_tokens: 100,
      context_tokens: 117_100,
    });
    const b = readUsageStatistics({ prompt_tokens: 1369, cached_input_tokens: 117_100 });
    expect(addUsage(addUsage(null, a!), b!)).toEqual({
      promptTokens: 118_369,
      cachedTokens: 117_100,
      lastPromptTokens: 118_469,
      lastCachedTokens: 117_100,
      cacheReported: true,
      completionTokens: 100,
      reasoningTokens: 0,
      steps: 2,
      contextTokens: 117_100,
    });
  });
});

describe("TurnUsageLog", () => {
  test("folds a turn's steps and keeps it as the last turn when it finishes", () => {
    const log = new TurnUsageLog(() => new Date("2026-09-28T17:54:00.000Z"));
    log.observe(step({ prompt_tokens: 100, cached_input_tokens: 0, context_tokens: 120 }));
    expect(log.get(key).current).toMatchObject({ steps: 1, promptTokens: 100 });

    log.observe(step({ prompt_tokens: 20, cached_input_tokens: 100, context_tokens: 150 }));
    log.observe(finished());

    expect(log.get(key)).toEqual({
      current: null,
      last: expect.objectContaining({
        steps: 2,
        promptTokens: 120,
        cachedTokens: 100,
        lastPromptTokens: 120,
        contextTokens: 150,
        turn_id: "t1",
        at: "2026-09-28T17:54:00.000Z",
      }),
    });
  });

  test("skips subagent deltas and other frames", () => {
    const log = new TurnUsageLog();
    log.observe(step({ prompt_tokens: 5 }, { subagent_id: "sub-1" }));
    log.observe({
      type: "stream_delta",
      runtime: runtime(),
      delta: { message_type: "assistant_message" },
    } as unknown as WsProtocolMessage);
    expect(log.get(key)).toEqual({ last: null, current: null });
  });

  test("a turn with no usage keeps the previous last turn", () => {
    const log = new TurnUsageLog();
    log.observe(step({ prompt_tokens: 5 }));
    log.observe(finished());
    log.observe(finished());
    expect(log.get(key).last?.promptTokens).toBe(5);
  });

  test("turn_finished.usage is the authoritative total; the last step comes from the fold", () => {
    const log = new TurnUsageLog();
    log.observe(step({ prompt_tokens: 3, cached_input_tokens: 7 }));
    log.observe(finished("conv-1", { prompt_tokens: 50, step_count: 4, context_tokens: 999 }));
    expect(log.get(key).last).toMatchObject({
      promptTokens: 50,
      steps: 4,
      lastPromptTokens: 10,
      lastCachedTokens: 7,
      cacheReported: true,
      contextTokens: 999,
    });
  });

  test("evicts the least recently active conversation", () => {
    const log = new TurnUsageLog();
    for (let i = 0; i <= TURN_USAGE_SCOPES; i++) {
      log.observe({
        type: "stream_delta",
        runtime: runtime(`c${i}`),
        delta: { message_type: "usage_statistics", prompt_tokens: 1 },
      } as unknown as WsProtocolMessage);
    }
    expect(log.get(scopeKeyOf("agent-1", "c0")).current).toBeNull();
    expect(log.get(scopeKeyOf("agent-1", `c${TURN_USAGE_SCOPES}`)).current).not.toBeNull();
  });
});

describe("compaction and the gauge", () => {
  /** A stream delta of one of the shapes that mean "the conversation just got shorter". */
  function notice(delta: Record<string, unknown>) {
    return {
      type: "stream_delta",
      runtime: runtime(),
      delta,
    } as unknown as WsProtocolMessage;
  }

  function filled() {
    const log = new TurnUsageLog();
    log.observe(step({ prompt_tokens: 10, context_tokens: 111_000 }));
    log.observe(finished());
    return log;
  }

  test("an auto-compaction empties the occupancy rather than restating it", () => {
    const log = filled();
    expect(log.get(key).last?.contextTokens).toBe(111_000);
    log.observe(notice({ message_type: "event_message", event_type: "compaction" }));
    // The stats count the history without the system prompt or tool schemas, so
    // adopting them would draw a gauge emptier than the next request. Unknown
    // is the honest reading until the next step reports the real number.
    expect(log.get(key).last?.contextTokens).toBeUndefined();
    expect(log.get(key).last?.promptTokens).toBe(10);
    log.observe(notice({ message_type: "summary_message", summary: "…", compaction_stats: {} }));
    expect(log.get(key).last?.contextTokens).toBeUndefined();
  });

  test("a manual /compact empties it too — the command's own delta is the only trace", () => {
    const log = filled();
    log.observe(notice({ message_type: "slash_command_end", command_id: "compact" }));
    expect(log.get(key).last?.contextTokens).toBeUndefined();
  });

  test("an unrelated command leaves the gauge alone", () => {
    const log = filled();
    log.observe(notice({ message_type: "slash_command_end", command_id: "context-limit" }));
    expect(log.get(key).last?.contextTokens).toBe(111_000);
  });

  test("the last finished turn survives a restart", () => {
    let saved: Record<string, TurnUsageRecord> = {};
    const disk = {
      load: () => saved,
      save: (records: Record<string, TurnUsageRecord>) => {
        saved = records;
      },
    };
    const first = new TurnUsageLog(() => new Date(), disk);
    first.observe(step({ prompt_tokens: 10, context_tokens: 111_000 }));
    first.observe(finished());

    const restarted = new TurnUsageLog(() => new Date(), disk);
    expect(restarted.get(key).last).toMatchObject({ promptTokens: 10, contextTokens: 111_000 });
    expect(restarted.get(key).current).toBeNull();
  });
});
