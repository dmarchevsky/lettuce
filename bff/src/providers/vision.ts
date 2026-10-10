/**
 * The providers mod: publishing capabilities the endpoint cannot describe.
 *
 * letta-code detects model capabilities from each provider's own native
 * schema — llama.cpp's `architecture.input_modalities` / `/props`
 * `modalities.vision`, Ollama's `/api/tags` capabilities — and resolves
 * every model behind a plain OpenAI-compatible `/v1/models` endpoint as
 * text-only on purpose (that schema carries no capabilities, and letta
 * never guesses from the model name). pi-ai then replaces image content
 * parts with the text "(image omitted: model does not support images)"
 * before the model call, so the agent reports not seeing the image even
 * though the server accepts images perfectly well.
 *
 * Upstream's sanctioned override is a provider mod (`letta.providers.register`,
 * letta-code's `creating-mods` skill reference): a mod's model declaration
 * IS the capability truth — the `input` list, the real context window, all
 * of it — and a registration under a connected endpoint's own provider id
 * shadows auto-discovery in place, model handles unchanged (spike:
 * docs/vision-from-settings-spike.md). The auto-discovered path also clamps
 * the window to the harness default (128 000), so the mod is how a 256k
 * server actually gets its real window published.
 *
 * The BFF renders it from `ModelCapsStore` (Settings → Providers & models)
 * mirrored against the currently served model list, and keeps it on disk
 * like every other mod, so the app-server reloads it the same way. Two rules
 * the spike proved and this renderer exists to obey:
 *
 * - A registration must list **every** served model under its prefix, or the
 *   missing ones vanish from `available_handles`. Hence the mirror: declared
 *   models carry the declarations, everything else keeps exactly what
 *   auto-discovery gave it (`contextWindow`/`maxTokens` from `updateArgs`).
 * - **Removing** a shadow does not hand the id back to auto-discovery — the
 *   endpoint serves nothing until something re-triggers discovery. So a
 *   prefix, once registered by this file, keeps being registered while any
 *   of its models are still served: un-declaring the last model re-renders
 *   the mirror text-only at discovered windows rather than dropping it.
 */

import { MODS_DIR } from "../internal-tools/mod.ts";
import type { EndpointInfo, ModelCaps } from "./store.ts";

export const PROVIDERS_MOD_PATH = `${MODS_DIR}/lettuce-providers.mjs`;

/** The id shapes upstream's own provider-mod validation enforces. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface VisionModelConfig {
  id: string;
  name?: string;
  /** Default false — mirrors what the auto-discovered model reports. */
  reasoning?: boolean;
  /** Default `["text","image"]`: declaring a vision provider means vision. */
  input?: readonly ("text" | "image")[];
  /** Tokens. The real served window — the whole point of the mod. */
  contextWindow: number;
  /** Completion budget cap in tokens (the endpoint's own cap, not a guess). */
  maxTokens: number;
}

export interface VisionProviderConfig {
  /** Stable lowercase provider id; model handles become `<id>/<model>`. */
  id: string;
  name?: string;
  description?: string;
  /** OpenAI-compatible base URL, `/v1` included (or the proxy's path to it). */
  baseUrl: string;
  /** Env-var name resolved at mod load, or a literal; default "not-needed". */
  apiKey?: string;
  models: readonly VisionModelConfig[];
}

/** Thrown for a malformed VISION_PROVIDERS; the message is log-facing. */
export class VisionProvidersError extends Error {}

function fail(message: string): never {
  throw new VisionProvidersError(`VISION_PROVIDERS: ${message}`);
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${what} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parse the VISION_PROVIDERS JSON. An unset or empty value means no extra
 * providers — not an error. Anything malformed throws with the offender
 * named, because a silent drop here would look like "mod missing" forever.
 */
export function parseVisionProviders(raw: string | undefined | null): VisionProviderConfig[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) fail("must be a JSON array");

  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") fail("every entry must be an object");
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
      fail(`provider id ${JSON.stringify(id)} must match ${PROVIDER_ID_RE}`);
    }
    if (seen.has(id)) fail(`provider id "${id}" appears twice`);
    seen.add(id);
    const baseUrl = record.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
      fail(`provider "${id}" needs an http(s) baseUrl`);
    }
    if (!Array.isArray(record.models) || record.models.length === 0) {
      fail(`provider "${id}" needs a non-empty models array`);
    }
    const models = record.models.map((modelEntry, index) => {
      const model = (modelEntry ?? {}) as Record<string, unknown>;
      const modelId = model.id;
      if (
        typeof modelId !== "string" ||
        modelId.length === 0 ||
        modelId.includes("/") ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(modelId)
      ) {
        fail(`provider "${id}" model ${index} has an invalid id ${JSON.stringify(modelId)}`);
      }
      const input =
        model.input === undefined
          ? (["text", "image"] as const)
          : (() => {
              if (
                !Array.isArray(model.input) ||
                model.input.length === 0 ||
                !model.input.every((m) => m === "text" || m === "image")
              ) {
                fail(`provider "${id}" model "${modelId}" input must be ["text","image"]`);
              }
              return model.input as ("text" | "image")[];
            })();
      return {
        id: modelId,
        ...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
        ...(model.reasoning === true ? { reasoning: true } : {}),
        input,
        contextWindow: positiveInt(
          model.contextWindow,
          `provider "${id}" model "${modelId}" contextWindow`,
        ),
        maxTokens: positiveInt(model.maxTokens, `provider "${id}" model "${modelId}" maxTokens`),
      } satisfies VisionModelConfig;
    });
    return {
      id,
      ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
      ...(typeof record.description === "string" && record.description
        ? { description: record.description }
        : {}),
      baseUrl,
      ...(typeof record.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
      models,
    } satisfies VisionProviderConfig;
  });
}

/** One model as it goes into the mod: already fully resolved, no optional truths. */
export interface ProviderModModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

/** One `letta.providers.register` — a provider prefix and its complete model list. */
export interface ProviderModGroup {
  id: string;
  name: string;
  /** The pi-ai api this endpoint speaks. */
  api: string;
  baseUrl: string;
  apiKey?: string;
  models: readonly ProviderModModel[];
}

/** A model the BFF has seen served, with whatever the auto-discovery said. */
export interface ServedModelInfo {
  id: string;
  label?: string;
  /** `updateArgs.context_window` — what auto-discovery would have published. */
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Everything the render needs. The store is what the operator declared;
 * `served` is the BFF's latest model-list snapshot keyed by handle prefix
 * (a prefix absent from the map was never in a list_models response —
 * unknown, not empty); `bases` / `connected` come from the connection rows.
 */
export interface ProviderModInput {
  /** `ModelCapsStore.models()` */
  models: Readonly<Record<string, ModelCaps>>;
  /** `ModelCapsStore.endpoints()` */
  endpoints: Readonly<Record<string, EndpointInfo>>;
  /** The served-list mirror: absent prefix = never seen, never empty-means-nothing. */
  served: ReadonlyMap<string, readonly ServedModelInfo[]>;
  /** Live connection base URL for a prefix, resolving BYOK aliases. */
  baseUrlOf(prefix: string): string | undefined;
  /** Whether a prefix has a connected endpoint right now. */
  isLive(prefix: string): boolean;
  /** Prefixes the mod file currently on disk registers. */
  alreadyRegistered: ReadonlySet<string>;
  /** Prefixes the operator removed — never registered again, whatever the file says. */
  retired?: ReadonlySet<string>;
}

/** Harness defaults — what the auto-discovered path would give an undeclared model. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Build the provider groups the mod should register, or `null` when the
 * render must wait: a shadow of a live endpoint mirrors the served list and
 * cannot be rendered from a list the BFF has never seen (rendering would
 * drop every model), and a group with no base URL anywhere is incomplete.
 * The caller keeps the existing mod file when told to defer.
 */
export function buildProviderModGroups(input: ProviderModInput): ProviderModGroup[] | null {
  const declared = new Map<string, Map<string, ModelCaps>>();
  for (const [handle, caps] of Object.entries(input.models)) {
    const cut = handle.indexOf("/");
    if (cut <= 0) continue;
    const prefix = handle.slice(0, cut);
    let group = declared.get(prefix);
    if (!group) {
      group = new Map();
      declared.set(prefix, group);
    }
    group.set(handle.slice(cut + 1), caps);
  }

  const prefixes = new Set<string>([
    ...declared.keys(),
    ...Object.keys(input.endpoints),
    ...input.alreadyRegistered,
  ]);
  const groups: ProviderModGroup[] = [];
  for (const prefix of [...prefixes].sort()) {
    if (input.retired?.has(prefix)) continue;
    const endpoint = input.endpoints[prefix];
    // A provider the operator added publishes its own model list, so it is not a
    // shadow of a connection and no served-list mirror is involved.
    const ownModels = endpoint?.models?.length ? endpoint.models : null;
    const served = ownModels ? undefined : input.served.get(prefix);
    // A shadow of a live endpoint must mirror the current served list; an
    // unknown one would erase the endpoint's models. Standalone groups (an
    // env-seeded id no Settings connection owns) render from declarations —
    // `isLive` means a live *connection*, not merely an endpoint record.
    if (served === undefined && !ownModels && input.isLive(prefix)) return null;
    const baseUrl = input.baseUrlOf(prefix) ?? endpoint?.baseUrl;
    if (!baseUrl) {
      // One half-entered provider must not hold every other group hostage; a
      // shadow with no URL anywhere still means "wait and retry".
      if (ownModels) continue;
      return null;
    }

    const declarations = declared.get(prefix) ?? new Map<string, ModelCaps>();
    const ids: string[] = [];
    for (const id of ownModels ?? []) if (!ids.includes(id)) ids.push(id);
    for (const model of served ?? []) if (!ids.includes(model.id)) ids.push(model.id);
    for (const id of declarations.keys()) if (!ids.includes(id)) ids.push(id);
    if (ids.length === 0) continue; // nothing served, nothing declared: nothing to register

    const labelOf = new Map((served ?? []).map((m) => [m.id, m]));
    groups.push({
      id: prefix,
      name: endpoint?.name ?? prefix,
      api: endpoint?.api ?? "openai-completions",
      baseUrl,
      ...(endpoint?.apiKey ? { apiKey: endpoint.apiKey } : {}),
      models: ids.map((id) => {
        const caps = declarations.get(id);
        const info = labelOf.get(id);
        return {
          id,
          name: info?.label || id,
          reasoning: caps?.thinking === true,
          input: caps
            ? caps.vision
              ? (["text", "image"] as const)
              : (["text"] as const)
            : (["text"] as const),
          // Declared means the operator's numbers; undeclared means exactly
          // what auto-discovery published — the mirror must not clamp.
          contextWindow: caps?.contextWindow ?? info?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: caps?.maxTokens ?? info?.maxTokens ?? DEFAULT_MAX_TOKENS,
        };
      }),
    });
  }
  return groups;
}

/**
 * The provider mod: one `letta.providers.register` per group. Empty renders
 * a mod that registers nothing — the reload protocol cannot delete a file.
 */
export function renderProvidersMod(groups: readonly ProviderModGroup[]): string {
  const header = `// lettuce providers v1 — rendered by the lettuce BFF (bff/src/providers/vision.ts).
// Edits here are overwritten on the BFF's next connect; declare capabilities in
// Settings → Providers & models (vision/thinking/windows travel per model).`;
  if (groups.length === 0) {
    return `${header}
// Nothing declared: registers nothing.
export default function activate() {}
`;
  }
  const registrations = groups
    .map((group) => {
      const registration = {
        name: group.name,
        api: group.api,
        baseUrl: group.baseUrl,
        // Resolved as process.env[apiKey] ?? apiKey by letta-code's mod
        // validation, so "not-needed" (the default) sends no Authorization.
        apiKey: group.apiKey ?? "not-needed",
        // No /connect step: the key (if any) and the URL are already declared.
        connect: false,
        models: group.models.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: [...model.input],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          // The completions-compat overrides are about `developer` role and
          // reasoning-effort plumbing that only the OpenAI-shaped api has; the
          // others must keep pi-ai's own defaults.
          ...(group.api === "openai-completions"
            ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }
            : {}),
        })),
      };
      return `  letta.providers.register(${JSON.stringify(group.id)}, ${JSON.stringify(
        registration,
        null,
        4,
      )
        .split("\n")
        .join("\n  ")});`;
    })
    .join("\n\n");
  return `${header}
export default function activate(letta) {
  if (!letta.capabilities?.providers) return;

${registrations}
}
`;
}

/**
 * The prefixes the current mod file registers — the "keep shadowing" set.
 * The file is BFF-rendered (the header says so), so reading the registration
 * lines back is reliable; no file means nothing is shadowed.
 */
export function parseRegisteredProviderIds(modSource: string | null): Set<string> {
  const ids = new Set<string>();
  if (!modSource) return ids;
  for (const match of modSource.matchAll(/letta\.providers\.register\("([^"]+)",/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}
