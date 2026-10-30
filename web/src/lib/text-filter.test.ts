import { describe, expect, test } from "bun:test";
import { matchesQuery } from "./text-filter.ts";

describe("matchesQuery", () => {
  const label = "Anthropic: Claude Opus 4.5 openrouter/anthropic/claude-opus-4.5";

  test("an empty or blank query matches everything", () => {
    expect(matchesQuery(label, "")).toBe(true);
    expect(matchesQuery(label, "   ")).toBe(true);
  });

  test("one word is a plain substring match", () => {
    expect(matchesQuery(label, "opus")).toBe(true);
    expect(matchesQuery(label, "sonnet")).toBe(false);
  });

  test("every word has to appear, in any order", () => {
    // A substring match fails "claude 4.5": the title has "Opus" between them.
    expect(matchesQuery(label, "claude 4.5")).toBe(true);
    expect(matchesQuery(label, "4.5 opus")).toBe(true);
    expect(matchesQuery(label, "opus 4.6")).toBe(false);
  });

  test("case and extra whitespace do not matter", () => {
    expect(matchesQuery(label, "  OPUS   Anthropic ")).toBe(true);
  });
});
