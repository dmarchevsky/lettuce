import { describe, expect, test } from "bun:test";
import {
  buildProviderModGroups,
  PROVIDERS_MOD_PATH,
  type ProviderModInput,
  parseRegisteredProviderIds,
  parseVisionProviders,
  renderProvidersMod,
  type ServedModelInfo,
} from "./vision.ts";

const HALOGEN =
  '[{"id":"halogen","name":"Halogen","description":"Qwen3.8-Flash-Next on Strix Halo",' +
  '"baseUrl":"http://192.0.2.100:8080/olla/openai/v1",' +
  '"models":[{"id":"Qwen3.8-Flash-Next","contextWindow":262144,"maxTokens":32768}]}]';

describe("parseVisionProviders", () => {
  test("unset or blank means no providers, not an error", () => {
    expect(parseVisionProviders(undefined)).toEqual([]);
    expect(parseVisionProviders("")).toEqual([]);
    expect(parseVisionProviders("   ")).toEqual([]);
  });

  test("a well-formed halogen entry parses with vision defaults", () => {
    const provider = parseVisionProviders(HALOGEN)[0]!;
    expect(provider.id).toBe("halogen");
    expect(provider.baseUrl).toBe("http://192.0.2.100:8080/olla/openai/v1");
    expect(provider.apiKey).toBeUndefined();
    const model = provider.models[0]!;
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(32768);
    expect(model.reasoning).toBeUndefined();
  });

  test("bad input names the mistake", () => {
    expect(() => parseVisionProviders("{oops")).toThrow(/VISION_PROVIDERS/);
    expect(() => parseVisionProviders("{}")).toThrow(/JSON array/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"Bad Id","baseUrl":"http://x/v1","models":[{"id":"m","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/provider id/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"ftp://x","models":[{"id":"m","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/baseUrl/);
    expect(() => parseVisionProviders('[{"id":"p","baseUrl":"http://x","models":[]}]')).toThrow(
      /non-empty/,
    );
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"a/b","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/invalid id/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":0,"maxTokens":1}]}]',
      ),
    ).toThrow(/contextWindow/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":8192,"maxTokens":"1"}]}]',
      ),
    ).toThrow(/maxTokens/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":1,"maxTokens":1,"input":["video"]}]}]',
      ),
    ).toThrow(/input/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":1,"maxTokens":1}]},{"id":"p","baseUrl":"http://y","models":[{"id":"n","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/twice/);
  });
});

const SERVED: ServedModelInfo[] = [
  {
    id: "Qwen3.8-Flash-Next",
    label: "Qwen3.8-Flash-Next",
    contextWindow: 128000,
    maxTokens: 32000,
  },
  { id: "Phi-4-mini", label: "Phi-4-mini", contextWindow: 128000, maxTokens: 32000 },
];

function input(overrides: Partial<ProviderModInput> = {}): ProviderModInput {
  return {
    models: {},
    endpoints: {},
    served: new Map([["openai-compatible", SERVED]]),
    baseUrlOf: (prefix) => (prefix === "openai-compatible" ? "http://live.test/v1" : undefined),
    isLive: (prefix) => prefix === "openai-compatible",
    alreadyRegistered: new Set(),
    ...overrides,
  };
}

function registrations(source: string): Record<string, Record<string, never>> {
  const calls: Record<string, Record<string, never>> = {};
  const activate = new Function(source.replace("export default", "return"))() as (
    letta: unknown,
  ) => void;
  expect(() => activate({ capabilities: {} })).not.toThrow();
  activate({
    capabilities: { providers: true },
    providers: {
      register: (id: string, reg: Record<string, never>) => {
        calls[id] = reg;
      },
    },
  });
  return calls;
}

describe("buildProviderModGroups", () => {
  test("nothing anywhere renders a mod that registers nothing", () => {
    const groups = buildProviderModGroups(input({ served: new Map() }));
    expect(groups).toEqual([]);
    const source = renderProvidersMod(groups!);
    expect(source).toContain("registers nothing");
    expect(source).toContain("export default function activate() {}");
  });

  test("a declared vision model shadows its prefix; the mirror keeps the rest", () => {
    const groups = buildProviderModGroups(
      input({
        models: {
          "openai-compatible/Qwen3.8-Flash-Next": {
            vision: true,
            thinking: true,
            contextWindow: 262144,
            maxTokens: 32768,
          },
        },
      }),
    )!;
    expect(groups.map((g) => g.id)).toEqual(["openai-compatible"]);
    const group = groups[0]!;
    // The live connection's base URL wins over anything stored.
    expect(group.baseUrl).toBe("http://live.test/v1");
    // Every served model is mirrored — a registration owns its whole prefix.
    expect(group.models.map((m) => m.id)).toEqual(["Qwen3.8-Flash-Next", "Phi-4-mini"]);
    const declared = group.models[0]!;
    expect(declared.input).toEqual(["text", "image"]);
    expect(declared.reasoning).toBe(true);
    expect(declared.contextWindow).toBe(262144);
    expect(declared.maxTokens).toBe(32768);
    const plain = group.models[1]!;
    expect(plain.input).toEqual(["text"]);
    expect(plain.reasoning).toBe(false);
    // Undeclared keeps exactly what auto-discovery published — no silent clamp.
    expect(plain.contextWindow).toBe(128000);
    expect(plain.maxTokens).toBe(32000);
  });

  test("un-declaring the last model keeps the shadow (removal loses discovery)", () => {
    const groups = buildProviderModGroups(
      input({ alreadyRegistered: new Set(["openai-compatible"]) }),
    )!;
    expect(groups.map((g) => g.id)).toEqual(["openai-compatible"]);
    const models = groups[0]!.models;
    expect(models.every((m) => m.input[0] === "text")).toBe(true);
    expect(models.find((m) => m.id === "Phi-4-mini")?.contextWindow).toBe(128000);
  });

  test("a shadow whose endpoint stopped serving loses the registration", () => {
    const groups = buildProviderModGroups(
      input({
        served: new Map([["openai-compatible", []]]),
        alreadyRegistered: new Set(["openai-compatible"]),
      }),
    )!;
    expect(groups).toEqual([]);
  });

  test("render defers while a live prefix has no mirror yet", () => {
    // An already-shadowed prefix whose served list has never landed: a
    // render now would either erase its models or drop its registration.
    expect(
      buildProviderModGroups(
        input({ served: new Map(), alreadyRegistered: new Set(["openai-compatible"]) }),
      ),
    ).toBeNull();
    // A declared model under a live prefix the mirror has never seen.
    expect(
      buildProviderModGroups(
        input({
          served: new Map(),
          models: {
            "openai-compatible/X": {
              vision: true,
              thinking: false,
              contextWindow: 1,
              maxTokens: 1,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  test("a prefix that needs a group but has no base URL anywhere defers too", () => {
    // Declared model, live endpoint, no live URL and no stored snapshot:
    // the group would be incomplete, so the existing mod file must stand.
    expect(
      buildProviderModGroups(
        input({
          baseUrlOf: () => undefined,
          models: {
            "openai-compatible/Qwen3.8-Flash-Next": {
              vision: true,
              thinking: false,
              contextWindow: 1,
              maxTokens: 1,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  test("a standalone (env-seeded) group renders from its endpoint snapshot", () => {
    const groups = buildProviderModGroups(
      input({
        served: new Map(),
        models: {
          "halogen/Qwen3.8-Flash-Next": {
            vision: true,
            thinking: false,
            contextWindow: 262144,
            maxTokens: 32768,
          },
        },
        endpoints: {
          halogen: {
            baseUrl: "http://192.0.2.100:8080/olla/openai/v1",
            name: "Halogen",
            apiKey: "sk-x",
          },
        },
      }),
    )!;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("halogen");
    expect(groups[0]!.name).toBe("Halogen");
    expect(groups[0]!.baseUrl).toBe("http://192.0.2.100:8080/olla/openai/v1");
    expect(groups[0]!.apiKey).toBe("sk-x");
    expect(groups[0]!.models[0]).toMatchObject({
      id: "Qwen3.8-Flash-Next",
      input: ["text", "image"],
      contextWindow: 262144,
    });
  });

  test("the seeded VISION_PROVIDERS example becomes an identical standalone group", () => {
    const [provider] = parseVisionProviders(HALOGEN);
    const groups = buildProviderModGroups(
      input({
        served: new Map(),
        models: {
          [`${provider!.id}/${provider!.models[0]!.id}`]: {
            vision: true,
            thinking: false,
            contextWindow: provider!.models[0]!.contextWindow,
            maxTokens: provider!.models[0]!.maxTokens,
          },
        },
        endpoints: { [provider!.id]: { baseUrl: provider!.baseUrl, name: provider!.name } },
      }),
    )!;
    expect(groups[0]!.id).toBe("halogen");
    expect(groups[0]!.models[0]!.contextWindow).toBe(262144);
  });
});

describe("renderProvidersMod", () => {
  test("the rendered mod registers each group with no connect step and the resolved facts", () => {
    const groups = buildProviderModGroups(
      input({
        models: {
          "openai-compatible/Qwen3.8-Flash-Next": {
            vision: true,
            thinking: false,
            contextWindow: 262144,
            maxTokens: 32768,
          },
        },
      }),
    )!;
    const source = renderProvidersMod(groups);
    expect(source).toContain('letta.providers.register("openai-compatible"');
    expect(source).toContain('"apiKey": "not-needed"');
    expect(source).toContain('"connect": false');
    expect(source).toContain('"api": "openai-completions"');
    expect(source).toContain('"contextWindow": 262144');
    const calls = registrations(source);
    expect(Object.keys(calls)).toEqual(["openai-compatible"]);
    const registration = calls["openai-compatible"] as unknown as Record<string, unknown>;
    const models = registration.models as { input: string[] }[];
    expect(models[0]!.input).toEqual(["text", "image"]);
    expect(models[1]!.input).toEqual(["text"]);
  });
});

describe("parseRegisteredProviderIds", () => {
  test("round-trips through the rendered mod", () => {
    const groups = buildProviderModGroups(
      input({ alreadyRegistered: new Set(["openai-compatible"]) }),
    )!;
    const source = renderProvidersMod(groups);
    expect(parseRegisteredProviderIds(source)).toEqual(new Set(["openai-compatible"]));
    expect(parseRegisteredProviderIds(renderProvidersMod([]))).toEqual(new Set());
    expect(parseRegisteredProviderIds(null)).toEqual(new Set());
  });
});

test("the mod lives where every other mod lives", () => {
  expect(PROVIDERS_MOD_PATH).toMatch(/mods\/lettuce-providers\.mjs$/);
});

describe("buildProviderModGroups — providers the operator added", () => {
  test("a provider publishes its own model list, no served mirror needed", () => {
    const groups = buildProviderModGroups(
      input({
        served: new Map(),
        baseUrlOf: () => undefined,
        isLive: () => false,
        endpoints: {
          "llama-3b": {
            name: "llama 3b",
            api: "openai-completions",
            baseUrl: "http://x:8080/v1",
            models: ["qwen3-4b-instruct", "gemma3n-e4b"],
          },
        },
      }),
    )!;
    expect(groups.map((g) => g.id)).toEqual(["llama-3b"]);
    expect(groups[0]!.name).toBe("llama 3b");
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["qwen3-4b-instruct", "gemma3n-e4b"]);
    // Declared caps still apply per model; nothing declared keeps the clamp.
    expect(groups[0]!.models[0]!.contextWindow).toBe(128000);
  });

  test("a non-completions api registers with its own api and pi-ai's defaults", () => {
    const groups = buildProviderModGroups(
      input({
        served: new Map(),
        baseUrlOf: () => undefined,
        isLive: () => false,
        endpoints: {
          "claude-work": {
            name: "Claude work",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            models: ["claude-sonnet-4-5"],
          },
        },
      }),
    )!;
    expect(groups[0]!.api).toBe("anthropic-messages");
    const source = renderProvidersMod(groups);
    expect(source).toContain('"api": "anthropic-messages"');
    // The completions compat overrides are about plumbing only that api has.
    expect(source).not.toContain("supportsDeveloperRole");
  });

  test("a retired prefix stays out, whatever the mod on disk declares", () => {
    expect(
      buildProviderModGroups(
        input({
          served: new Map(),
          retired: new Set(["openai-compatible"]),
          alreadyRegistered: new Set(["openai-compatible"]),
        }),
      ),
    ).toEqual([]);
  });

  test("a half-entered provider skips itself rather than blocking every other group", () => {
    const groups = buildProviderModGroups(
      input({
        served: new Map(),
        baseUrlOf: () => undefined,
        isLive: () => false,
        endpoints: {
          "no-url": { name: "No url", models: ["m"] },
          good: { name: "Good", baseUrl: "http://good/v1", models: ["m"] },
        },
      }),
    );
    expect(groups?.map((g) => g.id)).toEqual(["good"]);
  });
});
