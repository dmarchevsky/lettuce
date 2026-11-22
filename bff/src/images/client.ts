/**
 * The universal OpenAI-compatible image client.
 *
 * One request shape, `{model, prompt, n?, size?, response_format:"b64_json"}`,
 * is what OpenAI itself, Together, OVMS, LocalAI, stable-diffusion.cpp's server
 * and assorted proxies all answer. Everything a real deployment differs on is
 * handled by being tolerant at the edges rather than by growing options:
 *
 * - `seed` is a non-standard extension, so it is sent **only** when the tool
 *   call passed one — a server that refuses unknown fields says so itself, in
 *   words the agent can act on.
 * - A `data[]` item carries `b64_json` or `url` (and a `url` may be a `data:`
 *   URL or an `http(s)` one, which the BFF fetches server-side; a browser never
 *   gets a mixed-content problem because it never talks to the image server).
 * - A server that ignores `response_format` and answers with image bytes
 *   outright is still understood.
 * - Errors are usually `{"error":{"message":…}}` but plain text happens; either
 *   way the message reaches the model as-is, because the agent's next move
 *   (drop `n`, change the size) depends on the server's own wording.
 */

import { type ImagesSettings, imagesEndpointUrl } from "./settings.ts";

export type ImageFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the client needs to know about the endpoint: the saved settings, minus `enabled`. */
export type ImageEndpoint = Pick<
  ImagesSettings,
  "baseUrl" | "apiKey" | "model" | "size" | "timeoutMs"
>;

export interface DrawRequest {
  prompt: string;
  /** `WxH`; falls back to the configured default size. */
  size?: string;
  /** How many pictures to ask for. Omitted means the server's own default (1). */
  n?: number;
  /** Extension: only sent when the caller passed one. */
  seed?: number;
}

export interface DrawedImage {
  b64: string;
  mediaType: string;
}

/**
 * `size` on success is the size the **server reported**, not the one we asked
 * for — a server that ignores `size` and answers its own default is common
 * enough that the caller must not assume its request was honoured. `status` on
 * failure is the HTTP status, or null when there was no HTTP answer at all (a
 * timeout, a dead endpoint): a caller that decides what to retry reads the
 * number rather than re-deriving it from the prose.
 */
export type DrawResult =
  | { ok: true; images: DrawedImage[]; size: string | null }
  | { ok: false; error: string; status: number | null };

/** The most body to show back when it is not JSON anybody recognises. */
const BODY_HEAD = 400;

/**
 * What a picture may be. The transcript, the workspace file and the model's
 * image part all carry a media type, and an image type outside this set (SVG
 * above all — a drawable vector that is also a script vector) would be
 * mislabeled everywhere downstream, so the client refuses it here instead.
 */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The biggest picture one reply item may carry, base64 or fetched. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_B64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);

export function endpointFromSettings(settings: ImagesSettings): ImageEndpoint {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    size: settings.size,
    timeoutMs: settings.timeoutMs,
  };
}

/**
 * The request body: the minimal universal shape and nothing else — no quality,
 * style, steps or guidance, because those are the fields servers reject.
 */
export function imageRequestBody(
  request: DrawRequest,
  endpoint: ImageEndpoint,
  size: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    prompt: request.prompt,
  };
  if (request.n !== undefined) body.n = request.n;
  if (size) body.size = size;
  body.response_format = "b64_json";
  // Last, and only when asked for: it is an extension, and a strict server
  // refuses the whole request for it.
  if (request.seed !== undefined) body.seed = request.seed;
  return body;
}

function head(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, BODY_HEAD);
}

/** `{"error":{"message":…}}`, `{"error":"…"}`, or the head of whatever came back. */
export function describeImageError(status: number, text: string, json: unknown): string {
  if (json && typeof json === "object") {
    const error = (json as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  const body = head(text);
  return body ? `HTTP ${status}: ${body}` : `HTTP ${status} with no message.`;
}

function mediaTypeOfUrl(url: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match?.[1] ?? null;
}

function base64OfBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** A `data:` URL is already base64 with a label on it; anything else is fetched. */
async function imageFromUrl(
  url: string,
  fetchImpl: ImageFetch,
  signal: AbortSignal,
): Promise<DrawedImage | string> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const mediaType = mediaTypeOfUrl(url) ?? "image/png";
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return `a data: URL of type ${mediaType}`;
    const payload = comma >= 0 ? url.slice(comma + 1) : "";
    if (!payload) return "a data: URL with no payload";
    if (payload.length > MAX_B64_CHARS) return "a picture larger than 25 MiB";
    return { b64: payload, mediaType };
  }
  if (!/^https?:\/\//i.test(url)) {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1] ?? "unknown-scheme";
    return `a ${scheme} URL, which the BFF will not fetch`;
  }
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return `a URL that answered HTTP ${response.status}`;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return "a picture larger than 25 MiB";
    const type = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!type?.startsWith("image/")) return `a URL that is not an image (${type || "unknown"})`;
    if (!ALLOWED_IMAGE_TYPES.has(type)) return `a URL of type ${type}`;
    return { b64: base64OfBytes(bytes), mediaType: type };
  } catch (error) {
    return `a URL the BFF could not fetch (${error instanceof Error ? error.message : error})`;
  }
}

/**
 * One `data[]` item each: `b64_json` or `url`, and a `url` may be a `data:` URL
 * or an `http(s)` one the BFF has to fetch. Anything unusable is named in
 * `problems` instead of silently shrinking the answer to fewer pictures.
 */
async function collectImages(
  data: unknown[],
  fetchImpl: ImageFetch,
  signal: AbortSignal,
): Promise<{ images: DrawedImage[]; problems: string[] }> {
  const images: DrawedImage[] = [];
  const problems: string[] = [];
  for (const [index, item] of data.entries()) {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    if (typeof entry.b64_json === "string" && entry.b64_json) {
      if (entry.b64_json.length > MAX_B64_CHARS) {
        problems.push(`item ${index + 1} is a picture larger than 25 MiB`);
      } else {
        images.push({ b64: entry.b64_json, mediaType: "image/png" });
      }
      continue;
    }
    if (typeof entry.url === "string" && entry.url) {
      const resolved = await imageFromUrl(entry.url, fetchImpl, signal);
      if (typeof resolved === "string") problems.push(`item ${index + 1} returned ${resolved}`);
      else images.push(resolved);
      continue;
    }
    problems.push(`item ${index + 1} carried neither b64_json nor url`);
  }
  return { images, problems };
}

/**
 * Parse a successful reply: `data[]` items with `b64_json` or `url`, or raw
 * image bytes. `maxImages` is what the request asked for: a server that
 * ignores `n` answers with more, and every extra picture would ride every
 * later model call of the conversation.
 */
export async function parseImageReply(
  response: Response,
  fetchImpl: ImageFetch,
  signal: AbortSignal,
  maxImages?: number,
): Promise<DrawResult> {
  const contentType = response.headers.get("content-type") ?? "";
  // A server that ignores response_format and answers with the picture itself.
  if (response.ok && contentType.startsWith("image/") && ALLOWED_IMAGE_TYPES.has(contentType)) {
    const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES)
      return {
        ok: true,
        images: [{ b64: base64OfBytes(bytes), mediaType: contentType }],
        size: null,
      };
  }
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  if (!response.ok)
    return {
      ok: false,
      error: describeImageError(response.status, text, json),
      status: response.status,
    };

  const data = json && typeof json === "object" ? (json as { data?: unknown }).data : undefined;
  const { images, problems } = Array.isArray(data)
    ? await collectImages(data as unknown[], fetchImpl, signal)
    : { images: [], problems: [] };
  // A server that ignored `n` must not smuggle extra pictures into the thread.
  const kept =
    maxImages !== undefined && images.length > maxImages ? images.slice(0, maxImages) : images;
  if (kept.length > 0) return { ok: true, images: kept, size: reportedSize(json) };

  // A 200 that says no — some proxies wrap the failure that way.
  const asText = describeImageError(response.status, text, json);
  const why = problems.length ? `${asText} (${problems.join("; ")})` : asText;
  return {
    ok: false,
    error: json === null ? `the reply was not JSON — ${why}` : why,
    status: response.status,
  };
}

/**
 * The size a server echoed back, if it echoed one at all: top-level (OpenAI's
 * own shape) or on the first item (what some proxies do). Anything not a
 * non-empty string is "it did not say", which is a different fact from "it
 * answered the size we asked for".
 */
function reportedSize(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const top = (json as { size?: unknown }).size;
  if (typeof top === "string" && top.trim()) return top.trim();
  const data = (json as { data?: unknown }).data;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (first && typeof first === "object") {
    const item = (first as { size?: unknown }).size;
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

/** Cancellation that distinguishes "the turn stopped" from "this server is slow". */
function linkSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; reason: () => "timeout" | "caller" | null; dispose: () => void } {
  const controller = new AbortController();
  let why: "timeout" | "caller" | null = null;
  const onAbort = () => {
    why = "caller";
    controller.abort();
  };
  // A caller already stopped: say so immediately, so the fetch is never attempted.
  if (caller?.aborted) {
    why = "caller";
    controller.abort();
  } else if (caller) caller.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    why = "timeout";
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    reason: () => why,
    dispose: () => {
      clearTimeout(timer);
      if (caller) caller.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * One generation: POST, parse, hand back pictures or a message.
 *
 * Never throws for anything the server did; a network failure is a message too.
 * The turn's own cancellation is forwarded, so a stopped turn cancels the draw
 * instead of paying for a picture nobody will read.
 */
export async function drawImages(
  endpoint: ImageEndpoint,
  request: DrawRequest,
  options: { fetchImpl?: ImageFetch; signal?: AbortSignal } = {},
): Promise<DrawResult> {
  const fetchImpl: ImageFetch = options.fetchImpl ?? fetch;
  if (!endpoint.model) return { ok: false, error: "no image model is configured", status: null };
  const url = imagesEndpointUrl(endpoint.baseUrl);
  const size = request.size ?? endpoint.size ?? null;
  const linked = linkSignals(options.signal, endpoint.timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Only when a key exists: a local server with auth off rejects the header.
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(imageRequestBody(request, endpoint, size)),
      signal: linked.signal,
    });
    return await parseImageReply(response, fetchImpl, linked.signal, request.n);
  } catch (error) {
    // Which of the two causes fired decides the wording the agent acts on: a
    // stopped turn is not a dead server, and a busy queue is worth retrying.
    if (linked.reason() === "caller") {
      return {
        ok: false,
        error: "the generation was cancelled because the turn stopped.",
        status: null,
      };
    }
    if (linked.reason() === "timeout") {
      return {
        ok: false,
        error: `the image server did not answer within ${Math.round(endpoint.timeoutMs / 1000)}s — its queue may be busy, or the request too large.`,
        status: null,
      };
    }
    return {
      ok: false,
      error: `the image server could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      status: null,
    };
  } finally {
    linked.dispose();
  }
}
