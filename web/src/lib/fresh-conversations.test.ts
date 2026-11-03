import { expect, test } from "bun:test";
import { consumeFreshConversation, markFreshConversation } from "./fresh-conversations.ts";

test("a marked conversation is fresh exactly once", () => {
  markFreshConversation("conv-fresh-1");
  expect(consumeFreshConversation("conv-fresh-1")).toBe(true);
  // The second start of the same conversation is an ordinary load: it may
  // hold anything, and the loading row must come back for it.
  expect(consumeFreshConversation("conv-fresh-1")).toBe(false);
});

test("an unmarked or absent id is never fresh", () => {
  expect(consumeFreshConversation("conv-never-marked")).toBe(false);
  expect(consumeFreshConversation(null)).toBe(false);
  expect(consumeFreshConversation(undefined)).toBe(false);
});
