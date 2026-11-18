import { describe, expect, test } from "bun:test";
import {
  buildCompactionRecord,
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
      source: {},
    });
  });

  test("a stored mode and fraction round-trip, the fraction as percent points", () => {
    const raw = { mode: "self_compact_all", sliding_window_percentage: 0.45 };
    expect(readCompactionSettings(raw)).toEqual({
      mode: "self_compact_all",
      slidingWindowPercent: 45,
      source: raw,
    });
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

  test("the drop-percent field saves only whole percents 1–80", () => {
    // 1–80, not 1–100: upstream's sliding planner throws once its eviction
    // fraction reaches 1.0, and the fallback for that error is a whole-transcript
    // `all` compaction — the opposite of what the sliding-mode caption promises.
    expect(parseSlidingWindowPercent("30")).toBe(30);
    expect(parseSlidingWindowPercent(" 40 ")).toBe(40);
    expect(parseSlidingWindowPercent("80")).toBe(80);
    expect(parseSlidingWindowPercent("")).toBeUndefined();
    expect(parseSlidingWindowPercent("0")).toBeUndefined();
    expect(parseSlidingWindowPercent("81")).toBeUndefined();
    expect(parseSlidingWindowPercent("101")).toBeUndefined();
    expect(parseSlidingWindowPercent("3.5")).toBeUndefined();
    expect(parseSlidingWindowPercent("-2")).toBeUndefined();
  });

  test("the written record carries the percent as a fraction over 100", () => {
    expect(
      buildCompactionRecord(
        {},
        { mode: "sliding_window", slidingWindowPercent: 45, percentEdited: true },
      ),
    ).toEqual({ mode: "sliding_window", sliding_window_percentage: 0.45 });
  });

  test("keys this UI does not own ride back through the record untouched", () => {
    // Upstream stores the written record in place of the old one; dropping these
    // would delete what upstream's own self-configuration skill wrote.
    const source = {
      mode: "sliding_window",
      sliding_window_percentage: 0.45,
      prompt: "a custom summariser prompt",
      clip_chars: 12000,
    };
    expect(
      buildCompactionRecord(source, {
        mode: "self_compact_all",
        slidingWindowPercent: 45,
        percentEdited: false,
      }),
    ).toEqual({
      mode: "self_compact_all",
      sliding_window_percentage: 0.45,
      prompt: "a custom summariser prompt",
      clip_chars: 12000,
    });
  });

  test("an untouched fraction passes through raw — no rounding rewrite", () => {
    // 0.125 shows as 13%; a mode-only Save must write 0.125 back, not 0.13.
    expect(
      buildCompactionRecord(
        { sliding_window_percentage: 0.125 },
        {
          mode: "all",
          slidingWindowPercent: 13,
          percentEdited: false,
        },
      ).sliding_window_percentage,
    ).toBe(0.125);
    // ...but an edited one is written as the new percent over 100.
    expect(
      buildCompactionRecord(
        { sliding_window_percentage: 0.125 },
        {
          mode: "all",
          slidingWindowPercent: 20,
          percentEdited: true,
        },
      ).sliding_window_percentage,
    ).toBe(0.2);
  });
});

// The second-Save sequencing that hid a real defect: the component must rebuild
// from the record it just wrote, or an untouched-percent Save reverts the
// fraction the previous Save stored.
test("a follow-up mode-only Save keeps the fraction the previous Save wrote", () => {
  const loaded = { mode: "sliding_window", sliding_window_percentage: 0.3 };
  const first = buildCompactionRecord(loaded, {
    mode: "sliding_window",
    slidingWindowPercent: 45,
    percentEdited: true,
  });
  expect(first.sliding_window_percentage).toBe(0.45);
  const second = buildCompactionRecord(first, {
    mode: "self_compact_all",
    slidingWindowPercent: 45,
    percentEdited: false,
  });
  expect(second).toEqual({ mode: "self_compact_all", sliding_window_percentage: 0.45 });
});
