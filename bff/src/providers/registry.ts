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
 */

import { PROVIDER_ID_RE } from "./vision.ts";

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
  // Cloud — hosted, so a key is always expected.
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
  },
  {
    id: "fireworks",
    label: "Fireworks",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyOptional: false,
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
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    keyOptional: false,
  },
  {
    id: "baseten",
    label: "Baseten",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://inference.baseten.co/v1",
    keyOptional: false,
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    scope: "cloud",
    api: "openai-completions",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyOptional: false,
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
  prefix: string;
  name: string;
  type: string;
  api: string;
  scope: ProviderScope;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
}

function normalizeBaseUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\/[^/]+/i.test(text)) {
    throw new ProviderError("Base URL must start with http:// or https://");
  }
  return text.replace(/\/+$/, "");
}

/** Model ids as the handle's model segment; a slash is part of the id. */
function parseModelIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/i.test(id) || id.endsWith("/")) {
      throw new ProviderError(`"${String(entry)}" is not a model id`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new ProviderError("Pick at least one model");
  return ids;
}

/**
 * `POST /api/providers`. `name` is what the operator typed; the prefix is its
 * slug. A blank `apiKey` keeps whatever is stored (nothing ever reads a key
 * back), which is what makes an edit non-destructive.
 */
export function parseProviderBody(body: unknown): ParsedProvider {
  if (!body || typeof body !== "object") throw new ProviderError("Body must be an object");
  const record = body as Record<string, unknown>;
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
  if (!type.keyOptional && !apiKey && !record.keepKey) {
    throw new ProviderError(`${type.label} needs an API key`);
  }
  return {
    prefix,
    name,
    type: type.id,
    api: type.api,
    scope: type.scope,
    baseUrl: normalizeBaseUrl(record.baseUrl),
    apiKey,
    models: parseModelIds(record.models),
  };
}

/**
 * The model list of one api family, fetched from the BFF (a browser could not:
 * these endpoints do not send CORS headers, and the key would leave the page).
 */
function modelListRequest(
  api: string,
  baseUrl: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  if (api === "anthropic-messages") {
    // The catalog base URL has no /v1; a hand-typed one may already carry it.
    const root = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return {
      url: `${root}/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  if (api === "google-generative-ai") {
    return { url: `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
  return {
    url: `${baseUrl}/models`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  };
}

function readModelIds(api: string, payload: unknown): string[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const ids: string[] = [];
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
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a.localeCompare(b)).slice(0, 300);
}

/**
 * Asks an endpoint what it serves. Throws with what the endpoint said, because a
 * wrong URL or key is the operator's to read, not ours to translate.
 */
export async function probeProviderModels(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const { url, headers } = modelListRequest(input.api, baseUrl, input.apiKey);
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
