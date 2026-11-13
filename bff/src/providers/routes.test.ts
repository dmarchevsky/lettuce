import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ContextSizer } from "../session/context-size.ts";
import { type ProviderRouteDeps, registerProviderRoutes } from "./routes.ts";
import type { ProviderSight } from "./sight.ts";
import { ModelCapsStore } from "./store.ts";
import { PROVIDERS_MOD_PATH } from "./vision.ts";

type TestEnv = { Variables: { session?: unknown } };

/** A diagnostics report naming one prefix, in the shape letta-code writes. */
function report(prefix: string, generatedAt = Date.now()): string {
  return JSON.stringify({
    generatedAt,
    report: {
      diagnostics: [
        {
          mod: { path: PROVIDERS_MOD_PATH, scope: "global" },
          message: `Provider ${prefix}, model x: id must be unprefixed and cannot contain "/"`,
          phase: "activate",
          severity: "error",
        },
      ],
    },
  });
}

async function setup(
  overrides: {
    connected?: string[];
    served?: Record<string, string[]>;
    diagnostics?: string | null;
    connectError?: string;
    /** Base URLs the app-server holds for a connection (`connected.base_url`). */
    bases?: Record<string, string>;
  } = {},
) {
  const modelCaps = new ModelCapsStore(
    join(await mkdtemp(join(tmpdir(), "lettuce-provider-routes-")), "caps.json"),
    () => {},
  );
  const connects: { providerId: string; fields: Record<string, string> }[] = [];
  /** Every connect and disconnect, in order. */
  const calls: string[] = [];
  let refreshes = 0;
  const sight = {
    isConnected: (prefix: string) => (overrides.connected ?? []).includes(prefix),
    baseUrlFor: (prefix: string) => overrides.bases?.[prefix],
    servedModels: (prefix: string) => overrides.served?.[prefix]?.map((id) => ({ id })),
    refresh: async () => {
      refreshes += 1;
    },
  } as unknown as ProviderSight;
  const deps: ProviderRouteDeps = {
    isReady: () => true,
    modelCaps,
    providerSight: sight,
    contextSizer: { applyHandle: async () => {} } as unknown as ContextSizer,
    resyncMods: async () => "reloaded",
    connect: async (providerId, fields) => {
      if (overrides.connectError) throw new Error(overrides.connectError);
      connects.push({ providerId, fields });
      calls.push(`connect ${providerId}${fields.baseUrl ? ` ${fields.baseUrl}` : ""}`);
    },
    disconnect: async (providerId) => {
      calls.push(`disconnect ${providerId}`);
    },
    readDiagnostics: async () => overrides.diagnostics ?? null,
  };
  const app = new Hono<TestEnv>();
  registerProviderRoutes(app, deps);
  return { app, modelCaps, connects, calls, refreshes: () => refreshes };
}

function send(app: Hono<TestEnv>, method: string, path: string, body?: unknown) {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("POST /api/providers — a type the app-server's own connection serves", () => {
  test("becomes connect_provider; nothing is stored and no mod is written", async () => {
    const { app, modelCaps, connects, refreshes } = await setup();
    const response = await send(app, "POST", "/api/providers", {
      type: "openrouter",
      apiKey: "sk-or-k",
      // What the sheet might still send: none of it applies to a connection.
      name: "OR-2",
      models: ["z-ai/glm-5.3-flash"],
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { provider: { prefix: string; connection: string } };
    expect(json.provider.prefix).toBe("openrouter");
    expect(json.provider.connection).toBe("openrouter");
    expect(connects).toEqual([
      {
        providerId: "openrouter",
        // No endpoint typed: none is sent, so each catalog model keeps its own base.
        fields: { apiKey: "sk-or-k" },
      },
    ]);
    expect(modelCaps.endpoints()).toEqual({});
    expect(refreshes()).toBe(1);
  });

  test("an existing connection is not overwritten: Edit is on its row", async () => {
    const { app, connects } = await setup({ connected: ["openrouter"] });
    const response = await send(app, "POST", "/api/providers", { type: "openrouter", apiKey: "k" });
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/already connected/);
    expect(connects).toEqual([]);
  });

  test("a provider of ours already holding the prefix is a conflict too", async () => {
    const { app, modelCaps, connects } = await setup();
    modelCaps.setEndpoint("openrouter", {
      name: "openrouter",
      baseUrl: "http://x/v1",
      models: ["m"],
    });
    const response = await send(app, "POST", "/api/providers", { type: "openrouter", apiKey: "k" });
    expect(response.status).toBe(409);
    expect(connects).toEqual([]);
  });

  test("an edit of a provider named before its type became a connection stays a save", async () => {
    const { app, modelCaps, connects } = await setup();
    modelCaps.setEndpoint("groq", {
      name: "Groq",
      type: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      models: ["llama-3.1-8b-instant"],
      apiKey: "old",
    });
    const response = await send(app, "POST", "/api/providers", {
      prefix: "groq",
      name: "Groq",
      type: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "new",
      models: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    });
    expect(response.status).toBe(200);
    expect(connects).toEqual([]);
    expect(modelCaps.endpoints().groq?.models).toEqual([
      "llama-3.1-8b-instant",
      "llama-3.3-70b-versatile",
    ]);
  });

  test("an edit left without a key keeps the stored one", async () => {
    const { app, modelCaps } = await setup();
    modelCaps.setEndpoint("claude-work", {
      name: "Claude Work",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: ["claude-haiku-4-5"],
      apiKey: "sk-stored",
    });
    const response = await send(app, "POST", "/api/providers", {
      prefix: "claude-work",
      name: "Claude Work",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      models: ["claude-haiku-4-5", "claude-sonnet-4-5"],
    });
    expect(response.status).toBe(200);
    expect(modelCaps.endpoints()["claude-work"]?.apiKey).toBe("sk-stored");
    expect(modelCaps.endpoints()["claude-work"]?.models).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  test("what upstream refused is said in its words", async () => {
    const { app } = await setup({ connectError: "Invalid API key" });
    const response = await send(app, "POST", "/api/providers", { type: "openrouter", apiKey: "k" });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Invalid API key");
  });
});

describe("load errors reach the operator", () => {
  test("a save whose registration the app-server refused answers with why", async () => {
    const { app } = await setup({ diagnostics: report("llama-3b", Date.now() + 1_000) });
    const response = await send(app, "POST", "/api/providers", {
      name: "llama 3b",
      type: "llama-cpp",
      baseUrl: "http://x:8080/v1",
      models: ["qwen3-4b-instruct"],
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { loadError?: string };
    expect(json.loadError).toContain("Provider llama-3b");
  });

  test("a report from before the reload is not this save's error", async () => {
    const { app } = await setup({ diagnostics: report("llama-3b", 1) });
    const response = await send(app, "POST", "/api/providers", {
      name: "llama 3b",
      type: "llama-cpp",
      baseUrl: "http://x:8080/v1",
      models: ["qwen3-4b-instruct"],
    });
    expect(((await response.json()) as { loadError?: string }).loadError).toBeUndefined();
  });

  test("the list flags a provider that cannot load, and one saved with ids it cannot register", async () => {
    const { app, modelCaps } = await setup({ diagnostics: report("broken") });
    modelCaps.setEndpoint("or-2", {
      name: "OR-2",
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      models: ["amazon/nova-lite-v1", "z-ai/glm-5.3-flash"],
    });
    modelCaps.setEndpoint("broken", { name: "Broken", baseUrl: "http://b/v1", models: ["m"] });
    modelCaps.setEndpoint("fine", { name: "Fine", baseUrl: "http://f/v1", models: ["m"] });
    const json = (await (await send(app, "GET", "/api/providers")).json()) as {
      providers: { prefix: string; problem?: string }[];
    };
    const problem = (prefix: string) => json.providers.find((p) => p.prefix === prefix)?.problem;
    expect(problem("or-2")).toMatch(/2 models.*"\/".*OpenRouter/);
    expect(problem("broken")).toContain("Provider broken");
    expect(problem("fine")).toBeUndefined();
  });

  test("only ids it cannot register mark a provider remove-only; a load error does not", async () => {
    // A Groq provider named before Groq became a connection, holding ids the mod
    // registers: refused for another reason, it stays editable.
    const { app, modelCaps } = await setup({ diagnostics: report("groq") });
    modelCaps.setEndpoint("groq", {
      name: "Groq",
      type: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      models: ["llama-3.3-70b-versatile"],
    });
    modelCaps.setEndpoint("or-2", {
      name: "OR-2",
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      models: ["amazon/nova-lite-v1"],
    });
    const json = (await (await send(app, "GET", "/api/providers")).json()) as {
      providers: { prefix: string; problem?: string; unregistrable?: boolean }[];
    };
    const row = (prefix: string) => json.providers.find((p) => p.prefix === prefix);
    expect(row("groq")?.problem).toContain("Provider groq");
    expect(row("groq")?.unregistrable).toBeUndefined();
    expect(row("or-2")?.unregistrable).toBe(true);
  });
});

describe("PUT /api/model-caps", () => {
  test("a connection serving any unregistrable id cannot be shadowed by a declaration", async () => {
    const { app, modelCaps } = await setup({
      connected: ["groq"],
      served: { groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] },
    });
    const response = await send(app, "PUT", "/api/model-caps", {
      handle: "groq/llama-3.3-70b-versatile",
      vision: false,
      thinking: false,
      contextWindow: 131072,
      maxTokens: 32768,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/openai\/gpt-oss-120b/);
    expect(modelCaps.models()).toEqual({});
  });
});

describe("POST /api/providers/models", () => {
  async function probe(type: string, prefix?: string) {
    const { app, modelCaps } = await setup();
    if (prefix) {
      modelCaps.setEndpoint(prefix, { name: prefix, type, baseUrl: "http://x/v1", models: ["m"] });
    }
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "~anthropic/claude-haiku-latest" },
            { id: "z-ai/glm-5.3-flash" },
            { id: "plain" },
          ],
        }),
      )) as unknown as typeof fetch;
    try {
      const response = await send(app, "POST", "/api/providers/models", {
        type,
        api: "openai-completions",
        baseUrl: "http://x/v1",
        apiKey: "k",
        ...(prefix ? { prefix } : {}),
      });
      return (await response.json()) as { models: string[]; skipped: string[] };
    } finally {
      globalThis.fetch = real;
    }
  }

  test("a named provider is offered only what it can register; the rest is counted", async () => {
    expect(await probe("openai-compatible")).toEqual({
      models: ["plain"],
      skipped: ["~anthropic/claude-haiku-latest", "z-ai/glm-5.3-flash"],
    });
  });

  test("a connection type's probe only proves the key: nothing is skipped", async () => {
    expect((await probe("openrouter")).skipped).toEqual([]);
  });

  test("editing a provider named before its type became a connection skips what it cannot register", async () => {
    expect((await probe("groq", "groq")).models).toEqual(["plain"]);
  });
});

describe("a connection's model picks", () => {
  const SERVED = { openrouter: ["z-ai/glm-5.3-flash", "amazon/nova-lite-v1", "x/old"] };
  const PICKS = { prefix: "openrouter", models: ["z-ai/glm-5.3-flash"] };
  const hiddenOf = (store: ModelCapsStore) =>
    Object.fromEntries([...store.hiddenModels()].map(([prefix, ids]) => [prefix, [...ids]]));
  async function listed(app: Hono<TestEnv>) {
    const json = (await (await send(app, "GET", "/api/providers")).json()) as {
      connections: Record<string, { selected: string[] | null; served: string[] }>;
    };
    return json.connections;
  }

  test("store what was left unticked, and list the picks back", async () => {
    const { app, modelCaps } = await setup({ connected: ["openrouter"], served: SERVED });
    const response = await send(app, "PUT", "/api/providers/connection-models", PICKS);
    expect(response.status).toBe(200);
    expect(hiddenOf(modelCaps)).toEqual({ openrouter: ["amazon/nova-lite-v1", "x/old"] });
    expect((await listed(app)).openrouter?.selected).toEqual(["z-ai/glm-5.3-flash"]);
  });

  test("a model served later is picked until unticked", async () => {
    // A letta-code upgrade adds to the catalog: it shows up, it is not hidden by default.
    const { app, modelCaps } = await setup({
      connected: ["openrouter"],
      served: { openrouter: [...SERVED.openrouter, "brand/new"] },
    });
    modelCaps.setHiddenModels("openrouter", ["amazon/nova-lite-v1", "x/old"]);
    expect((await listed(app)).openrouter?.selected).toEqual(["z-ai/glm-5.3-flash", "brand/new"]);
  });

  test("a hidden model the catalog dropped counts nowhere", async () => {
    const { app, modelCaps } = await setup({
      connected: ["openrouter"],
      served: { openrouter: ["z-ai/glm-5.3-flash", "amazon/nova-lite-v1"] },
    });
    modelCaps.setHiddenModels("openrouter", ["amazon/nova-lite-v1", "x/old"]);
    expect((await listed(app)).openrouter).toEqual({
      selected: ["z-ai/glm-5.3-flash"],
      served: ["z-ai/glm-5.3-flash", "amazon/nova-lite-v1"],
    });
  });

  test("ticking everything stores nothing", async () => {
    const { app, modelCaps } = await setup({ connected: ["openrouter"], served: SERVED });
    modelCaps.setHiddenModels("openrouter", ["x/old"]);
    await send(app, "PUT", "/api/providers/connection-models", {
      prefix: "openrouter",
      models: SERVED.openrouter,
    });
    expect(hiddenOf(modelCaps)).toEqual({});
    expect((await listed(app)).openrouter?.selected).toBeNull();
  });

  test("the list carries each live connection's whole served list, picks or not", async () => {
    const { app } = await setup({
      connected: ["openrouter"],
      served: { openrouter: ["z-ai/glm-5.3-flash", "amazon/nova-lite-v1"] },
    });
    expect(await listed(app)).toEqual({
      openrouter: { selected: null, served: ["z-ai/glm-5.3-flash", "amazon/nova-lite-v1"] },
    });
  });

  test("an update re-connects a live connection and keeps its picks", async () => {
    const { app, modelCaps, connects } = await setup({ connected: ["openrouter"] });
    modelCaps.setHiddenModels("openrouter", ["amazon/nova-lite-v1"]);
    const response = await send(app, "POST", "/api/providers", {
      type: "openrouter",
      apiKey: "k2",
      baseUrl: "https://eu.openrouter.ai/api/v1",
      update: true,
    });
    expect(response.status).toBe(200);
    expect(connects[0]?.fields).toEqual({
      apiKey: "k2",
      baseUrl: "https://eu.openrouter.ai/api/v1",
    });
    expect(hiddenOf(modelCaps)).toEqual({ openrouter: ["amazon/nova-lite-v1"] });
  });

  test("an update back to the default endpoint clears the stored one and keeps the picks", async () => {
    // Upstream's update keeps a stored base URL when none is sent, and only a
    // disconnect removes it: connect (checks the key), disconnect, connect.
    const { app, modelCaps, calls } = await setup({
      connected: ["openrouter"],
      bases: { openrouter: "https://us.openrouter.ai/api/v1" },
    });
    modelCaps.setHiddenModels("openrouter", ["amazon/nova-lite-v1"]);
    const response = await send(app, "POST", "/api/providers", {
      type: "openrouter",
      apiKey: "k2",
      baseUrl: "",
      update: true,
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["connect openrouter", "disconnect openrouter", "connect openrouter"]);
    expect(hiddenOf(modelCaps)).toEqual({ openrouter: ["amazon/nova-lite-v1"] });
  });

  test("an update with nothing stored to clear is one connect", async () => {
    const { app, calls } = await setup({ connected: ["openrouter"] });
    await send(app, "POST", "/api/providers", { type: "openrouter", apiKey: "k2", update: true });
    expect(calls).toEqual(["connect openrouter"]);
  });

  test("are refused for anything but a live connection of a connection type", async () => {
    const offline = await setup();
    expect((await send(offline.app, "PUT", "/api/providers/connection-models", PICKS)).status).toBe(
      409,
    );
    const named = await setup({ connected: ["llama-3b"] });
    expect(
      (
        await send(named.app, "PUT", "/api/providers/connection-models", {
          ...PICKS,
          prefix: "llama-3b",
        })
      ).status,
    ).toBe(400);
    const live = await setup({ connected: ["openrouter"], served: SERVED });
    expect(
      (await send(live.app, "PUT", "/api/providers/connection-models", { ...PICKS, models: [] }))
        .status,
    ).toBe(400);
  });

  test("a provider named into a connection's prefix does not inherit its unticked list", async () => {
    // Untick on Groq, disconnect, then name a provider "Groq": the old list would
    // silently hide that provider's models.
    const { app, modelCaps } = await setup();
    modelCaps.setHiddenModels("groq", ["m"]);
    const response = await send(app, "POST", "/api/providers", {
      name: "Groq",
      type: "openai-compatible",
      baseUrl: "http://g/v1",
      models: ["m"],
    });
    expect(response.status).toBe(200);
    expect(modelCaps.hiddenModels().has("groq")).toBe(false);
  });

  test("a fresh connect starts from everything served, not stale picks", async () => {
    const { app, modelCaps } = await setup();
    modelCaps.setHiddenModels("openrouter", ["old/model"]);
    await send(app, "POST", "/api/providers", { type: "openrouter", apiKey: "k" });
    expect(hiddenOf(modelCaps)).toEqual({});
  });
});

describe("POST /api/providers/models — the stored key stays with its endpoint", () => {
  async function probeWith(body: Record<string, unknown>) {
    const { app, modelCaps } = await setup();
    modelCaps.setEndpoint("mine", {
      name: "mine",
      type: "openai-compatible",
      baseUrl: "https://llm.example/v1",
      apiKey: "stored-secret",
      headers: { "x-team": "stored-header" },
      models: ["m"],
    });
    const seen: { url: string; headers: Headers }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ id: "plain" }] }));
    }) as unknown as typeof fetch;
    try {
      await send(app, "POST", "/api/providers/models", {
        type: "openai-compatible",
        api: "openai-completions",
        prefix: "mine",
        ...body,
      });
    } finally {
      globalThis.fetch = real;
    }
    const sent = seen.map((request) => [...request.headers.values()].join(" ")).join(" ");
    return { seen, sent };
  }

  test("a blank key falls back to the stored one for the endpoint it was saved for", async () => {
    const { sent } = await probeWith({ baseUrl: "https://llm.example/v1/" });
    expect(sent).toContain("stored-secret");
    expect(sent).toContain("stored-header");
  });

  test("another address gets neither the stored key nor the stored headers", async () => {
    const { seen, sent } = await probeWith({ baseUrl: "https://collector.example/v1" });
    expect(seen.length).toBeGreaterThan(0);
    expect(sent).not.toContain("stored-secret");
    expect(sent).not.toContain("stored-header");
  });

  test("a key typed into the form still goes wherever the form points", async () => {
    const { sent } = await probeWith({ baseUrl: "https://other.example/v1", apiKey: "typed" });
    expect(sent).toContain("typed");
    expect(sent).not.toContain("stored-secret");
  });
});
