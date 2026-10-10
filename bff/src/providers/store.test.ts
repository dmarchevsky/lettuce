import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCapsError, ModelCapsStore, parseModelCapsBody, splitHandle } from "./store.ts";
import { parseVisionProviders } from "./vision.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "model-caps-")), "vision-models.json");
const noop = () => {};

const CAPS = { vision: true, thinking: true, contextWindow: 262144, maxTokens: 32768 };

describe("splitHandle", () => {
  test("splits on the first slash, lower-casing only the prefix", () => {
    expect(splitHandle("OpenAI-Compatible/Qwen3.8-Flash-Next")).toEqual({
      prefix: "openai-compatible",
      model: "Qwen3.8-Flash-Next",
    });
  });

  test("a model id may hold slashes — upstream splits at the first", () => {
    expect(splitHandle("openrouter/deepseek/deepseek-chat-v3")).toEqual({
      prefix: "openrouter",
      model: "deepseek/deepseek-chat-v3",
    });
  });

  test("rejects malformed handles", () => {
    expect(splitHandle("nodashes")).toBeNull();
    expect(splitHandle("/leading")).toBeNull();
    expect(splitHandle("trailing/")).toBeNull();
    expect(splitHandle("bad//")).toBeNull();
    expect(splitHandle("Bad Id/model")).toBeNull();
    expect(splitHandle(42)).toBeNull();
  });
});

describe("parseModelCapsBody", () => {
  test("canonicalises the handle and keeps a trimmed key", () => {
    const parsed = parseModelCapsBody({
      handle: "OpenAI-Compatible/Model",
      vision: true,
      thinking: false,
      contextWindow: 128000,
      maxTokens: 8192,
      apiKey: "  sk-secret  ",
    });
    expect(parsed.handle).toBe("openai-compatible/Model");
    expect(parsed.caps).toEqual({
      vision: true,
      thinking: false,
      contextWindow: 128000,
      maxTokens: 8192,
    });
    expect(parsed.apiKey).toBe("sk-secret");
  });

  test("blank key means keep-the-stored, not clear", () => {
    expect(parseModelCapsBody({ ...CAPS, handle: "p/m", apiKey: "  " }).apiKey).toBeNull();
    expect(parseModelCapsBody({ ...CAPS, handle: "p/m" }).apiKey).toBeNull();
  });

  test("every malformed field is named in the error", () => {
    expect(() => parseModelCapsBody(null)).toThrow(ModelCapsError);
    expect(() => parseModelCapsBody({ ...CAPS })).toThrow(/handle/);
    expect(() => parseModelCapsBody({ ...CAPS, handle: "bad handle/m" })).toThrow(/handle/);
    expect(() => parseModelCapsBody({ ...CAPS, handle: "p/m", vision: "yes" })).toThrow(/booleans/);
    expect(() => parseModelCapsBody({ ...CAPS, handle: "p/m", contextWindow: 0 })).toThrow(
      /contextWindow/,
    );
    expect(() => parseModelCapsBody({ ...CAPS, handle: "p/m", maxTokens: 1.5 })).toThrow(
      /maxTokens/,
    );
  });
});

describe("ModelCapsStore", () => {
  test("round-trips models and endpoints through the file", async () => {
    const file = fileIn();
    const store = new ModelCapsStore(file, noop);
    store.setModel("openai-compatible/Model", CAPS);
    store.setEndpoint("openai-compatible", { apiKey: "sk-x", baseUrl: "http://x/v1" });
    await store.drain();

    // Written whole under a temp name, then renamed: no half file, no litter.
    expect(readFileSync(file, "utf8")).toContain('"openai-compatible/Model"');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const reopened = new ModelCapsStore(file, noop);
    expect(reopened.seededFrom).toBe("file");
    expect(reopened.models()).toEqual({ "openai-compatible/Model": CAPS });
    expect(reopened.endpoints()).toEqual({
      "openai-compatible": { apiKey: "sk-x", baseUrl: "http://x/v1" },
    });
  });

  test("setEndpoint merges and never clears with blanks", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    store.setEndpoint("p", { apiKey: "sk-a", baseUrl: "http://a/v1" });
    store.setEndpoint("p", { apiKey: "sk-b" });
    expect(store.endpoint("p")).toEqual({ apiKey: "sk-b", baseUrl: "http://a/v1" });
  });

  test("removing the last model drops the endpoint group too", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    store.setModel("p/a", CAPS);
    store.setModel("p/b", CAPS);
    store.setEndpoint("p", { apiKey: "sk-x" });
    expect(store.removeModel("p/a")).toBe(true);
    expect(store.endpoint("p")).toBeDefined();
    expect(store.removeModel("p/b")).toBe(true);
    expect(store.endpoint("p")).toBeUndefined();
    expect(store.removeModel("p/missing")).toBe(false);
  });

  test("an unreadable file behaves like an empty store", () => {
    const file = fileIn();
    writeFileSync(file, "{not json");
    const store = new ModelCapsStore(file, noop);
    expect(store.models()).toEqual({});
  });

  test("entries of the wrong shape are dropped, not fatal", () => {
    const file = fileIn();
    writeFileSync(
      file,
      JSON.stringify({
        models: {
          "p/ok": CAPS,
          "p/bad": { vision: true, thinking: false, contextWindow: 0, maxTokens: 1 },
          "Bad Id/x": CAPS,
        },
        endpoints: { p: { apiKey: "k" }, "Bad Id": { baseUrl: "http://x" } },
      }),
    );
    const store = new ModelCapsStore(file, noop);
    expect(Object.keys(store.models())).toEqual(["p/ok"]);
    expect(Object.keys(store.endpoints())).toEqual(["p"]);
  });

  test("the write queue surfaces failures to the caller and survives them", async () => {
    const errors: unknown[] = [];
    // A path whose parent is a file: every persist fails, none throw out.
    const blocker = join(mkdtempSync(join(tmpdir(), "caps-")), "blocker");
    writeFileSync(blocker, "not a directory");
    const store = new ModelCapsStore(`${blocker}/nested/store.json`, (e) => errors.push(e));
    store.setModel("p/m", CAPS);
    await store.drain();
    expect(errors.length).toBe(1);
    // In-memory state is unaffected — the next save still reflects it.
    expect(store.models()).toEqual({ "p/m": CAPS });
  });
});

describe("seedFromVisionProviders", () => {
  const HALOGEN =
    '[{"id":"halogen","name":"Halogen","description":"d","baseUrl":"http://h/v1","apiKey":"sk-h",' +
    '"models":[{"id":"Qwen3.8-Flash-Next","contextWindow":262144,"maxTokens":32768,"reasoning":true}]}]';

  test("first boot converts env providers into models plus endpoint snapshots", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    const count = store.seedFromVisionProviders(parseVisionProviders(HALOGEN));
    expect(count).toBe(1);
    expect(store.models()["halogen/Qwen3.8-Flash-Next"]).toEqual({
      vision: true,
      thinking: true,
      contextWindow: 262144,
      maxTokens: 32768,
    });
    expect(store.endpoint("halogen")).toEqual({
      baseUrl: "http://h/v1",
      apiKey: "sk-h",
      name: "Halogen",
    });
  });

  test("never seeds over an existing store", async () => {
    const file = fileIn();
    const first = new ModelCapsStore(file, noop);
    first.setModel("mine/model", CAPS);
    await first.drain();
    const second = new ModelCapsStore(file, noop);
    expect(second.seedFromVisionProviders(parseVisionProviders(HALOGEN))).toBe(0);
    expect(Object.keys(second.models())).toEqual(["mine/model"]);
  });

  test("a fresh store with nothing to seed stays unseeded", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    expect(store.seedFromVisionProviders([])).toBe(0);
  });
});

describe("provider entries", () => {
  test("type, api, scope and models round-trip through the file", async () => {
    const file = fileIn();
    const store = new ModelCapsStore(file, noop);
    store.setEndpoint("llama-3b", {
      name: "llama 3b",
      type: "llama-cpp",
      api: "openai-completions",
      scope: "local",
      baseUrl: "http://x:8080/v1",
      models: ["qwen3-4b-instruct"],
    });
    await store.drain();
    expect(new ModelCapsStore(file, noop).endpoint("llama-3b")).toMatchObject({
      name: "llama 3b",
      type: "llama-cpp",
      api: "openai-completions",
      scope: "local",
      models: ["qwen3-4b-instruct"],
    });
  });

  test("removing a provider takes its declarations and retires the prefix", async () => {
    const file = fileIn();
    const store = new ModelCapsStore(file, noop);
    store.setEndpoint("p", { name: "P", models: ["a", "b"] });
    store.setModel("p/a", CAPS);
    store.setModel("p/b", CAPS);
    store.setModel("other/m", CAPS);
    expect(store.removeProvider("p")).toBe(true);
    expect(store.endpoint("p")).toBeUndefined();
    expect(Object.keys(store.models())).toEqual(["other/m"]);
    expect(store.retired().has("p")).toBe(true);
    // Nothing left to remove, and no fresh retirement of a prefix we never had.
    expect(store.removeProvider("p")).toBe(false);
    await store.drain();
    expect(new ModelCapsStore(file, noop).retired().has("p")).toBe(true);
  });

  test("adding a name back clears its retirement", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    store.setEndpoint("p", { name: "P", models: ["a"] });
    store.removeProvider("p");
    expect(store.retired().has("p")).toBe(true);
    store.unretire("p");
    expect(store.retired().has("p")).toBe(false);
  });

  test("undeclaring one model shrinks the provider's own list, it does not delete the provider", () => {
    const store = new ModelCapsStore(fileIn(), noop);
    store.setEndpoint("p", { name: "P", models: ["a", "b"] });
    store.setModel("p/a", CAPS);
    store.setModel("p/b", CAPS);
    store.removeModel("p/a");
    expect(store.endpoint("p")?.name).toBe("P");
    expect(store.endpoint("p")?.models).toEqual(["b"]);
  });
});
