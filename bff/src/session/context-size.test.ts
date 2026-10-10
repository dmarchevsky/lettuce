import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accounting,
  agentModelHandle,
  ContextSizer,
  ContextSizeStore,
  compactAt,
  contextBudget,
  harnessWindow,
  type ModelWindowCaps,
  type SizerUpstream,
  upstreamThreshold,
} from "./context-size.ts";
import { effectiveContextLimit } from "./context-watchdog.ts";

describe("contextBudget and compactAt", () => {
  test("the output budget is what a request promises, plus room for the summary", () => {
    expect(contextBudget(32_768)).toBe(36_864);
    expect(compactAt(262_144, 32_768)).toBe(225_280);
  });

  test("a small output budget never beats letta-code's own reserve", () => {
    expect(contextBudget(4_096)).toBe(16_384);
    expect(contextBudget(null)).toBe(16_384);
    expect(compactAt(128_000, null)).toBe(111_616);
  });
});

describe("harnessWindow", () => {
  test("letta-code's own threshold lands exactly on the compact point", () => {
    for (const [context, maxOutput] of [
      [262_144, 32_768],
      [131_072, 32_768],
      [128_000, null],
      [64_000, 4_096],
      [30_000, null],
    ] as const) {
      const window = harnessWindow(context, maxOutput);
      expect(upstreamThreshold(window)).toBe(compactAt(context, maxOutput));
      expect(window).toBeLessThanOrEqual(context);
    }
  });

  test("the window stays under both the context and the refusal point", () => {
    // The whole point: a request at the compact point still fits, with the
    // summariser's own reply accounted for.
    const at = compactAt(131_072, 32_768);
    expect(at + 32_768).toBeLessThan(131_072);
  });

  test("a size that cannot hold the model's own output keeps its own window", () => {
    // Nothing compactible is left to aim at, so the least-wrong window is the
    // size itself — never 0, which is what the arithmetic alone produces.
    expect(harnessWindow(30_000, 32_768)).toBe(30_000);
    expect(harnessWindow(32_000, 32_768)).toBe(32_000);
    expect(harnessWindow(36_864, 32_768)).toBe(36_864);
    expect(compactAt(30_000, 32_768)).toBe(0);
  });
});

describe("accounting", () => {
  const declared = { contextWindow: 262_144, maxTokens: 32_768 };

  test("a declaration drives everything and says so", () => {
    const a = accounting({ limit: 241_664, typedAgent: null, typedConversation: null, declared });
    expect(a).toMatchObject({
      context: 262_144,
      source: "declared",
      maxOutput: 32_768,
      compactAt: 225_280,
      window: 241_664,
    });
    // Present even with nothing typed: the editor offers "back to the declared
    // size" as a preset, which needs to know what that size is.
    expect(a.automatic).toEqual({ context: 262_144, compactAt: 225_280 });
  });

  test("a typed size wins and shows what automatic would have been", () => {
    const a = accounting({
      limit: 241_664,
      typedAgent: 131_072,
      typedConversation: null,
      declared,
    });
    expect(a).toMatchObject({
      context: 131_072,
      source: "typed",
      compactAt: 94_208,
    });
    expect(a.automatic).toEqual({ context: 262_144, compactAt: 225_280 });
    expect(a.window).toBe(harnessWindow(131_072, 32_768));
  });

  test("a conversation's own size beats the agent's", () => {
    const a = accounting({
      limit: 241_664,
      typedAgent: 131_072,
      typedConversation: 65_536,
      declared,
    });
    expect(a.context).toBe(65_536);
  });

  test("with nothing declared, the window in force is the only claim", () => {
    const a = accounting({
      limit: 128_000,
      typedAgent: null,
      typedConversation: null,
      declared: null,
    });
    expect(a).toMatchObject({ context: 128_000, source: "default", maxOutput: null });
    expect(a.compactAt).toBe(upstreamThreshold(128_000));
    expect(a.window).toBe(128_000);
  });
});

describe("agent reads", () => {
  test("the model handle is the agent's own, else the LLM config's", () => {
    expect(agentModelHandle({ model: "openai-compatible/GLM-4.7-Flash" })).toBe(
      "openai-compatible/GLM-4.7-Flash",
    );
    expect(agentModelHandle({ llm_config: { provider: "openai", model: "gpt" } })).toBe(
      "openai/gpt",
    );
    expect(agentModelHandle({})).toBeNull();
  });

  test("the window is the model setting, falling back to letta-code's default", () => {
    expect(effectiveContextLimit({ model_settings: { context_window_limit: 241_664 } }, null)).toBe(
      241_664,
    );
    expect(effectiveContextLimit({}, null)).toBe(128_000);
  });
});

describe("ContextSizer", () => {
  const declared = { contextWindow: 262_144, maxTokens: 32_768 };

  function harness(
    agents: unknown[],
    caps: Record<string, ModelWindowCaps> = { "model/x": declared },
  ) {
    const written: string[] = [];
    const upstream = {
      isReady: () => true,
      async request(command: Record<string, unknown>) {
        if (command.type === "agent_list") return { success: true, agents };
        written.push(`${(command.runtime as { agent_id: string }).agent_id} ${command.args}`);
        return { success: true, output: "ok" };
      },
    } as unknown as SizerUpstream;
    const dir = mkdtempSync(join(tmpdir(), "context-sizer-"));
    const store = new ContextSizeStore(join(dir, "sizes.json"));
    return {
      store,
      written,
      sizer: new ContextSizer({ upstream, caps: () => caps, log: () => {} }, store),
    };
  }

  const agent = (window: number | undefined) => ({
    id: "a1",
    model: "model/x",
    ...(window ? { model_settings: { context_window_limit: window } } : {}),
  });

  test("an agent left at its model's declaration is retuned to the derived window", async () => {
    const h = harness([agent(declared.contextWindow)]);
    expect(await h.sizer.applyAll()).toContain("1 agent(s)");
    expect(h.written).toEqual(["a1 241664 --override"]);
  });

  test("letta-code's own default is not mistaken for a size the operator set", async () => {
    const h = harness([agent(undefined)]);
    await h.sizer.applyAll();
    expect(h.written).toEqual(["a1 241664 --override"]);
  });

  test("a window set by hand is adopted as that size and retuned to it", async () => {
    // The server really serves less than the model claims; overwriting 131 072
    // with the declaration's window is how a working agent gets every request
    // refused. Once adopted, the window follows the size it now knows — in the
    // same pass, so the sheet never shows a point upstream will not honour.
    const h = harness([agent(131_072)]);
    await h.sizer.applyAll();
    expect(h.store.get("agent:a1")).toBe(131_072);
    expect(h.written).toEqual(["a1 110592 --override"]);
  });

  test("a caps edit retunes our own window instead of adopting it", async () => {
    // 241 664 is what the older, larger declaration produced. The caps save owns
    // that value: it must move it, not freeze it as the operator's choice.
    const h = harness([agent(241_664)], {
      "model/x": { contextWindow: 131_072, maxTokens: 32_768 },
    });
    await h.sizer.applyHandle("model/x");
    expect(h.store.get("agent:a1")).toBeNull();
    expect(h.written).toEqual(["a1 110592 --override"]);
  });

  test("an agent whose model declares nothing is left alone", async () => {
    const h = harness([{ id: "a1", model: "other/y" }]);
    expect(await h.sizer.applyAll()).toContain("0 agent(s)");
    expect(h.written).toEqual([]);
  });
});

describe("ContextSizeStore", () => {
  test("round-trips through the file, and null clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-size-"));
    const file = join(dir, "context-size.json");
    const store = new ContextSizeStore(file);
    store.set("agent:a1", 131_072);
    store.set("conv:c1", 65_536);
    expect(new ContextSizeStore(file).all()).toEqual({ "agent:a1": 131_072, "conv:c1": 65_536 });
    store.set("agent:a1", null);
    expect(store.get("agent:a1")).toBeNull();
    expect(new ContextSizeStore(file).get("conv:c1")).toBe(65_536);
    // An unreadable file is nothing typed, not a crash at boot.
    writeFileSync(file, "{ nope");
    expect(new ContextSizeStore(file).all()).toEqual({});
  });
});
