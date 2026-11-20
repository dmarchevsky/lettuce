/**
 * Settings → Image generation: the endpoint every agent's `generate_image`
 * tool draws through.
 *
 * The endpoint is **pure configuration**: nothing is bundled, no server is
 * hard-coded, and there is no default model. What the settings describe is any
 * OpenAI-compatible `POST {base}/images/generations` — OpenAI itself, Together,
 * OVMS, LocalAI, stable-diffusion.cpp's server, or a proxy in front of anything
 * else (`client.ts` is written for that spread).
 *
 * They live on the BFF's own `bff-data` volume, **not** on letta-home like the
 * web-tools switch: the API key must not be readable by agent shells, which
 * mount the state tree read-write as uid 0 (the same reason the sign-in password
 * hash sits on `bff-auth`). The key is write-only from the browser's side — no
 * route echoes it, only `hasKey` (the provider-store precedent).
 */

export interface ImagesSettings {
  /** Whether the tool exists at all (the `images` compose token must also be on). */
  enabled: boolean;
  /**
   * Endpoint root, ending at `/v1` (or any path prefix that already points at
   * the API root). The client joins `{baseUrl}/images/generations`; there is no
   * baked default.
   */
  baseUrl: string;
  /** Sent as `Authorization: Bearer` when set; absent is legal for local servers. */
  apiKey: string | null;
  /** Free text — the server's own model id. No default, because there is none. */
  model: string | null;
  /** Default `WxH` size, e.g. `1024x1024`. The server decides what is valid. */
  size: string | null;
  /** Per-generation ceiling: local queues are slow. Bounds are checked on save. */
  timeoutMs: number;
}

/** What a browser may see: the key is reduced to whether one is set. */
export type PublicImagesSettings = Omit<ImagesSettings, "apiKey"> & { hasKey: boolean };

/** Local queues queue; three minutes is what a slow text-to-image hop costs. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;
export const MIN_IMAGE_TIMEOUT_MS = 5_000;
export const MAX_IMAGE_TIMEOUT_MS = 900_000;

export const DEFAULT_IMAGES_SETTINGS: ImagesSettings = {
  enabled: false,
  baseUrl: "",
  apiKey: null,
  model: null,
  size: null,
  timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
};

/** The shape `WxH` both families of server take, e.g. `1024x1024`. */
const IMAGE_SIZE = /^\d{2,5}x\d{2,5}$/;

export class InvalidImagesSettingsError extends Error {}

export function toPublicImagesSettings(settings: ImagesSettings): PublicImagesSettings {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasKey: apiKey !== null };
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timeoutOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= MIN_IMAGE_TIMEOUT_MS
    ? Math.min(Number(value), MAX_IMAGE_TIMEOUT_MS)
    : fallback;
}

/** Lenient: a missing, hand-edited or older file still loads, defaults filling gaps. */
export function parseStoredImagesSettings(text: string | null): ImagesSettings {
  if (!text) return { ...DEFAULT_IMAGES_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_IMAGES_SETTINGS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_IMAGES_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl.trim().replace(/\/+$/, "") : "",
    apiKey: trimmedOrNull(record.apiKey),
    model: trimmedOrNull(record.model),
    size: sizeOr(record.size),
    timeoutMs: timeoutOr(record.timeoutMs, DEFAULT_IMAGE_TIMEOUT_MS),
  };
}

/** A stored size that cannot be `WxH` is nobody's default: dropped, not fatal. */
function sizeOr(value: unknown): string | null {
  const size = trimmedOrNull(value);
  return size && IMAGE_SIZE.test(size) ? size : null;
}

export function renderStoredImagesSettings(settings: ImagesSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Merge a browser update into the saved settings. `apiKey` is only replaced when
 * the body carries a non-empty string — an absent or empty one keeps the stored
 * key, so the form can show `hasKey` without holding the key. `clearApiKey:
 * true` is the one way to remove it. Throws InvalidImagesSettingsError on
 * anything unusable.
 */
export function applyImagesSettingsUpdate(current: ImagesSettings, body: unknown): ImagesSettings {
  if (!body || typeof body !== "object") {
    throw new InvalidImagesSettingsError("Expected a JSON object");
  }
  const r = body as Record<string, unknown>;
  const next: ImagesSettings = { ...current };

  if ("enabled" in r) {
    if (typeof r.enabled !== "boolean") {
      throw new InvalidImagesSettingsError("`enabled` must be true or false");
    }
    next.enabled = r.enabled;
  }
  if ("baseUrl" in r) {
    if (typeof r.baseUrl !== "string")
      throw new InvalidImagesSettingsError("`baseUrl` must be a string");
    next.baseUrl = r.baseUrl.trim().replace(/\/+$/, "");
    if (next.baseUrl) assertHttpUrl(next.baseUrl, "`baseUrl`");
  }
  if ("model" in r) next.model = trimmedOrNull(r.model);
  if ("size" in r) {
    if (r.size !== null && typeof r.size !== "string") {
      throw new InvalidImagesSettingsError("`size` must be a WxH string or null");
    }
    const size = trimmedOrNull(r.size);
    if (size && !IMAGE_SIZE.test(size)) {
      throw new InvalidImagesSettingsError("`size` must be WIDTHxHEIGHT, like 1024x1024");
    }
    next.size = size;
  }
  if ("timeoutMs" in r) {
    const ms = Number(r.timeoutMs);
    if (!Number.isInteger(ms) || ms < MIN_IMAGE_TIMEOUT_MS || ms > MAX_IMAGE_TIMEOUT_MS) {
      throw new InvalidImagesSettingsError(
        `\`timeoutMs\` must be ${MIN_IMAGE_TIMEOUT_MS}..${MAX_IMAGE_TIMEOUT_MS}`,
      );
    }
    next.timeoutMs = ms;
  }
  if (r.clearApiKey === true) next.apiKey = null;
  if (typeof r.apiKey === "string" && r.apiKey.trim()) next.apiKey = r.apiKey.trim();

  if (next.enabled) {
    if (!next.baseUrl) {
      throw new InvalidImagesSettingsError("`baseUrl` is required to enable image generation");
    }
    if (!next.model) {
      throw new InvalidImagesSettingsError("`model` is required to enable image generation");
    }
  }
  return next;
}

function assertHttpUrl(value: string, what: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidImagesSettingsError(`${what} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidImagesSettingsError(`${what} must be an http(s) URL`);
  }
}

/**
 * Whether the settings are complete enough to draw with — and so whether the
 * mod registers the tool at all. No key required: a local server usually has
 * none.
 */
export function imagesConfigured(settings: ImagesSettings): boolean {
  return settings.enabled && imagesEndpointUsable(settings);
}

/**
 * Whether an endpoint and a model are known — everything a draw needs, minus the
 * switch. The Settings *test draw* is allowed on this, so the operator can prove
 * an endpoint answers before enabling the tool for the agents.
 */
export function imagesEndpointUsable(settings: ImagesSettings): boolean {
  return settings.baseUrl !== "" && settings.model !== null;
}

/** `{base}/images/generations`, tolerating a base that already names the path. */
export function imagesEndpointUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/images/generations") ? base : `${base}/images/generations`;
}
