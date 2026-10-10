import { describe, expect, test } from "bun:test";
import { handleProvider, normalizeProviderKey } from "./providers.ts";

describe("normalizeProviderKey", () => {
  test("the case that shipped broken: hyphenated provider, dotted handle", () => {
    // list_connect_providers says "llama-cpp"; every served handle is "llama.cpp/…".
    expect(normalizeProviderKey("llama.cpp")).toBe(normalizeProviderKey("llama-cpp"));
  });

  test("the BYOK alias spelling matches too", () => {
    expect(normalizeProviderKey("lc-llama-cpp")).toBe(normalizeProviderKey("llama-cpp"));
  });

  test("only the leading alias marker is stripped", () => {
    expect(normalizeProviderKey("lc-lc-thing")).toBe("lcthing");
    expect(normalizeProviderKey("ollama-cloud")).toBe("ollamacloud");
  });
});

describe("handleProvider", () => {
  test("the first segment is the provider", () => {
    expect(handleProvider("llama.cpp/Gemma-4")).toBe("llama.cpp");
  });

  test("a model id with slashes is still one handle — upstream splits at the first", () => {
    expect(handleProvider("openrouter/deepseek/deepseek-chat-v3")).toBe("openrouter");
  });

  test("a handle with no slash is all provider", () => {
    expect(handleProvider("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});
