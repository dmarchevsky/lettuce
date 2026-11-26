import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accounting,
  agentModelHandle,
  armedPastTheSlot,
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

describe("armedPastTheSlot", () => {
  test("a raw size written as a window compacts after the server has refused", () => {
    // The shape this exists for: the scope's window is the size itself, so
    // letta-code's own 16 384 reserve sits past the last prompt that fits.
    expect(armedPastTheSlot(262_144, 262_144, 32_768)).toBe(true);
    expect(upstreamThreshold(262_144)).toBe(245_760);
    expect(262_144 - 32_768).toBe(229_376);
  });

  test("the derived window is never armed late", () => {
    expect(armedPastTheSlot(harnessWindow(262_144, 32_768), 262_144, 32_768)).toBe(false);
    expect(armedPastTheSlot(harnessWindow(131_072, 8_192), 131_072, 8_192)).toBe(false);
  });

  test("a window that only understates the server is left alone", () => {
    // Compact-early is wasteful and never fatal; shrinking it further would cost
    // real context to fix a problem that cannot bite.
    expect(armedPastTheSlot(128_000, 262_144, 32_768)).toBe(false);
  });

  test("nothing to promise means nothing to check", () => {
    expect(armedPastTheSlot(262_144, 262_144, null)).toBe(false);
    expect(armedPastTheSlot(262_144, 262_144, 0)).toBe(false);
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
    expect(a.typedScope).toBeNull();
    expect(a.mismatch).toBeNull();
  });

  test("a window armed past the slot is reported as a mismatch, not hidden", () => {
    // The conversation carries its own raw size, so the window's own trigger is
    // past the wall. The sheet's denominator becomes the wall, because that is the
    // first thing that will stop it, and the mismatch says why the two disagree.
    const a = accounting({ limit: 262_144, typedAgent: null, typedConversation: null, declared });
    expect(a.mismatch).toEqual({
      window: 262_144,
      refusedAt: 229_376,
      engineAt: 245_760,
      armedLate: true,
    });
    expect(a.compactAt).toBe(229_376);
  });

  test("a window that only compacts early is a mismatch without the alarm", () => {
    // 107,520 is the derived window for a 128k conversation: its trigger lands
    // well below the wall, so it costs context and nothing else. Saying so is
    // honest; offering to fix it would grow a size nobody asked to grow.
    const a = accounting({ limit: 107_520, typedAgent: null, typedConversation: null, declared });
    expect(a.mismatch).toEqual({
      window: 107_520,
      refusedAt: 229_376,
      engineAt: 91_136,
      armedLate: false,
    });
    expect(a.compactAt).toBe(91_136);
  });

  test("the mismatch names the scope that has to be fixed", () => {
    const conv = accounting({
      limit: 262_144,
      typedAgent: null,
      typedConversation: 262_144,
      declared,
    });
    const agentScope = accounting({
      limit: 262_144,
      typedAgent: 262_144,
      typedConversation: null,
      declared,
    });
    expect(conv.typedScope).toBe("conversation");
    expect(agentScope.typedScope).toBe("agent");
  });

  test("a window no one derived is a mismatch even when it is harmless", () => {
    // 128 000 is neither the declaration nor the derived window, so the sheet's
    // numbers and the engine's do not describe the same window. It compacts early
    // rather than late, so it is said without alarm — but it is said.
    const a = accounting({ limit: 128_000, typedAgent: null, typedConversation: null, declared });
    expect(a.mismatch).toEqual({
      window: 128_000,
      refusedAt: 229_376,
      engineAt: 111_616,
      armedLate: false,
    });
    expect(a.compactAt).toBe(111_616);
  });

  test("a typed size wins and shows what automatic would have been", () => {
    const a = accounting({
      limit: harnessWindow(131_072, 32_768),
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

  test("one agent is sized from the answer the caller already holds", async () => {
    // The Context sheet already retrieved this agent to read its window, so
    // sizing it must not list every agent to learn the same thing — an empty
    // listing here is what proves no listing happened.
    const h = harness([]);
    expect(await h.sizer.ensure("a1", agent(declared.contextWindow))).toBe(true);
    expect(h.written).toEqual(["a1 241664 --override"]);
    // Nothing to size answers false, so the caller does not read the agent back.
    expect(await h.sizer.ensure("a9", { id: "a9", model: "other/y" })).toBe(false);
    // Someone else's retrieved agent is never used to size a different agent.
    expect(await h.sizer.ensure("b2", agent(declared.contextWindow))).toBe(false);
    expect(h.written).toEqual(["a1 241664 --override"]);
  });

  test("an agent whose model declares nothing is left alone", async () => {
    const h = harness([{ id: "a1", model: "other/y" }]);
    expect(await h.sizer.applyAll()).toContain("0 agent(s)");
    expect(h.written).toEqual([]);
  });
});

describe("ContextSizer, conversation scope", () => {
  const declared = { contextWindow: 262_144, maxTokens: 32_768 };

  /** A upstream that answers the two reads a conversation sizing needs and
   * records every `/context-limit` write by the scope it targeted. */
  function convHarness(opts: {
    agent?: Record<string, unknown> | null;
    conversation?: Record<string, unknown> | null;
    caps?: Record<string, ModelWindowCaps>;
  }) {
    const written: string[] = [];
    const upstream = {
      isReady: () => true,
      async request(command: Record<string, unknown>) {
        if (command.type === "agent_retrieve") {
          return { success: true, agent: opts.agent ?? null };
        }
        if (command.type === "conversation_retrieve") {
          return { success: true, conversation: opts.conversation ?? null };
        }
        const runtime = (command.runtime ?? {}) as {
          agent_id?: string;
          conversation_id?: string;
        };
        written.push(`${runtime.conversation_id ?? runtime.agent_id} ${command.args}`);
        return { success: true, output: "ok" };
      },
    } as unknown as SizerUpstream;
    const dir = mkdtempSync(join(tmpdir(), "context-sizer-conv-"));
    const store = new ContextSizeStore(join(dir, "sizes.json"));
    const logs: string[] = [];
    return {
      store,
      written,
      sizer: new ContextSizer(
        { upstream, caps: () => opts.caps ?? { "model/x": declared }, log: (m) => logs.push(m) },
        store,
      ),
      logs,
    };
  }

  const agent = { id: "a1", model: "model/x", model_settings: { context_window_limit: 241_664 } };

  test("the raw window the old sheet wrote is retuned, and stays the model's size", async () => {
    // The whole defect: a conversation carrying the model's raw window, written
    // before the output reserve was subtracted, compacted at 245 760 — 16 384
    // tokens past the point the server stops fitting the request at all. The size
    // it stands for is the declaration, so nothing is recorded as "you typed": an
    // adoption would relabel a model default as the operator's choice and freeze
    // it, since conversation scopes are never swept the way agents are at boot.
    const h = convHarness({
      agent,
      conversation: { id: "c1", model: "model/x", context_window_limit: 262_144 },
    });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(true);
    expect(h.written).toEqual(["c1 241664 --override"]);
    expect(h.store.all()).toEqual({});
    expect(h.logs.join(" ")).toContain("compacted at 245,760");
  });

  test("a nested-only window is still a window, so it is still sized", async () => {
    // Upstream's settings write leaves the top-level field absent — verified
    // against a live app-server — and its execution path reads nested as the
    // fallback. A sizer that looked only at top level saw an unsized conversation
    // and said nothing while the engine was armed to fail.
    const h = convHarness({
      agent,
      conversation: {
        id: "c1",
        model: "model/x",
        model_settings: { context_window_limit: 262_144 },
      },
    });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(true);
    expect(h.written).toEqual(["c1 241664 --override"]);
    expect(h.sizer.compactPointFor("conv:c1")).toBe(229_376);
  });

  test("a window matching nothing is reported, never rewritten", async () => {
    // 110 592 is the derived window for a 131 072 size: reading it as a size and
    // deriving again would shrink it at every restart, and from here it is
    // indistinguishable from a number someone typed. The sheet says its numbers.
    const h = convHarness({
      agent,
      conversation: { id: "c1", model: "model/x", context_window_limit: 110_592 },
    });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.store.all()).toEqual({});
  });

  test("a conversation that already carries the derived window writes nothing", async () => {
    const h = convHarness({
      agent,
      conversation: { id: "c1", model: "model/x", context_window_limit: 241_664 },
    });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(false);
    expect(h.written).toEqual([]);
    expect(h.store.all()).toEqual({});
  });

  test("a smaller conversation window is left alone, though it is no one's derivation", async () => {
    // Usually a copy taken when the conversation was created. It compacts early,
    // which costs some context; shrinking it further to satisfy the arithmetic
    // would cost more, so an over-conservative scope is nobody to retune.
    const h = convHarness({
      agent,
      conversation: { id: "c1", model: "model/x", context_window_limit: 128_000 },
    });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(false);
    expect(h.written).toEqual([]);
  });

  test("a conversation that inherits its agent's window is not a conversation scope", async () => {
    const h = convHarness({ agent, conversation: { id: "c1", model: "model/x" } });
    expect(await h.sizer.ensureConversation("a1", "c1")).toBe(false);
    expect(h.written).toEqual([]);
  });

  test("a retrieved record in hand is used instead of reading it again", async () => {
    // The Context sheet already has both records; sizing from them must not cost
    // two more requests. A conversation whose id is not the one asked for is a
    // different conversation and must never be sized for it.
    const h = convHarness({ agent: null, conversation: null });
    const conversation = { id: "c1", model: "model/x", context_window_limit: 262_144 };
    expect(await h.sizer.ensureConversation("a1", "c1", agent, conversation)).toBe(true);
    expect(h.written).toEqual(["c1 241664 --override"]);
    expect(await h.sizer.ensureConversation("a1", "c2", agent, conversation)).toBe(false);
    expect(h.written).toEqual(["c1 241664 --override"]);
  });

  test("the compact point of a sized scope is what the watchdog measures against", async () => {
    const h = convHarness({
      agent,
      conversation: { id: "c1", model: "model/x", context_window_limit: 262_144 },
    });
    expect(h.sizer.compactPointFor("conv:c1")).toBeNull();
    await h.sizer.ensureConversation("a1", "c1");
    // The first bad thing — the refusal at 229 376, before the compaction the
    // inflated window would have reached at 245 760. A ratio against the window
    // is what let a conversation this far gone read as 90 % full.
    expect(h.sizer.compactPointFor("conv:c1")).toBe(229_376);
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
