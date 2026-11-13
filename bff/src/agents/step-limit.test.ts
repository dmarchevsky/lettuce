import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStepLimitStore, parseStepLimit } from "./step-limit.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "step-limit-")), "agent-step-limits.json");

describe("parseStepLimit", () => {
  test("accepts a positive integer or null, nothing else", () => {
    expect(parseStepLimit(12)).toBe(12);
    expect(parseStepLimit(null)).toBeNull();
    for (const bad of [0, -1, 1.5, "12", undefined, Number.NaN, 2 ** 60, {}]) {
      expect(parseStepLimit(bad)).toBeUndefined();
    }
  });
});

describe("AgentStepLimitStore", () => {
  test("an unknown agent has no limit", () => {
    expect(new AgentStepLimitStore(fileIn(), () => {}).get("agent-a")).toBeNull();
  });

  test("stores only agents with a limit, and survives a restart", async () => {
    const file = fileIn();
    const store = new AgentStepLimitStore(file, () => {});
    expect(store.set("agent-a", 20)).toBe(true);
    expect(store.set("agent-a", 20)).toBe(false);
    expect(store.set("agent-b", 5)).toBe(true);
    expect(store.set("agent-b", null)).toBe(true);
    expect(store.set("agent-b", null)).toBe(false);
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "agent-a": 20 });
    const reloaded = new AgentStepLimitStore(file, () => {});
    expect(reloaded.get("agent-a")).toBe(20);
    expect(reloaded.get("agent-b")).toBeNull();
  });

  test("refuses a limit that is not a positive integer", () => {
    const store = new AgentStepLimitStore(fileIn(), () => {});
    expect(() => store.set("agent-a", 0)).toThrow();
    expect(() => store.set("agent-a", 2.5)).toThrow();
    expect(() => store.set("not an id", 3)).toThrow();
  });

  test("an unreadable file means no limits, and bad entries are dropped", () => {
    const broken = fileIn();
    writeFileSync(broken, "{not json");
    expect(new AgentStepLimitStore(broken, () => {}).get("agent-a")).toBeNull();

    const mixed = fileIn();
    writeFileSync(mixed, JSON.stringify({ "agent-a": 7, "agent-b": 0, "agent-c": "9" }));
    const store = new AgentStepLimitStore(mixed, () => {});
    expect(store.get("agent-a")).toBe(7);
    expect(store.get("agent-b")).toBeNull();
    expect(store.get("agent-c")).toBeNull();
  });
});
