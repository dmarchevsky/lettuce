import { describe, expect, test } from "bun:test";
import {
  contextGauge,
  formatTokens,
  gaugeWidth,
  percentOf,
  pickTurnUsage,
  readTurnUsage,
} from "./usage.ts";

const served = {
  promptTokens: 790,
  cachedTokens: 84_000,
  lastPromptTokens: 84_790,
  lastCachedTokens: 84_000,
  cacheReported: true,
  completionTokens: 548,
  reasoningTokens: 18,
  steps: 1,
  contextTokens: 85_198,
};

describe("readTurnUsage", () => {
  test("reads the BFF's shape", () => {
    expect(readTurnUsage({ ...served, turn_id: "t1", at: "x" })).toEqual(served);
  });

  test("defaults the optional parts and rejects non-usage", () => {
    expect(readTurnUsage({ promptTokens: 5, completionTokens: 1 })).toEqual({
      promptTokens: 5,
      cachedTokens: 0,
      lastPromptTokens: 0,
      lastCachedTokens: 0,
      cacheReported: false,
      completionTokens: 1,
      reasoningTokens: 0,
      steps: 1,
    });
    expect(readTurnUsage({ promptTokens: "x" })).toBeNull();
    expect(readTurnUsage(null)).toBeNull();
  });
});

describe("pickTurnUsage", () => {
  test("the turn in flight wins over the last finished one", () => {
    const last = { ...served, steps: 3 };
    expect(pickTurnUsage({ last, current: served })).toEqual(served);
    expect(pickTurnUsage({ last, current: null })).toEqual(last);
    expect(pickTurnUsage({})).toBeNull();
    expect(pickTurnUsage(null)).toBeNull();
  });

  test("percentOf", () => {
    expect(percentOf(84_000, 84_790)).toBe(99);
    expect(percentOf(1, 0)).toBe(0);
  });
});

describe("contextGauge", () => {
  test("label, percent, and the amber threshold", () => {
    expect(contextGauge(25461, 128000)).toEqual({
      label: "25k / 128k",
      percent: 20,
      warn: false,
      over: false,
      overBy: 0,
    });
    expect(contextGauge(108000, 128000)).toMatchObject({ percent: 84, warn: true, over: false });
    expect(contextGauge(10, 0).percent).toBe(0);
    expect(gaugeWidth(contextGauge(234979, 225280))).toBe(100);
  });

  test("past the point it says so, and amber is not enough", () => {
    // A full amber bar is what a conversation at its compaction point looked
    // exactly like before, so the over could only be read off the numbers.
    expect(contextGauge(234979, 225280)).toEqual({
      label: "235k / 225k over",
      percent: 104,
      warn: false,
      over: true,
      overBy: 9699,
    });
  });

  test("exactly at the point is not over", () => {
    expect(contextGauge(225280, 225280)).toMatchObject({ over: false, warn: true, percent: 100 });
    // Past it, the honest number survives: rounding it to 100 is what made the
    // two states indistinguishable.
  });

  test("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});
