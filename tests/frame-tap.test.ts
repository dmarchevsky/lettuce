/**
 * The turn driver's deciding logic, offline.
 *
 * `newestReply` is pinned because it was wrong in the shape of a plausible
 * answer: `conversation_messages_list` answers newest-first (verified live
 * against a running app-server), and the first version walked the page keeping
 * the last match, so `driveTurn` handed back the OLDEST assistant message in the
 * conversation. Every test here says "newest", and one of them would have caught
 * it — a test that only checked "an assistant reply came back" passed.
 */
import { describe, expect, test } from "bun:test";
import { newestReply } from "../scripts/frame-tap.ts";

const NOW = Date.parse("2026-03-04T12:00:00Z");
const BEFORE = NOW - 60_000;
const AFTER = NOW + 5_000;

/** An assistant message as the endpoint stores it, at a given instant. */
const msg = (text: string, date?: string, extra: Record<string, unknown> = {}) => ({
  message_type: "assistant_message",
  date,
  content: text,
  ...extra,
});

describe("newestReply", () => {
  test("the newest assistant message wins, not the last one on the page", () => {
    // Newest-first page order, as verified live: the newest text is at index 0.
    const messages = [
      msg("newest", new Date(AFTER).toISOString()),
      msg("oldest", new Date(BEFORE).toISOString()),
    ];
    expect(newestReply(messages, NOW)).toBe("newest");
  });

  test("a page ordered oldest-first gives the same answer", () => {
    // The rule is the timestamp, not the order, so an endpoint that changed its
    // pagination could not silently flip the answer again.
    const messages = [
      msg("oldest", new Date(BEFORE).toISOString()),
      msg("newest", new Date(AFTER).toISOString()),
    ];
    expect(newestReply(messages, NOW)).toBe("newest");
  });

  test("an assistant message from before the prompt is not this turn's reply", () => {
    // The `--conversation <existing>` case: the conversation has history, and
    // quoting last week's message as the reply is worse than saying nothing.
    const messages = [msg("last week", new Date(NOW - 7 * 86_400_000).toISOString())];
    expect(newestReply(messages, NOW)).toBeNull();
  });

  test("a message dated a little before the prompt survives clock skew", () => {
    const messages = [msg("this turn", new Date(NOW - 3_000).toISOString())];
    expect(newestReply(messages, NOW)).toBe("this turn");
  });

  test("undated messages are kept, and dated ones outrank them", () => {
    const undated = [msg("first undated"), msg("second undated")];
    expect(newestReply(undated, NOW)).toBe("first undated");
    const mixed = [msg("undated"), msg("dated", new Date(AFTER).toISOString())];
    expect(newestReply(mixed, NOW)).toBe("dated");
  });

  test("only assistant text counts, and empty text is skipped", () => {
    const messages = [
      {
        message_type: "tool_return_message",
        date: new Date(AFTER).toISOString(),
        tool_return: "x",
      },
      msg("   ", new Date(AFTER).toISOString()),
      msg("real answer", new Date(AFTER).toISOString()),
      msg("older answer", new Date(BEFORE).toISOString()),
    ];
    expect(newestReply(messages, NOW)).toBe("real answer");
  });

  test("content parts are joined the way the web client joins them", () => {
    const messages = [
      {
        message_type: "assistant_message",
        date: new Date(AFTER).toISOString(),
        content: [{ type: "text", text: "pong" }, { type: "image" }, { type: "text", text: "!" }],
      },
    ];
    expect(newestReply(messages, NOW)).toBe("pong!");
  });
});
