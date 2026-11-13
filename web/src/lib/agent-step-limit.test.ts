import { describe, expect, test } from "bun:test";
import { parseStepLimitInput } from "./agent-step-limit.ts";

describe("parseStepLimitInput", () => {
  test("empty is no limit", () => {
    expect(parseStepLimitInput("")).toBeNull();
    expect(parseStepLimitInput("  ")).toBeNull();
  });

  test("a positive whole number is that limit", () => {
    expect(parseStepLimitInput("25")).toBe(25);
    expect(parseStepLimitInput(" 3 ")).toBe(3);
  });

  test("anything else is not a value Save may send", () => {
    for (const bad of ["0", "-2", "1.5", "1e3", "ten", "99999999999999999999"]) {
      expect(parseStepLimitInput(bad)).toBeUndefined();
    }
  });
});
