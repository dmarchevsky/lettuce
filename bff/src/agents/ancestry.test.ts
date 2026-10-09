import { describe, expect, test } from "bun:test";
import { AgentAncestry, parentOf } from "./ancestry.ts";

const clock = () => {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe("AgentAncestry", () => {
  test("a plain agent is its own whole chain", async () => {
    const ancestry = new AgentAncestry(async () => ["production"]);
    expect(await ancestry.chain("agent-a")).toEqual(["agent-a"]);
  });

  test("the parent tags are walked upward, nearest first", async () => {
    const tags = new Map<string, string[]>([
      ["agent-sub", ["type:general-purpose", "parent:agent-a"]],
      ["agent-a", ["production"]],
    ]);
    const ancestry = new AgentAncestry(async (id) => tags.get(id) ?? []);
    expect(await ancestry.chain("agent-sub")).toEqual(["agent-sub", "agent-a"]);
  });

  test("a chain nests as deep as letta-code nests subagents", async () => {
    const tags = new Map<string, string[]>([
      ["c", ["parent:b"]],
      ["b", ["parent:a"]],
      ["a", ["production"]],
    ]);
    const ancestry = new AgentAncestry(async (id) => tags.get(id) ?? []);
    expect(await ancestry.chain("c")).toEqual(["c", "b", "a"]);
  });

  test("a tag pointing at nothing ends the chain, and an agent that cannot be retrieved does too", async () => {
    const ancestry = new AgentAncestry(async (id) => (id === "sub" ? ["parent:gone"] : []));
    expect(await ancestry.chain("sub")).toEqual(["sub", "gone"]);

    const failing = new AgentAncestry(async (id) => {
      if (id === "sub") return ["parent:agent-a"];
      throw new Error("no upstream");
    });
    expect(await failing.chain("sub")).toEqual(["sub", "agent-a"]);
  });

  test("a parent tag pointing back into the chain cannot loop", async () => {
    const tags = new Map<string, string[]>([
      ["a", ["parent:b"]],
      ["b", ["parent:a"]],
    ]);
    const ancestry = new AgentAncestry(async (id) => tags.get(id) ?? []);
    expect(await ancestry.chain("a")).toEqual(["a", "b"]);
  });

  test("a resolved chain is reused until the ttl passes", async () => {
    let lookups = 0;
    const time = clock();
    const ancestry = new AgentAncestry(async (id) => {
      lookups += 1;
      return id === "sub" ? ["parent:agent-a"] : [];
    }, time.now);
    await ancestry.chain("sub");
    await ancestry.chain("sub");
    expect(lookups).toBe(2);
    time.advance(11 * 60_000);
    await ancestry.chain("sub");
    expect(lookups).toBe(4);
  });
});

describe("parentOf", () => {
  test("only a non-empty parent tag counts", () => {
    expect(parentOf(["parent:agent-a"])).toBe("agent-a");
    expect(parentOf(["parent:", "type:recall"])).toBeNull();
    expect(parentOf(["production", "type:recall"])).toBeNull();
  });
});
