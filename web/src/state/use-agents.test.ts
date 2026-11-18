import { describe, expect, test } from "bun:test";
import {
  isSlidingWindowMode,
  parseSlidingWindowPercent,
  readCompactionSettings,
  readConversations,
} from "./use-agents.ts";

/**
 * `titled` is the rule that protects a manual rename from being overwritten by
 * auto-titling, so it is worth asserting directly rather than through the hook.
 */
describe("conversation titled flag", () => {
  const parse = (summary: unknown) =>
    readConversations({ conversations: [{ id: "c1", summary }] })[0]!;

  test("a null summary is untitled and shows the placeholder", () => {
    const c = parse(null);
    expect(c.titled).toBe(false);
    expect(c.summary).toBe("Untitled");
  });

  test("a missing summary is untitled", () => {
    expect(readConversations({ conversations: [{ id: "c1" }] })[0]!.titled).toBe(false);
  });

  test("a whitespace-only summary is untitled", () => {
    expect(parse("   ").titled).toBe(false);
  });

  test("a real summary is titled and kept verbatim", () => {
    const c = parse("CV summary rewrite");
    expect(c.titled).toBe(true);
    expect(c.summary).toBe("CV summary rewrite");
  });

  test('a conversation the user actually named "Untitled" is still titled', () => {
    // The case the flag exists for: without it, this would be re-titled.
    const c = parse("Untitled");
    expect(c.titled).toBe(true);
    expect(c.summary).toBe("Untitled");
  });
});

describe("agent compaction settings parsing", () => {
  test("a missing record shows the upstream defaults", () => {
    expect(readCompactionSettings(undefined)).toEqual({
      mode: "sliding_window",
      slidingWindowPercent: 30,
    });
  });

  test("a stored mode and fraction round-trip, the fraction as percent points", () => {
    expect(
      readCompactionSettings({ mode: "self_compact_all", sliding_window_percentage: 0.45 }),
    ).toEqual({ mode: "self_compact_all", slidingWindowPercent: 45 });
  });

  test("an unknown mode falls back to the default rather than rendering nothing", () => {
    expect(readCompactionSettings({ mode: "cloud_something" }).mode).toBe("sliding_window");
  });

  test("a fraction out of range falls back to the default percentage", () => {
    expect(readCompactionSettings({ sliding_window_percentage: 3 }).slidingWindowPercent).toBe(30);
    expect(readCompactionSettings({ sliding_window_percentage: -1 }).slidingWindowPercent).toBe(30);
  });

  test("only the sliding modes use the drop percentage", () => {
    expect(isSlidingWindowMode("sliding_window")).toBe(true);
    expect(isSlidingWindowMode("self_compact_sliding_window")).toBe(true);
    expect(isSlidingWindowMode("all")).toBe(false);
    expect(isSlidingWindowMode("self_compact_all")).toBe(false);
  });

  test("the drop-percent field saves only whole percents 1–100", () => {
    expect(parseSlidingWindowPercent("30")).toBe(30);
    expect(parseSlidingWindowPercent(" 40 ")).toBe(40);
    expect(parseSlidingWindowPercent("")).toBeUndefined();
    expect(parseSlidingWindowPercent("0")).toBeUndefined();
    expect(parseSlidingWindowPercent("101")).toBeUndefined();
    expect(parseSlidingWindowPercent("3.5")).toBeUndefined();
    expect(parseSlidingWindowPercent("-2")).toBeUndefined();
  });
});
