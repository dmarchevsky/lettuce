import { describe, expect, test } from "bun:test";
import { AGENT_FACTS_MAX, AGENT_FACTS_TTL_MS, AgentFacts } from "./facts.ts";

const clock = () => {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

const facts = (name: string, tags: string[]) => ({ name, tags });

describe("AgentFacts", () => {
  test("lookups made close together share one retrieval", async () => {
    // The whole point: a subagent that both triggered a push and reached for a
    // coding worker used to be retrieved twice, once per caller.
    let calls = 0;
    const time = clock();
    const cache = new AgentFacts(async (id) => {
      calls += 1;
      return facts(`Agent ${id}`, ["production"]);
    }, time.now);

    expect(await cache.get("a1")).toEqual(facts("Agent a1", ["production"]));
    expect(await cache.get("a1")).toEqual(facts("Agent a1", ["production"]));
    expect(calls).toBe(1);
  });

  test("an agent retrieved again after the window is retrieved again", async () => {
    let calls = 0;
    const time = clock();
    const cache = new AgentFacts(async (id) => {
      calls += 1;
      return facts(`Agent ${id}`, []);
    }, time.now);

    await cache.get("a1");
    time.advance(AGENT_FACTS_TTL_MS + 1);
    await cache.get("a1");
    expect(calls).toBe(2);
  });

  test("the cache has a ceiling, and the least recent agent pays for it", async () => {
    // Every subagent mints a new id, so an unbounded map here is unbounded for
    // the life of a BFF meant to run for weeks.
    const seen: string[] = [];
    const cache = new AgentFacts(async (id) => {
      seen.push(id);
      return facts(id, []);
    });

    for (let i = 0; i < AGENT_FACTS_MAX + 5; i += 1) await cache.get(`agent-${i}`);
    expect(seen.length).toBe(AGENT_FACTS_MAX + 5);
    // The first five have been pushed out; the newest are still held.
    expect(await cache.get("agent-0")).toEqual(facts("agent-0", []));
    expect(seen.length).toBe(AGENT_FACTS_MAX + 6);
  });
});
