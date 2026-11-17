/**
 * The provider registry: what an operator adds in Settings → Providers & models.
 *
 * A provider is a named endpoint with a handle prefix of its own (`llama-3b/…`),
 * registered into the app-server by the providers mod — NOT by
 * `connect_provider`. Upstream keys its connections on the provider id and
 * refuses a name outside that provider's own aliases
 * (`connect-provider-service.ts`), so it can hold exactly one connection per
 * type; the mod is the only way two providers can share a type (`llama 3b` and
 * `llama 70b`, two Anthropic keys) and the only way a handle prefix can be a
 * word the operator chose.
 *
 * The type decides the pi-ai api and the default base URL, taken from pi-ai's own
 * provider catalog (`@earendil-works/pi-ai/dist/providers/data/*.json`), so the
 * type list is the catalog pi-ai can actually drive rather than a wish list.
 * Types needing vendor credentials or an interactive OAuth flow (Bedrock, Vertex,
 * Azure, Copilot, the ChatGPT/Claude plans) are absent: the mod takes
 * `{api, baseUrl, apiKey, models}` and nothing else, so those stay with
 * `letta connect` on the app-server host.
 *
 * The mod cannot register a model id holding "/" (`modModelIdProblem`), so the
 * types whose catalogs name models `vendor/model` — OpenRouter and the other
 * hosted routers — are the exception: they carry a `connection` and a save
 * becomes `connect_provider`, one connection per type.
 */

import { modModelIdProblem, PROVIDER_ID_RE } from "./vision.ts";

export type ProviderScope = "local" | "cloud";

export interface ProviderType {
  id: string;
  label: string;
  scope: ProviderScope;
  /** The pi-ai api the endpoint speaks, as the mod registers it. */
  api: string;
  /** Prefilled base URL, editable. Empty means the operator must type one. */
  baseUrl: string;
  /** Whether a key is expected (a local endpoint usually needs none). */
  keyOptional: boolean;
  /**
   * The app-server's own local connection (`connect_provider` provider_id) that
   * serves this type instead of the providers mod. Set where the catalog's model
   * ids hold "/", which the mod cannot register (`modModelIdProblem`). Upstream
   * keys a connection on this id, so there is one per type and its handle
   * prefix is the id: docs/upstream-notes.md#provider-mod-slash-ids.
   */
  connection?: string;
  /** What a base URL other than `baseUrl` costs, shown under the field when one is typed. */
  endpointNote?: string;
}

export const PROVIDER_TYPES: readonly ProviderType[] = [
  // Local — the endpoint runs on the operator's own hardware. All of these are
  // OpenAI-completions servers; the type only prefills the port.
  {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    scope: "local",
    api: "openai-completions",
    baseUrl: "",
    keyOptional: true,
  },
  {
    id: "llama-cpp",
    label: "llama.cpp",
    scope: "local",
    api: "openai-completions",
    baseUrl: "http://localhost:8080/v1",
    keyOptional: true,
  },
  {
    id: "ollama",
    label: "Ollama",
    scope: "local",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    keyOptional: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    scope: "local",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyOptional: true,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    scope: "local",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
    keyOptional: false,
  },
  // Cloud — hosted, so a key is always expected. A type with `connection` is one
  // whose catalog names models `vendor/model` (in letta-code 0.34.21's bundled
  // pi-ai catalog: OpenRouter 463 of 464 ids, Groq 5 of 7, every id of the rest).
  {
    id: "openai",
    label: "OpenAI",
    scope: "cloud",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    keyOptional: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    scope: "cloud",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    keyOptional: false,
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    scope: "cloud",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyOptional: false,
  },
  {
    id: "mistral",
    label: "Mistral",
    scope: "cloud",
    api: "mistral-conversations",
    baseUrl: "https://api.mistral.ai/v1",
    keyOptional: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    keyOptional: false,
    connection: "openrouter",
    // Its catalog serves its Claude models on `…/api` (Anthropic Messages) and the
    // rest on `…/api/v1`; a stored base URL replaces both, so the Claude ones then
    // 404. No count here on purpose: which models sit in that group is whatever the
    // pi-ai catalog bundled with this letta-code release says, and it moves between
    // releases — 15 at 0.34.56, 20 at 0.34.63 — with nothing to catch a stale one.
    endpointNote:
      "Claude models served through OpenRouter's Anthropic API won't work on a custom endpoint.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    keyOptional: false,
  },
  {
    id: "groq",
    label: "Groq",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    keyOptional: false,
    connection: "groq",
  },
  {
    id: "xai",
    label: "xAI",
    scope: "cloud",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    keyOptional: false,
  },
  {
    id: "together",
    label: "Together AI",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.together.ai/v1",
    keyOptional: false,
    connection: "together",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyOptional: false,
    connection: "fireworks",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
    keyOptional: false,
  },
  {
    id: "moonshot",
    label: "Moonshot AI",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.ai/v1",
    keyOptional: false,
  },
  {
    id: "minimax",
    label: "MiniMax",
    scope: "cloud",
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    keyOptional: false,
  },
  {
    id: "zai",
    label: "Z.AI",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyOptional: false,
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyOptional: false,
    connection: "nvidia",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    keyOptional: false,
    connection: "huggingface",
  },
  {
    id: "baseten",
    label: "Baseten",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://inference.baseten.co/v1",
    keyOptional: false,
    connection: "baseten",
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyOptional: false,
    connection: "vercel-ai-gateway",
  },
];

const BY_ID = new Map(PROVIDER_TYPES.map((type) => [type.id, type]));

export function providerType(id: unknown): ProviderType | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export class ProviderError extends Error {}

/**
 * A provider name as a handle prefix: lower-cased, spaces to hyphens, nothing a
 * provider id may not hold. Two names that slug to the same prefix are the same
 * provider — that is what makes the name the unique thing.
 */
export function slugifyName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
}

/** What the sheet sends, once validated and canonicalised. */
export interface ParsedProvider {
  /** Set for a type the app-server's own connection serves (`ProviderType.connection`). */
  connection?: string;
  prefix: string;
  name: string;
  type: string;
  api: string;
  scope: ProviderScope;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
  /**
   * Custom request headers, canonicalised. `undefined` means the payload said
   * nothing about headers — the stored set survives, exactly like a blank key.
   * A present object is the complete new set (an empty one clears it).
   */
  headers?: Record<string, string>;
}

/** A header name as HTTP spells it: a token, nothing a line could hide in. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The `headers` field of a save: an object of name → single-line value. A
 * blank pair is dropped (a half-filled row is a mistake, not a header); a
 * malformed one is the operator's to read about. Names keep their case —
 * HTTP treats them case-insensitively, and the name is what the row lists.
 */
export function parseHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("headers must be an object of name to value");
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (name === "" && (rawValue === null || rawValue === undefined || rawValue === "")) continue;
    if (!HEADER_NAME_RE.test(name)) {
      throw new ProviderError(`"${rawName}" is not a header name`);
    }
    const text = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();
    if (text === "") continue;
    // A value carrying a line break is a request-splitting attempt (or a
    // paste gone wrong); either way it never reaches an endpoint.
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        throw new ProviderError(`the value of "${name}" must be a single printable line`);
      }
    }
    headers[name] = text;
  }
  return headers;
}

function normalizeBaseUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\/[^/]+/i.test(text)) {
    throw new ProviderError("Base URL must start with http:// or https://");
  }
  return text.replace(/\/+$/, "");
}

/** Model ids as the handle's model segment, each one the mod can register. */
function parseModelIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : "";
    const problem = modModelIdProblem(id);
    if (problem) throw new ProviderError(problem);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new ProviderError("Pick at least one model");
  return ids;
}

/**
 * `POST /api/providers`. `name` is what the operator typed; the prefix is its
 * slug. `stored` is an edit of a provider saved here: a blank `apiKey` keeps the
 * stored one (nothing ever reads a key back), which is what makes an edit
 * non-destructive, and one saved before its type became a connection stays a
 * provider you name.
 */
export function parseProviderBody(
  body: unknown,
  { stored = false }: { stored?: boolean } = {},
): ParsedProvider {
  if (!body || typeof body !== "object") throw new ProviderError("Body must be an object");
  const record = body as Record<string, unknown>;
  const connectionType = providerType(record.type);
  if (connectionType?.connection && !stored) {
    // The app-server's own connection: its catalog is the model list and its id
    // is the handle prefix, so a name and a model pick are ignored here (the pick
    // is a separate allowlist). Only a custom endpoint is kept: a stored URL
    // replaces every catalog model's own base, and OpenRouter's catalog uses two
    // (its Claude models are on `…/api`, the rest on `…/api/v1`).
    const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
    if (!apiKey) throw new ProviderError(`${connectionType.label} needs an API key`);
    const typedUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    const baseUrl = typedUrl ? normalizeBaseUrl(typedUrl) : "";
    return {
      connection: connectionType.connection,
      prefix: connectionType.connection,
      name: connectionType.label,
      type: connectionType.id,
      api: connectionType.api,
      scope: connectionType.scope,
      baseUrl: baseUrl === normalizeBaseUrl(connectionType.baseUrl) ? "" : baseUrl,
      apiKey,
      models: [],
    };
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) throw new ProviderError("A provider needs a name");
  const prefix = slugifyName(name);
  if (!PROVIDER_ID_RE.test(prefix)) {
    throw new ProviderError(`"${name}" cannot become a model handle prefix`);
  }
  const type = providerType(record.type);
  if (!type) throw new ProviderError("Choose a provider type");
  const apiKey =
    typeof record.apiKey === "string" && record.apiKey.trim() !== "" ? record.apiKey.trim() : null;
  if (!type.keyOptional && !apiKey && !stored) {
    throw new ProviderError(`${type.label} needs an API key`);
  }
  const headers =
    record.headers === undefined || record.headers === null
      ? undefined
      : parseHeaderMap(record.headers);
  return {
    prefix,
    name,
    type: type.id,
    api: type.api,
    scope: type.scope,
    baseUrl: normalizeBaseUrl(record.baseUrl),
    apiKey,
    models: parseModelIds(record.models),
    headers,
  };
}

/** Splits served ids into what the mod can register and what it cannot. */
export function partitionModelIds(ids: readonly string[]): { models: string[]; skipped: string[] } {
  const models: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) (modModelIdProblem(id) ? skipped : models).push(id);
  return { models, skipped };
}

/**
 * The model list of one api family, fetched from the BFF (a browser could not:
 * these endpoints do not send CORS headers, and the key would leave the page).
 * Custom headers (an Access-fronted endpoint, a proxy) merge last, so they can
 * stand in for the key too — a Cloudflare Access service token is exactly one.
 */
function modelListRequest(
  api: string,
  baseUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string> = {},
): { url: string; headers: Record<string, string> } {
  if (api === "anthropic-messages") {
    // The catalog base URL has no /v1; a hand-typed one may already carry it.
    const root = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return {
      url: `${root}/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...extraHeaders },
    };
  }
  if (api === "google-generative-ai") {
    return {
      url: `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`,
      headers: { ...extraHeaders },
    };
  }
  return {
    url: `${baseUrl}/models`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}`, ...extraHeaders } : { ...extraHeaders },
  };
}

/**
 * Far past any real catalog (OpenRouter lists a few hundred). A list longer than
 * this is a broken endpoint, refused rather than cut: a cut silently delists
 * whatever sorts last, and the whole list would be echoed to the browser.
 */
const MAX_LISTED_MODELS = 5_000;

function readModelIds(api: string, payload: unknown): string[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const ids = new Set<string>();
  for (const entry of list) {
    let id = "";
    if (typeof entry === "string") id = entry;
    else if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      // Gemini names models `models/gemini-2.0-flash`; the id is the tail.
      id =
        typeof record.id === "string"
          ? record.id
          : typeof record.name === "string"
            ? record.name
            : "";
      if (api === "google-generative-ai") id = id.replace(/^models\//, "");
    }
    if (id) ids.add(id);
    if (ids.size > MAX_LISTED_MODELS) {
      throw new ProviderError(
        `The endpoint lists more than ${MAX_LISTED_MODELS} models, which no catalog does — check the base URL`,
      );
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Asks an endpoint what it serves. Throws with what the endpoint said, because a
 * wrong URL or key is the operator's to read, not ours to translate.
 */
export async function probeProviderModels(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const { url, headers } = modelListRequest(input.api, baseUrl, input.apiKey, input.headers ?? {});
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(
    (error: unknown) => {
      // Bun prefixes its own failure with "Error: "; the operator needs the
      // reason, not the framing.
      throw new ProviderError(
        `The endpoint could not be reached: ${String(error).replace(/^Error:\s*/, "")}`,
      );
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError("The endpoint did not return JSON");
  }
  const ids = readModelIds(input.api, payload);
  if (ids.length === 0) throw new ProviderError("The endpoint reported no models");
  return ids;
}
