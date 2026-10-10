import { describe, expect, test } from "bun:test";
import {
  PROVIDER_TYPES,
  ProviderError,
  parseProviderBody,
  probeProviderModels,
  providerType,
  slugifyName,
} from "./registry.ts";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "llama 3b",
    type: "llama-cpp",
    baseUrl: "http://host.docker.internal:8080/v1",
    apiKey: "",
    models: ["qwen3-4b-instruct"],
    ...overrides,
  };
}

describe("slugifyName", () => {
  test("a name becomes a handle prefix", () => {
    expect(slugifyName("  Llama 3b ")).toBe("llama-3b");
    expect(slugifyName("Claude Work 🤖")).toBe("claude-work");
    expect(slugifyName("OpenRouter")).toBe("openrouter");
  });

  test("nothing left after folding is not a prefix", () => {
    expect(slugifyName("!!!")).toBe("");
    expect(slugifyName(undefined)).toBe("");
  });
});

describe("parseProviderBody", () => {
  test("the type decides the api and the group", () => {
    const parsed = parseProviderBody(body());
    expect(parsed).toMatchObject({
      prefix: "llama-3b",
      type: "llama-cpp",
      api: "openai-completions",
      scope: "local",
      baseUrl: "http://host.docker.internal:8080/v1",
      apiKey: null,
      models: ["qwen3-4b-instruct"],
    });
  });

  test("a trailing slash never doubles up in the base URL", () => {
    expect(parseProviderBody(body({ baseUrl: "https://api.x.ai/v1///" })).baseUrl).toBe(
      "https://api.x.ai/v1",
    );
  });

  test("a hosted type needs a key, a local one does not", () => {
    expect(() => parseProviderBody(body({ type: "anthropic" }))).toThrow(ProviderError);
    expect(parseProviderBody(body({ type: "anthropic", apiKey: " sk-key " })).apiKey).toBe(
      "sk-key",
    );
  });

  test("a saved provider may be re-saved without retyping the key", () => {
    expect(
      parseProviderBody(body({ type: "anthropic", apiKey: "", keepKey: true })).apiKey,
    ).toBeNull();
  });

  test("the mistakes are said in the operator's words", () => {
    expect(() => parseProviderBody(body({ name: "   " }))).toThrow(/needs a name/);
    expect(() => parseProviderBody(body({ name: "///" }))).toThrow(/handle prefix/);
    expect(() => parseProviderBody(body({ type: "bedrock" }))).toThrow(/provider type/);
    expect(() => parseProviderBody(body({ baseUrl: "127.0.0.1:8080" }))).toThrow(/http/);
    expect(() => parseProviderBody(body({ models: [] }))).toThrow(/at least one model/);
    expect(() => parseProviderBody(body({ models: ["ok", "/nope"] }))).toThrow(/not a model id/);
    // What a model can do is not the provider's business: a body that still
    // carries capabilities gets them ignored rather than rejected.
    expect("caps" in parseProviderBody(body({ caps: { contextWindow: 0 } }))).toBe(false);
  });

  test("a model id may hold a slash (OpenRouter names them that way)", () => {
    expect(
      parseProviderBody(body({ type: "openrouter", apiKey: "k", models: ["deepseek/deepseek-v3"] }))
        .models,
    ).toEqual(["deepseek/deepseek-v3"]);
  });

  test("every type says an api and a scope", () => {
    for (const type of PROVIDER_TYPES) {
      expect(providerType(type.id)).toBe(type);
      expect(type.api).toMatch(/^(openai|anthropic|google|mistral)/);
      expect(["local", "cloud"]).toContain(type.scope);
    }
    expect(providerType("bedrock")).toBeUndefined();
  });
});

describe("probeProviderModels", () => {
  /** Every family asks differently; a wrong ask reads as "no models". */
  async function withFetch(
    payload: unknown,
    run: (calls: { url: string; headers: Record<string, string> }[]) => Promise<void>,
  ) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const init = args[1] as RequestInit | undefined;
      calls.push({
        url: typeof args[0] === "string" ? args[0] : args[0].toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = real;
    }
  }

  test("the OpenAI-shaped ask is the base URL plus /models, with a bearer", async () => {
    await withFetch({ data: [{ id: "b" }, { id: "a" }] }, async (calls) => {
      const ids = await probeProviderModels({
        api: "openai-completions",
        baseUrl: "http://x:8080/v1",
        apiKey: "k",
      });
      expect(ids).toEqual(["a", "b"]);
      expect(calls[0]!.url).toBe("http://x:8080/v1/models");
      expect(calls[0]!.headers.authorization).toBe("Bearer k");
    });
  });

  test("Anthropic wants /v1/models with its own headers", async () => {
    await withFetch({ data: [{ id: "claude-sonnet-4-5" }] }, async (calls) => {
      expect(
        await probeProviderModels({
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          apiKey: "k",
        }),
      ).toEqual(["claude-sonnet-4-5"]);
      expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
      expect(calls[0]!.headers["x-api-key"]).toBe("k");
      expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    });
  });

  test("an Anthropic base URL that already carries /v1 is not doubled", async () => {
    await withFetch({ data: ["x"] }, async (calls) => {
      await probeProviderModels({
        api: "anthropic-messages",
        baseUrl: "https://proxy.test/v1",
        apiKey: "k",
      });
      expect(calls[0]!.url).toBe("https://proxy.test/v1/models");
    });
  });

  test("Gemini takes the key in the query and names its models", async () => {
    await withFetch({ models: [{ name: "models/gemini-2.0-flash" }] }, async (calls) => {
      expect(
        await probeProviderModels({
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        }),
      ).toEqual(["gemini-2.0-flash"]);
      expect(calls[0]!.url).toContain("/v1beta/models?key=k");
    });
  });

  test("what the endpoint says comes back verbatim", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
      new Response("invalid api key", { status: 401 })) as typeof fetch;
    try {
      await expect(
        probeProviderModels({ api: "openai-completions", baseUrl: "http://x/v1", apiKey: "k" }),
      ).rejects.toThrow(/401.*invalid api key/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
