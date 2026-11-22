import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { handleInternalTools } from "../internal-tools/http.ts";
import type { ToolAnswer, ToolHandler } from "../internal-tools/types.ts";
import type { RouteEnv } from "../route-env.ts";
import {
  type DrawedImage,
  type DrawResult,
  describeImageError,
  drawImages,
  endpointFromSettings,
  type ImageEndpoint,
  type ImageFetch,
  imageRequestBody,
} from "./client.ts";
import {
  drawFace,
  FACE_BACKGROUND_SUFFIX,
  FACE_STYLE_PREFIX,
  facePromptRefusal,
  faceSizes,
  MAX_FACE_PROMPT_CHARS,
  sizeShapedRefusal,
} from "./face.ts";
import { IMAGE_TOOL_SPECS, IMAGES_MOD_PATH, renderImagesMod } from "./mod.ts";
import { registerImagesRoutes } from "./routes.ts";
import { generateImageTool, ImagesSettingsStore, slugifyPrompt } from "./service.ts";
import {
  applyImagesSettingsUpdate,
  DEFAULT_IMAGES_SETTINGS,
  InvalidImagesSettingsError,
  imagesConfigured,
  imagesEndpointUrl,
  parseStoredImagesSettings,
  renderStoredImagesSettings,
  toPublicImagesSettings,
} from "./settings.ts";
import { modErrorsFrom } from "./status.ts";

/** A 1x1 PNG, for the few bytes any assertion actually needs. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const ENDPOINT: ImageEndpoint = {
  baseUrl: "http://img.example:8000/v1",
  apiKey: null,
  model: "flux-dev",
  size: "1024x1024",
  timeoutMs: 180_000,
};

const SETTINGS = {
  ...DEFAULT_IMAGES_SETTINGS,
  enabled: true,
  baseUrl: "http://img.example:8000/v1",
  model: "flux-dev",
  size: "1024x1024",
};

function jsonResponse(body: unknown, status = 200, type = "application/json"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });
}

function b64Reply(count = 1): Response {
  return jsonResponse({
    created: 1,
    data: Array.from({ length: count }, () => ({ b64_json: PNG_B64 })),
  });
}

/** The pictures of a result, or none — narrowing the union without a fight. */
function pictures(result: DrawResult): DrawedImage[] {
  return result.ok ? result.images : [];
}

/** Read one header off a recorded call, whatever shape the init put it in. */
function headerOf(call: { init?: RequestInit } | undefined, name: string): string | undefined {
  const headers = call?.init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries = Object.entries(headers as Record<string, string>);
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Records what the client actually sent, which is most of what this file asserts. */
function spyFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit; body?: Record<string, unknown> }[] = [];
  const fetchImpl: ImageFetch = async (url, init) => {
    calls.push({
      url,
      init,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return reply(url, init);
  };
  return { fetchImpl, calls };
}

describe("images settings", () => {
  test("parse is lenient and defaults to off with nothing configured", () => {
    expect(parseStoredImagesSettings(null)).toEqual(DEFAULT_IMAGES_SETTINGS);
    expect(parseStoredImagesSettings("{nope")).toEqual(DEFAULT_IMAGES_SETTINGS);
    expect(parseStoredImagesSettings("[1,2]")).toEqual(DEFAULT_IMAGES_SETTINGS);
    // A hand-edited size nobody can send is dropped rather than poisoning every draw.
    expect(parseStoredImagesSettings('{"size":"huge"}').size).toBeNull();
    expect(parseStoredImagesSettings('{"baseUrl":"http://x/v1/","timeoutMs":10}').baseUrl).toBe(
      "http://x/v1",
    );
  });

  test("enabling needs an endpoint and a model; a size must be WxH", () => {
    expect(() => applyImagesSettingsUpdate(DEFAULT_IMAGES_SETTINGS, { enabled: true })).toThrow(
      InvalidImagesSettingsError,
    );
    expect(() =>
      applyImagesSettingsUpdate({ ...SETTINGS, model: null }, { enabled: true }),
    ).toThrow(/model/);
    expect(() => applyImagesSettingsUpdate(SETTINGS, { size: "1024" })).toThrow(/WIDTHxHEIGHT/);
    expect(() => applyImagesSettingsUpdate(SETTINGS, { timeoutMs: 10 })).toThrow(/timeoutMs/);
    expect(() => applyImagesSettingsUpdate(SETTINGS, { baseUrl: "ftp://x/v1" })).toThrow(/http/);
    expect(applyImagesSettingsUpdate(SETTINGS, { enabled: false }).enabled).toBe(false);
  });

  test("the key is write-only: an empty save keeps it, clearApiKey removes it", () => {
    const withKey = { ...SETTINGS, apiKey: "sk-secret" };
    expect(applyImagesSettingsUpdate(withKey, { model: "other" }).apiKey).toBe("sk-secret");
    expect(applyImagesSettingsUpdate(withKey, { apiKey: "" }).apiKey).toBe("sk-secret");
    expect(applyImagesSettingsUpdate(withKey, { apiKey: "  " }).apiKey).toBe("sk-secret");
    expect(applyImagesSettingsUpdate(withKey, { apiKey: "sk-new" }).apiKey).toBe("sk-new");
    expect(applyImagesSettingsUpdate(withKey, { clearApiKey: true }).apiKey).toBeNull();
  });

  test("no payload ever carries the key back", () => {
    const publicSettings = toPublicImagesSettings({ ...SETTINGS, apiKey: "sk-secret" });
    expect(publicSettings.hasKey).toBe(true);
    expect("apiKey" in publicSettings).toBe(false);
    expect(JSON.stringify(publicSettings)).not.toContain("sk-secret");
    expect(toPublicImagesSettings(SETTINGS).hasKey).toBe(false);
  });

  test("the endpoint is joined, and a base that already names the path stands", () => {
    expect(imagesEndpointUrl("http://x/v1")).toBe("http://x/v1/images/generations");
    expect(imagesEndpointUrl("http://x/v1/")).toBe("http://x/v1/images/generations");
    expect(imagesEndpointUrl("http://x/v1/images/generations")).toBe(
      "http://x/v1/images/generations",
    );
  });

  test("imagesConfigured is enabled AND endpoint AND model", () => {
    expect(imagesConfigured(DEFAULT_IMAGES_SETTINGS)).toBe(false);
    expect(
      imagesConfigured({ ...DEFAULT_IMAGES_SETTINGS, baseUrl: "http://x/v1", model: "m" }),
    ).toBe(false);
    expect(imagesConfigured(SETTINGS)).toBe(true);
  });

  test("concurrent saves serialize: neither tab loses the other's field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "images-race-"));
    const file = join(dir, "settings.json");
    const store = new ImagesSettingsStore(file);
    await store.save({
      enabled: true,
      baseUrl: "http://img.example:8000/v1",
      model: "flux-dev",
    });
    await Promise.all([store.save({ size: "512x512" }), store.save({ model: "flux-dev-2" })]);
    const stored = await store.load();
    expect(stored.size).toBe("512x512");
    expect(stored.model).toBe("flux-dev-2");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the store round-trips through a file no agent can read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "images-store-"));
    const file = join(dir, "settings.json");
    const store = new ImagesSettingsStore(file);
    expect(await store.load()).toEqual(DEFAULT_IMAGES_SETTINGS);
    const saved = await store.save({
      enabled: true,
      baseUrl: "http://img.example:8000/v1/",
      model: "flux-dev",
      size: "1024x1024",
      apiKey: "sk-secret",
    });
    expect(saved.baseUrl).toBe("http://img.example:8000/v1");
    expect((await store.load()).apiKey).toBe("sk-secret");
    // 0600: agent shells mount the state tree read-write as uid 0; this file is
    // on the bff-data volume and stays owner-only all the same.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(renderStoredImagesSettings(saved)).toContain("sk-secret");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the universal client", () => {
  test("the body is the minimal universal shape, and seed only when asked", () => {
    expect(imageRequestBody({ prompt: "a fox" }, ENDPOINT, "768x768")).toEqual({
      model: "flux-dev",
      prompt: "a fox",
      size: "768x768",
      response_format: "b64_json",
    });
    expect(imageRequestBody({ prompt: "a fox", n: 2, seed: 7 }, ENDPOINT, null)).toEqual({
      model: "flux-dev",
      prompt: "a fox",
      n: 2,
      response_format: "b64_json",
      seed: 7,
    });
    // No size configured and none passed: the field is absent, not empty.
    expect(
      imageRequestBody({ prompt: "a fox" }, { ...ENDPOINT, size: null }, null),
    ).not.toHaveProperty("size");
  });

  test("Bearer is sent only when a key is set", async () => {
    const noKey = spyFetch(() => b64Reply());
    await drawImages(ENDPOINT, { prompt: "a fox" }, { fetchImpl: noKey.fetchImpl });
    expect(headerOf(noKey.calls[0], "authorization")).toBeUndefined();

    const keyed = spyFetch(() => b64Reply());
    await drawImages(
      { ...ENDPOINT, apiKey: "sk-secret" },
      { prompt: "a fox" },
      { fetchImpl: keyed.fetchImpl },
    );
    expect(headerOf(keyed.calls[0], "authorization")).toBe("Bearer sk-secret");
  });

  test("a b64_json reply becomes pictures, at the configured size", async () => {
    const { fetchImpl, calls } = spyFetch(() => b64Reply(2));
    const result = await drawImages(ENDPOINT, { prompt: "a fox" }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(pictures(result)).toHaveLength(2);
    expect(pictures(result)[0]?.b64).toBe(PNG_B64);
    expect(calls[0]?.url).toBe("http://img.example:8000/v1/images/generations");
    expect(calls[0]?.body).toMatchObject({ size: "1024x1024", model: "flux-dev" });
  });

  test("a size passed by the call wins over the configured default", async () => {
    const { fetchImpl, calls } = spyFetch(() => b64Reply());
    await drawImages(ENDPOINT, { prompt: "a fox", size: "512x512" }, { fetchImpl });
    expect(calls[0]?.body?.size).toBe("512x512");
  });

  test("an http url is fetched by the BFF; a data: url is decoded", async () => {
    const http = spyFetch((_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ data: [{ url: "http://img.example:8000/out/1.png" }] })
        : new Response(Buffer.from(PNG_B64, "base64"), {
            headers: { "content-type": "image/png" },
          }),
    );
    const viaUrl = await drawImages(ENDPOINT, { prompt: "a fox" }, { fetchImpl: http.fetchImpl });
    expect(pictures(viaUrl)[0]?.b64).toBe(PNG_B64);
    expect(http.calls.map((call) => call.init?.method)).toEqual(["POST", undefined]);

    const dataUrl = spyFetch(() =>
      jsonResponse({ data: [{ url: `data:image/webp;base64,${PNG_B64}` }] }),
    );
    const viaData = await drawImages(
      ENDPOINT,
      { prompt: "a fox" },
      { fetchImpl: dataUrl.fetchImpl },
    );
    expect(pictures(viaData)[0]?.b64).toBe(PNG_B64);
    expect(pictures(viaData)[0]?.mediaType).toBe("image/webp");
  });

  test("endpointFromSettings is what the client needs — and nothing else", () => {
    expect(endpointFromSettings({ ...SETTINGS, apiKey: "sk-secret" })).toEqual({
      baseUrl: SETTINGS.baseUrl,
      apiKey: "sk-secret",
      model: SETTINGS.model,
      size: SETTINGS.size,
      timeoutMs: SETTINGS.timeoutMs,
    });
  });

  test("a server that ignores response_format and answers with bytes still works", async () => {
    const raw = spyFetch(
      () =>
        new Response(Buffer.from(PNG_B64, "base64"), { headers: { "content-type": "image/png" } }),
    );
    const result = await drawImages(ENDPOINT, { prompt: "a fox" }, { fetchImpl: raw.fetchImpl });
    expect(pictures(result)).toHaveLength(1);
  });

  test("errors reach the agent as the server said them", async () => {
    const plain = spyFetch(
      () => new Response("n greater than 1 is not supported", { status: 400 }),
    );
    const asText = await drawImages(
      ENDPOINT,
      { prompt: "a fox", n: 3 },
      { fetchImpl: plain.fetchImpl },
    );
    expect(asText).toEqual({
      ok: false,
      error: "HTTP 400: n greater than 1 is not supported",
      status: 400,
    });

    const structured = spyFetch(() =>
      jsonResponse(
        { error: { message: "size 123x456 is not in the allowed set", type: "InvalidRequest" } },
        400,
      ),
    );
    expect(
      await drawImages(
        ENDPOINT,
        { prompt: "x", size: "123x456" },
        { fetchImpl: structured.fetchImpl },
      ),
    ).toEqual({
      ok: false,
      error: "size 123x456 is not in the allowed set",
      status: 400,
    });

    // A proxy answering HTML at 200 is not a picture and must not look like one.
    const html = spyFetch(() => jsonResponse("<html>bad gateway</html>", 200, "text/html"));
    const nope = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: html.fetchImpl });
    expect(nope.ok).toBe(false);
    expect(!nope.ok && nope.error).toContain("bad gateway");

    expect(
      drawImages({ ...ENDPOINT, model: null }, { prompt: "x" }, { fetchImpl: html.fetchImpl }).then(
        (r) => r,
      ),
    ).resolves.toEqual({ ok: false, error: "no image model is configured", status: null });
  });

  test("a server that ignores n does not smuggle extra pictures into the thread", async () => {
    const { fetchImpl } = spyFetch(() => b64Reply(4));
    const result = await drawImages(ENDPOINT, { prompt: "x", n: 2 }, { fetchImpl });
    expect(pictures(result)).toHaveLength(2);
  });

  test("an svg is refused as a type, not relabeled a png", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const { fetchImpl } = spyFetch(() => jsonResponse({ data: [{ url: svg }] }));
    const result = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("image/svg+xml");
  });

  test("a url that answers with a non-image type is a named problem", async () => {
    const { fetchImpl } = spyFetch((url) =>
      url.includes("generations")
        ? jsonResponse({ data: [{ url: "http://cdn.example/x.bin" }] })
        : new Response("junk", { headers: { "content-type": "application/octet-stream" } }),
    );
    const result = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  test("a 200 whose items carry nothing says so", async () => {
    const stub = spyFetch(() => jsonResponse({ data: [{ revised_prompt: "hmm" }] }));
    const result = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: stub.fetchImpl });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("carried neither b64_json nor url");
  });

  test("a url that will not download is a named problem, not a silent short list", async () => {
    const stub = spyFetch((_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ data: [{ url: "ftp://elsewhere/1.png" }] })
        : jsonResponse({}),
    );
    const result = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: stub.fetchImpl });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("item 1 returned a ftp URL");
  });

  test("a slow server and a stopped turn are told apart", async () => {
    const slow: ImageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        // What a real fetch does with a dead signal: it refuses to start.
        if (init?.signal?.aborted) reject(new Error("aborted"));
        else
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        setTimeout(() => reject(new Error("the stub never answers")), 60_000).unref?.();
      });
    const timed = await drawImages(
      { ...ENDPOINT, timeoutMs: 20 },
      { prompt: "x" },
      { fetchImpl: slow },
    );
    expect(!timed.ok && timed.error).toContain("did not answer within 0s");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await drawImages(
      ENDPOINT,
      { prompt: "x" },
      { fetchImpl: slow, signal: controller.signal },
    );
    expect(!cancelled.ok && cancelled.error).toContain("cancelled because the turn stopped");
  });

  test("a reply names the size it drew, and a failure carries the status", async () => {
    // Top-level is OpenAI's shape; the item shape is what some proxies echo.
    const topLevel = spyFetch(() =>
      jsonResponse({ data: [{ b64_json: PNG_B64 }], size: "768x512" }),
    );
    expect(
      (await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: topLevel.fetchImpl })).ok,
    ).toBe(true);
    const reported = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: topLevel.fetchImpl });
    expect(reported.ok && reported.size).toBe("768x512");

    const perItem = spyFetch(() =>
      jsonResponse({ data: [{ b64_json: PNG_B64, size: "256x256" }] }),
    );
    const itemSize = await drawImages(ENDPOINT, { prompt: "x" }, { fetchImpl: perItem.fetchImpl });
    expect(itemSize.ok && itemSize.size).toBe("256x256");

    // Nothing echoed: "the server did not say", not a guessed echo of our ask.
    const silent = await drawImages(
      ENDPOINT,
      { prompt: "x" },
      { fetchImpl: spyFetch(() => b64Reply()).fetchImpl },
    );
    expect(silent.ok && silent.size).toBeNull();

    // The classifier downstream reads this number, not the prose.
    const refused = await drawImages(
      ENDPOINT,
      { prompt: "x" },
      { fetchImpl: spyFetch(() => jsonResponse({ error: { message: "nope" } }, 503)).fetchImpl },
    );
    expect(!refused.ok && refused.status).toBe(503);
  });

  test("describeImageError keeps a message and otherwise shows the head", () => {
    expect(describeImageError(500, "boom", null)).toBe("HTTP 500: boom");
    expect(describeImageError(500, "", null)).toBe("HTTP 500 with no message.");
    expect(describeImageError(400, '{"error":"plain"}', { error: "plain" })).toBe("plain");
  });
});

describe("drawing a face", () => {
  /** What Settings holds for a face draw: an endpoint, a model, no configured size. */
  const FACE: ImageEndpoint = {
    baseUrl: "http://img.example:8000/v1",
    apiKey: null,
    model: "flux2-klein-4b",
    size: null,
    timeoutMs: 180_000,
  };

  /** The two shapes real servers refuse a size in, quoted from the wire. */
  const fluxRefusal = (size: string) =>
    `size: '${size}' is not served by flux2-klein-4b (sizes: auto, 256x256, 512x512, 768x512, 1024x1024)`;
  const openaiRefusal = (size: string) =>
    `Invalid value: '${size}'. Supported values are: 'auto', '1024x1024'`;

  beforeEach(() => {
    faceSizes.clear();
  });

  /** The sizes the ladder actually asked for, in order (`null` = omitted). */
  function sizesAsked(calls: { body?: Record<string, unknown> }[]): (string | null)[] {
    return calls.map((call) => (typeof call.body?.size === "string" ? call.body.size : null));
  }

  /** Answers `b64Reply` unless `refuse` names this rung's size, and records the ask. */
  function ladderFetch(refuse: (size: string | null) => string | null) {
    return spyFetch((_url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const size = typeof body.size === "string" ? body.size : null;
      const message = refuse(size);
      return message ? jsonResponse({ error: { message } }, 400) : b64Reply();
    });
  }

  test("one face at a time per endpoint, whoever asks", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = spyFetch(async () => {
      await gate;
      return b64Reply();
    });
    const first = drawFace(FACE, "an owl", { fetchImpl });
    // This press lands while the first is still waiting on the server, and the server
    // runs one image request anyway: saying so now beats a longer wait for nothing.
    const second = await drawFace(FACE, "another owl", { fetchImpl });
    expect(second).toEqual({
      ok: false,
      error: "one face at a time — the last one is still being drawn.",
    });
    expect(calls.length).toBe(1);
    release();
    expect((await first).ok).toBe(true);
  });

  test("a ladder that ran out starts the next press at the server's own default", async () => {
    // Every named size refused, and the omitted one answered with a size-shaped refusal
    // too (a refusal that is not about the size would have stopped at the first rung).
    const first = ladderFetch((size) =>
      size === null ? openaiRefusal("auto") : fluxRefusal(size),
    );
    const exhausted = await drawFace(FACE, "an owl", { fetchImpl: first.fetchImpl });
    expect(exhausted.ok).toBe(false);
    expect(sizesAsked(first.calls)).toEqual(["512x512", "256x256", "1024x1024", null]);
    expect(faceSizes.remembered(FACE)).toBeNull();

    // And it is remembered: the next press does not pay for the three named rungs again.
    const next = ladderFetch(() => null);
    expect((await drawFace(FACE, "an owl", { fetchImpl: next.fetchImpl })).ok).toBe(true);
    expect(sizesAsked(next.calls)).toEqual([null]);
  });

  test("a server that draws a GIF cannot make a face", async () => {
    // The face library reads its types from magic bytes and knows three; catching it
    // here is the difference between a refusal now and one after a paid draw.
    const gif = spyFetch(
      () =>
        new Response(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), {
          headers: { "content-type": "image/gif" },
        }),
    );
    const drawn = await drawFace(FACE, "an owl", { fetchImpl: gif.fetchImpl });
    expect(drawn.ok).toBe(false);
    if (!drawn.ok) expect(drawn.error).toContain("image/gif");
  });

  test("the style prefix is applied to the typed description, not stored with it", async () => {
    const { fetchImpl, calls } = spyFetch(() => b64Reply());
    const drawn = await drawFace(FACE, "  a grumpy pixel owl  ", { fetchImpl });
    expect(drawn.ok).toBe(true);
    expect(calls[0]?.body?.prompt).toBe(
      `${FACE_STYLE_PREFIX}a grumpy pixel owl${FACE_BACKGROUND_SUFFIX}`,
    );
    // The boilerplate is short on purpose: the server's own cut must eat our words
    // before it eats the user's. 512 tokens is roughly four characters a token.
    expect(
      FACE_STYLE_PREFIX.length + FACE_BACKGROUND_SUFFIX.length + MAX_FACE_PROMPT_CHARS,
    ).toBeLessThan(512 * 4);
  });

  test("an empty or over-budget description is refused without spending a request", async () => {
    const { fetchImpl, calls } = spyFetch(() => b64Reply());
    for (const input of ["", "   ", undefined, 42, "x".repeat(MAX_FACE_PROMPT_CHARS + 1)]) {
      const drawn = await drawFace(FACE, input, { fetchImpl });
      expect(drawn.ok).toBe(false);
    }
    expect(facePromptRefusal("x".repeat(MAX_FACE_PROMPT_CHARS))).toBeNull();
    expect(facePromptRefusal("x".repeat(MAX_FACE_PROMPT_CHARS + 1))).toContain("400 characters");
    expect(calls).toEqual([]);
  });

  test("the steady state is one request, at 512x512", async () => {
    const { fetchImpl, calls } = spyFetch(() => b64Reply());
    const drawn = await drawFace(FACE, "an owl", { fetchImpl });
    expect(drawn).toEqual({ ok: true, mediaType: "image/png", size: "512x512", b64: PNG_B64 });
    expect(sizesAsked(calls)).toEqual(["512x512"]);
  });

  test("the size reported back is the server's, when it says one", async () => {
    const { fetchImpl } = spyFetch(() =>
      jsonResponse({ data: [{ b64_json: PNG_B64 }], size: "768x512" }),
    );
    const drawn = await drawFace(FACE, "an owl", { fetchImpl });
    expect(drawn.ok && drawn.size).toBe("768x512");
  });

  test("a size-shaped refusal walks one rung, and what worked is where the next draw starts", async () => {
    const first = ladderFetch((size) => (size === "512x512" ? fluxRefusal(size) : null));
    const drawn = await drawFace(FACE, "an owl", { fetchImpl: first.fetchImpl });
    expect(drawn.ok).toBe(true);
    expect(sizesAsked(first.calls)).toEqual(["512x512", "256x256"]);
    expect(faceSizes.remembered(FACE)).toBe("256x256");

    // Steady state again: the ladder does not re-run after one fast refusal.
    const second = ladderFetch(() => null);
    await drawFace(FACE, "an owl", { fetchImpl: second.fetchImpl });
    expect(sizesAsked(second.calls)).toEqual(["256x256"]);
  });

  test("both real refusal messages are size-shaped, and a 400 that names neither is not", () => {
    expect(sizeShapedRefusal(400, fluxRefusal("512x512"), "512x512")).toBe(true);
    // The OpenAI-family shape never says the word `size`; the quoted value is the tell.
    expect(sizeShapedRefusal(400, openaiRefusal("512x512"), "512x512")).toBe(true);
    expect(sizeShapedRefusal(400, "prompt is too long", "512x512")).toBe(false);
    // Saying the word "size" is not enough: a prompt-length refusal is the same answer
    // at every rung, and walking the ladder would spend four real draws repeating it.
    expect(
      sizeShapedRefusal(400, "the size of your prompt exceeds the model's context", "512x512"),
    ).toBe(false);
    // A server that lists what it serves in `WxH` form is answering the question even
    // when it never quotes what was asked.
    expect(sizeShapedRefusal(400, "size must be one of: 512x512, 1024x1024", "256x256")).toBe(true);
    // A size-shaped sentence at the wrong status is somebody else's problem.
    expect(sizeShapedRefusal(500, fluxRefusal("512x512"), "512x512")).toBe(false);
    expect(sizeShapedRefusal(null, fluxRefusal("512x512"), "512x512")).toBe(false);
  });

  test("a refusal that is not about the size stops at once and is remembered as nothing", async () => {
    for (const [status, message] of [
      [400, "prompt is too long"],
      [401, "invalid api key"],
      [404, "no such model"],
      [500, "internal error"],
      [503, "the NPU queue is full"],
    ] as const) {
      const { fetchImpl, calls } = spyFetch(() => jsonResponse({ error: { message } }, status));
      const drawn = await drawFace(FACE, "an owl", { fetchImpl });
      expect(drawn).toEqual({ ok: false, error: message });
      expect(calls).toHaveLength(1);
      expect(faceSizes.remembered(FACE)).toBeUndefined();
    }
  });

  test("the omitted size is the last rung, and it catches a server that serves none we name", async () => {
    const { fetchImpl, calls } = ladderFetch((size) => (size ? fluxRefusal(size) : null));
    const drawn = await drawFace(FACE, "an owl", { fetchImpl });
    expect(drawn.ok).toBe(true);
    expect(sizesAsked(calls)).toEqual(["512x512", "256x256", "1024x1024", null]);

    // A server that takes only names we never got to ask starts there next time.
    const again = ladderFetch((size) => (size ? fluxRefusal(size) : null));
    await drawFace(FACE, "an owl", { fetchImpl: again.fetchImpl });
    expect(sizesAsked(again.calls)).toEqual([null]);
  });

  test("the last rung asks for nothing — not for the operator's configured default", async () => {
    const configured = { ...FACE, size: "1024x1024" };
    const { fetchImpl, calls } = ladderFetch((size) => (size ? fluxRefusal(size) : null));
    expect((await drawFace(configured, "an owl", { fetchImpl })).ok).toBe(true);
    expect(calls[3]?.body).not.toHaveProperty("size");
  });

  test("a server that refuses every size is answered with its own last message", async () => {
    const { fetchImpl, calls } = ladderFetch((size) =>
      size ? fluxRefusal(size) : "no default size is loaded for this model",
    );
    const drawn = await drawFace(FACE, "an owl", { fetchImpl });
    expect(drawn).toEqual({ ok: false, error: "no default size is loaded for this model" });
    expect(calls).toHaveLength(4);
  });

  test("an endpoint with no URL or no model is a refusal, with nothing asked of it", async () => {
    for (const endpoint of [
      { ...FACE, baseUrl: "" },
      { ...FACE, model: null },
    ]) {
      const { fetchImpl, calls } = spyFetch(() => b64Reply());
      const drawn = await drawFace(endpoint, "an owl", { fetchImpl });
      expect(drawn.ok).toBe(false);
      expect(!drawn.ok && drawn.error).toContain("nothing to draw with");
      expect(calls).toEqual([]);
    }
  });

  test("a server echoing the key it refused is redacted before the browser sees it", async () => {
    const keyed = { ...FACE, apiKey: "sk-face-me" };
    const { fetchImpl } = spyFetch(
      () => new Response("invalid api key sk-face-me", { status: 401 }),
    );
    const drawn = await drawFace(keyed, "an owl", { fetchImpl });
    expect(!drawn.ok && drawn.error).toContain("[redacted]");
    expect(!drawn.ok && drawn.error).not.toContain("sk-face-me");
  });
});

describe("generate_image's handler", () => {
  const deps = (settings: typeof SETTINGS, reply: () => Response) => ({
    settings: async () => settings,
    fetchImpl: spyFetch(() => reply()).fetchImpl,
  });

  test("unconfigured is a refusal that names Settings", async () => {
    const answer = await generateImageTool(
      { prompt: "a fox" },
      { settings: async () => DEFAULT_IMAGES_SETTINGS },
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Settings → Image generation");
  });

  test("arguments are validated before anything is asked of the server", async () => {
    const calls: string[] = [];
    const counting = {
      settings: async () => SETTINGS,
      fetchImpl: (async () => {
        calls.push("draw");
        return b64Reply();
      }) satisfies ImageFetch,
    };
    expect((await generateImageTool({ prompt: "  " }, counting)).isError).toBe(true);
    expect((await generateImageTool({ prompt: "x", size: "big" }, counting)).text).toContain(
      "WIDTHxHEIGHT",
    );
    expect((await generateImageTool({ prompt: "x", n: 9 }, counting)).text).toContain("1 to 4");
    expect((await generateImageTool({ prompt: "x", seed: -1 }, counting)).text).toContain("seed");
    expect(calls).toEqual([]);
  });

  test("the answer names size, seed and where each file went, and carries the bytes", async () => {
    const answer = await generateImageTool(
      { prompt: "A red fox, in snow!", n: 2, seed: 42 },
      deps(SETTINGS, () => b64Reply(2)),
    );
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Drew 2 pictures at 1024x1024 with seed 42.");
    expect(answer.text).toContain(
      "Saved to generated/a-red-fox-in-snow-1.png, generated/a-red-fox-in-snow-2.png.",
    );
    // Facts only: the coaching sentence belongs to the tool description, and a
    // slow draw shows this text in the transcript.
    expect(answer.text).not.toContain("attached to this result");
    expect(answer.images).toEqual([
      { b64: PNG_B64, path: "generated/a-red-fox-in-snow-1.png" },
      { b64: PNG_B64, path: "generated/a-red-fox-in-snow-2.png" },
    ]);
    expect(slugifyPrompt("!!!")).toBe("image");
  });

  test("a jpeg answer is saved with the extension it actually is", async () => {
    const jpeg = spyFetch(() =>
      jsonResponse({ data: [{ url: "data:image/jpeg;base64," + PNG_B64 }] }),
    );
    const answer = await generateImageTool(
      { prompt: "a fox" },
      { settings: async () => SETTINGS, fetchImpl: jpeg.fetchImpl },
    );
    expect(answer.images?.[0]?.path).toBe("generated/a-fox-1.jpg");
  });

  test("the server's own refusal is the answer's text", async () => {
    const answer = await generateImageTool(
      { prompt: "a fox", n: 4 },
      deps(SETTINGS, () => new Response("this server draws one image at a time", { status: 400 })),
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe(
      "generate_image failed: HTTP 400: this server draws one image at a time",
    );
  });

  test("a server echoing the key it refused is redacted before it persists", async () => {
    const withKey = { ...SETTINGS, apiKey: "sk-leak-me" };
    const answer = await generateImageTool(
      { prompt: "a fox" },
      deps(withKey, () => new Response("invalid api key sk-leak-me", { status: 401 })),
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("[redacted]");
    expect(answer.text).not.toContain("sk-leak-me");
  });

  test("reached the way a mod reaches it: loopback POST, same answer", async () => {
    const handlers = new Map<string, ToolHandler>([
      [
        "generate_image",
        (args, context) =>
          generateImageTool(
            args,
            deps(SETTINGS, () => b64Reply()),
            context,
          ),
      ],
    ]);
    const response = await handleInternalTools(
      new Request("http://127.0.0.1:8080/internal/tools/generate_image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a fox" }),
      }),
      "127.0.0.1",
      () => handlers,
    );
    expect(response).not.toBeNull();
    const answer = (await response?.json()) as ToolAnswer;
    expect(answer.isError).toBe(false);
    expect(answer.images?.[0]?.path).toBe("generated/a-fox-1.png");
  });
});

describe("the rendered mod", () => {
  const dir = mkdtempSync(join(tmpdir(), "images-mod-"));
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function activate(source: string) {
    const file = join(dir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, source);
    const mod = (await import(file)) as { default: (letta: unknown) => unknown };
    const registered: Record<string, unknown>[] = [];
    const disposer = mod.default({
      capabilities: { tools: true },
      tools: {
        register(tool: Record<string, unknown>) {
          registered.push(tool);
          return () => {};
        },
      },
    });
    return { registered, disposer };
  }

  test("off registers nothing; on registers generate_image, auto and parallel-safe", async () => {
    expect(await activate(renderImagesMod({ enabled: false, port: 8080 }))).toMatchObject({
      registered: [],
    });
    expect(renderImagesMod({ enabled: false, port: 8080 })).toContain("registers nothing");

    const { registered, disposer } = await activate(renderImagesMod({ enabled: true, port: 8080 }));
    expect(registered.map((tool) => tool.name)).toEqual(["generate_image"]);
    expect(registered[0]?.requiresApproval).toBe(false);
    expect(registered[0]?.parallelSafe).toBe(true);
    const parameters = registered[0]?.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(parameters.required).toEqual(["prompt"]);
    expect(Object.keys(parameters.properties)).toEqual(["prompt", "size", "n", "seed"]);
    expect(typeof disposer).toBe("function");
    expect(IMAGE_TOOL_SPECS[0]?.name).toBe("generate_image");
  });

  test("the mod writes each picture into the workspace and returns image content", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "images-workspace-"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          text: "Drew 1 picture at 1024x1024.",
          isError: false,
          images: [{ b64: PNG_B64, path: "generated/a-fox-1.png" }],
        }),
      )) as unknown as typeof fetch;
    const { registered } = await activate(renderImagesMod({ enabled: true, port: 8080 }));
    const run = registered[0]?.run as (ctx: unknown) => Promise<unknown>;
    const parts = (await run({
      args: { prompt: "a fox" },
      cwd,
      signal: new AbortController().signal,
    })) as {
      type: string;
      text?: string;
      source?: { type: string; media_type: string; data: string };
    }[];
    expect(readFileSync(join(cwd, "generated/a-fox-1.png")).toString("base64")).toBe(PNG_B64);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Drew 1 picture at 1024x1024." });
    expect(parts[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a picture whose path leaves the workspace is refused, not written", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "images-workspace-"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          text: "Drew 1 picture.",
          isError: false,
          images: [{ b64: PNG_B64, path: "../escaped.png" }],
        }),
      )) as unknown as typeof fetch;
    const { registered } = await activate(renderImagesMod({ enabled: true, port: 8080 }));
    const run = registered[0]?.run as (ctx: unknown) => Promise<unknown>;
    const answer = (await run({ args: {}, cwd, signal: new AbortController().signal })) as string;
    // Text only, with the refusal said: no content array, and nothing outside the workspace.
    expect(typeof answer).toBe("string");
    expect(answer).toContain("Drew 1 picture.");
    expect(answer).toContain("left the workspace");
    expect(rmSync(join(cwd, "..", "escaped.png"), { force: true })).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("teardown", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("images routes", () => {
  async function routes(imagesEnabled = true, reply: () => Response = () => b64Reply()) {
    const dir = mkdtempSync(join(tmpdir(), "images-routes-"));
    const store = new ImagesSettingsStore(join(dir, "settings.json"));
    const files = new Map<string, string>([
      [IMAGES_MOD_PATH, "export default function activate() {}"],
    ]);
    const resyncs: string[] = [];
    const app = new Hono<RouteEnv>();
    const spy = spyFetch(() => reply());
    registerImagesRoutes(app, {
      imagesEnabled,
      store,
      isReady: () => true,
      read: async (path: string) => files.get(path) ?? null,
      resyncMods: async (reason: string) => {
        resyncs.push(reason);
        return "reloaded";
      },
      fetchImpl: spy.fetchImpl,
    });
    return { app, store, files, resyncs, dir, calls: spy.calls };
  }

  test("the token off is a 404 on all five, as if the routes were not there", async () => {
    const { app } = await routes(false);
    expect((await app.fetch(new Request("http://x/api/images/settings"))).status).toBe(404);
    expect(
      (
        await app.fetch(
          new Request("http://x/api/images/settings", {
            method: "PUT",
            body: "{}",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(404);
    expect((await app.fetch(new Request("http://x/api/images/status"))).status).toBe(404);
    expect(
      (await app.fetch(new Request("http://x/api/images/test", { method: "POST", body: "{}" })))
        .status,
    ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request("http://x/api/images/draw-face", {
            method: "POST",
            body: JSON.stringify({ prompt: "an owl" }),
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("a body that is not JSON is a 400, not a crash", async () => {
    const { app } = await routes();
    const plain = await app.fetch(
      new Request("http://x/api/images/draw-face", {
        method: "POST",
        body: "an owl in a scarf",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(plain.status).toBe(400);
  });

  test("GET hands the Draw tab the style line it must show, in the draw's own words", async () => {
    const { app } = await routes();
    const answer = (await (
      await app.fetch(new Request("http://x/api/images/settings"))
    ).json()) as {
      faceStylePrefix?: string;
    };
    // A hint written into the UI would be a hint that silently disagrees with what is
    // sent; the sheet renders this string instead of a copy of it.
    expect(answer.faceStylePrefix).toBe(FACE_STYLE_PREFIX);
  });

  test("GET never echoes the key; PUT saves, clears and re-syncs the mod", async () => {
    const { app, resyncs } = await routes();
    expect(
      await (await app.fetch(new Request("http://x/api/images/settings"))).json(),
    ).toMatchObject({
      settings: { enabled: false, hasKey: false, baseUrl: "" },
    });

    const put = (body: unknown) =>
      app.fetch(
        new Request("http://x/api/images/settings", {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      );

    expect((await put({ enabled: true })).status).toBe(400);
    const saved = await put({
      enabled: true,
      baseUrl: "http://img.example:8000/v1",
      model: "flux-dev",
      apiKey: "sk-secret",
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { settings: Record<string, unknown>; mod: string };
    expect(body.mod).toBe("reloaded");
    expect(body.settings).toMatchObject({ enabled: true, hasKey: true, model: "flux-dev" });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(resyncs).toEqual(["Settings → Image generation"]);

    // An empty key field keeps the stored one; only clearApiKey removes it.
    expect(
      ((await (await put({ model: "sdxl" })).json()) as { settings: Record<string, unknown> })
        .settings.hasKey,
    ).toBe(true);
    expect(
      ((await (await put({ clearApiKey: true })).json()) as { settings: Record<string, unknown> })
        .settings.hasKey,
    ).toBe(false);
  });

  test("status reports the mod's own load errors, not the endpoint's health", async () => {
    const { app, files } = await routes();
    files.set(
      "/root/.letta/mods/diagnostics/latest.json",
      JSON.stringify({
        generatedAt: Date.now(),
        report: {
          diagnostics: [
            { mod: { path: IMAGES_MOD_PATH }, phase: "import", message: "boom", severity: "error" },
          ],
        },
      }),
    );
    const status = (await (
      await app.fetch(new Request("http://x/api/images/status"))
    ).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      enabled: false,
      configured: false,
      modInstalled: true,
      hasKey: false,
    });
    expect(status.modErrors).toEqual(["import: boom"]);
    expect(modErrorsFrom(null)).toEqual([]);
  });

  test("the test draw needs an endpoint, then returns the picture as a data URL", async () => {
    const { app } = await routes();
    const draw = () =>
      app.fetch(new Request("http://x/api/images/test", { method: "POST", body: "{}" }));
    expect((await draw()).status).toBe(400);

    await app.fetch(
      new Request("http://x/api/images/settings", {
        method: "PUT",
        body: JSON.stringify({ baseUrl: "http://img.example:8000/v1", model: "flux-dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const result = (await (await draw()).json()) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.mediaType).toBe("image/png");
    expect(result.dataUrl).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  const configure = (app: Hono<RouteEnv>) =>
    app.fetch(
      new Request("http://x/api/images/settings", {
        method: "PUT",
        body: JSON.stringify({ baseUrl: "http://img.example:8000/v1", model: "flux-dev" }),
        headers: { "content-type": "application/json" },
      }),
    );

  const postFace = (app: Hono<RouteEnv>, prompt: unknown) =>
    app.fetch(
      new Request("http://x/api/images/draw-face", {
        method: "POST",
        body: JSON.stringify({ prompt }),
        headers: { "content-type": "application/json" },
      }),
    );

  test("draw-face refuses locally without spending a request, then answers the face", async () => {
    faceSizes.clear();
    const { app, calls } = await routes();
    // A blank and an over-budget prompt are local answers, and neither draws.
    expect((await postFace(app, "   ")).status).toBe(400);
    expect((await postFace(app, "x".repeat(MAX_FACE_PROMPT_CHARS + 1))).status).toBe(400);
    // Nothing configured yet: the refusal is the same 400 the test draw gives.
    expect((await postFace(app, "an owl in a scarf")).status).toBe(400);
    expect(calls).toEqual([]);

    await configure(app);
    const ok = (await (await postFace(app, "an owl in a scarf")).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, mediaType: "image/png", size: "512x512" });
    expect(ok.dataUrl).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(calls[0]?.body?.prompt).toBe(
      `${FACE_STYLE_PREFIX}an owl in a scarf${FACE_BACKGROUND_SUFFIX}`,
    );
  });

  test("draw-face answers a failed draw as 502 with the server's words, key redacted", async () => {
    faceSizes.clear();
    const { app } = await routes(
      true,
      () => new Response("invalid api key sk-draw-me", { status: 401 }),
    );
    await app.fetch(
      new Request("http://x/api/images/settings", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: "http://img.example:8000/v1",
          model: "flux-dev",
          apiKey: "sk-draw-me",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await postFace(app, "an owl");
    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("invalid api key");
    expect(body).not.toContain("sk-draw-me");
  });
});
