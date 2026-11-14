/**
 * Settings → Providers & models: what the operator added as a provider, and what
 * they declared about a model behind an endpoint that reports no capabilities of
 * its own (vision, reasoning, the real context window).
 *
 * Both live in one store and both drive the providers mod, which is the capability
 * truth for every prefix it registers — so a save here re-renders and reloads it,
 * and a declared window retunes every agent on that model (`session/context-size.ts`).
 * Keys stored here are write-only: no route echoes them.
 *
 * `index.ts` registers these where they sat, and its `requireSession` middleware
 * already gates `/api/*`.
 */

import type { Context, Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import type { ContextSizer } from "../session/context-size.ts";
import {
  type ParsedProvider,
  PROVIDER_TYPES,
  ProviderError,
  parseHeaderMap,
  parseProviderBody,
  partitionModelIds,
  probeProviderModels,
  providerType,
  slugifyName,
} from "./registry.ts";
import type { ProviderSight } from "./sight.ts";
import { ModelCapsError, type ModelCapsStore, parseModelCapsBody, splitHandle } from "./store.ts";
import { modModelIdProblem, providerLoadErrors } from "./vision.ts";

export interface ProviderRouteDeps {
  /** A save writes the providers mod, which goes over the connection. */
  isReady: () => boolean;
  modelCaps: ModelCapsStore;
  providerSight: ProviderSight;
  contextSizer: ContextSizer;
  resyncMods: (
    reason: string,
    options: { refreshCatalog: boolean; refreshProviders?: boolean },
  ) => Promise<unknown>;
  /** `connect_provider` on the local target; throws with what upstream said. */
  connect: (providerId: string, fields: { apiKey: string; baseUrl?: string }) => Promise<void>;
  /** `disconnect_provider` on the local target; throws with what upstream said. */
  disconnect: (providerId: string) => Promise<void>;
  /** letta-code's mod diagnostics report (`MOD_DIAGNOSTICS_PATH`), or null. */
  readDiagnostics: () => Promise<string | null>;
}

/**
 * Why a provider of ours serves nothing (or less than it lists), or undefined.
 * Ids holding "/" come first: a provider saved before the shared id rule has
 * them, the render leaves them out, and no load error names them.
 * `unregistrable` says the message came from those ids — the one problem whose
 * fix, for a connection type, is Remove and not Edit.
 */
function providerProblem(
  info: { type?: string; models?: string[] },
  loadError: string | undefined,
): { message: string; unregistrable: boolean } | undefined {
  const unregistrable = (info.models ?? []).filter((id) => modModelIdProblem(id) !== null);
  if (unregistrable.length > 0) {
    const count = unregistrable.length;
    const type = providerType(info.type);
    const what = `${count} ${count === 1 ? "model holds" : "models hold"} a "/", which a named provider cannot register`;
    const message = type?.connection
      ? `${what} — remove it and add ${type.label} again, which the app-server's own connection serves.`
      : `${what} — edit it and untick ${count === 1 ? "it" : "them"}.`;
    return { message, unregistrable: true };
  }
  return loadError ? { message: loadError, unregistrable: false } : undefined;
}

export function registerProviderRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: ProviderRouteDeps,
): void {
  const {
    isReady,
    modelCaps,
    providerSight,
    contextSizer,
    resyncMods,
    connect,
    disconnect,
    readDiagnostics,
  } = deps;

  // What the operator declares about models behind endpoints that report no
  // capabilities (plain OpenAI-compatible and its BYOK aliases): vision,
  // thinking, the real context window. The declarations drive the providers mod
  // — which is THE capability truth for every prefix it registers — so a save
  // re-renders and reloads it and answers with the same `mod` state the
  // web-tools switch uses ("reload-pending" when no agent exists yet).
  // Keys stored here are write-only: no route echoes them, same rule as the
  // provider connections themselves.

  app.get("/api/model-caps", (c) => {
    // Endpoint snapshots minus the key: a declared provider no Settings
    // connection owns (an env-seeded one like halogen) still needs its URL and
    // name to render as a served model. Keys stay write-only, same as everywhere.
    const endpoints = Object.fromEntries(
      Object.entries(modelCaps.endpoints()).map(([prefix, info]) => [
        prefix,
        {
          ...(info.baseUrl ? { baseUrl: info.baseUrl } : {}),
          ...(info.name ? { name: info.name } : {}),
        },
      ]),
    );
    return c.json({ models: modelCaps.models(), endpoints });
  });

  app.put("/api/model-caps", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    let saved: ReturnType<typeof parseModelCapsBody>;
    try {
      saved = parseModelCapsBody(await c.req.json().catch(() => null));
    } catch (error) {
      if (error instanceof ModelCapsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 400);
    }
    const prefix = saved.handle.slice(0, saved.handle.indexOf("/"));
    // A declaration shadows the whole prefix, and a shadow must list every served
    // model; one the mod cannot register means the shadow would refuse to load.
    const unshadowable = providerSight
      .servedModels(prefix)
      ?.find((model) => modModelIdProblem(model.id) !== null);
    if (unshadowable) {
      return c.text(
        `${prefix}/ also serves "${unshadowable.id}", which a named provider cannot register, so no model of it can be declared here — its connection reports its own capabilities.`,
        400,
      );
    }
    modelCaps.setModel(saved.handle, saved.caps);
    // Snapshot what the live connection currently has, so the group survives
    // the connection going away; a blank key keeps the stored one (the protocol
    // can never read it back, so the save form starts blank every time).
    const baseUrl = providerSight.baseUrlFor(prefix);
    modelCaps.setEndpoint(prefix, {
      ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    // Awaited so the answer says whether it is live; the reload retries on its
    // own while no agent exists to carry it.
    const mod = await resyncMods("Settings → model capabilities", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    // A different declared window moves the point where the engine refuses, so
    // every agent on this model is retuned to it (session/context-size.ts).
    void contextSizer.applyHandle(saved.handle).catch(() => {});
    return c.json({ model: { handle: saved.handle, ...saved.caps }, mod: mod ?? "failed" });
  });

  app.delete("/api/model-caps", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const parts = splitHandle(c.req.query("handle"));
    if (!parts) return c.text('handle must look like "provider/model"', 400);
    const removed = modelCaps.removeModel(`${parts.prefix}/${parts.model}`);
    const mod = await resyncMods("Settings → model capabilities", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    return c.json({ removed, mod: mod ?? "failed" });
  });

  // The providers the operator added (Settings → Providers & models). Each is a
  // named endpoint with a handle prefix of its own, registered by the providers
  // mod — see `providers/registry.ts` for why this cannot be `connect_provider`.
  // The list never carries a key; a save with a blank key keeps the stored one.

  app.get("/api/providers", async (c) => {
    const loadErrors = providerLoadErrors(await readDiagnostics().catch(() => null));
    const providers = Object.entries(modelCaps.endpoints()).map(([prefix, info]) => {
      const problem = providerProblem(info, loadErrors.get(prefix));
      return {
        prefix,
        name: info.name ?? prefix,
        type: info.type ?? "",
        api: info.api ?? "openai-completions",
        scope: info.scope ?? "local",
        baseUrl: info.baseUrl ?? "",
        models: info.models ?? [],
        hasKey: Boolean(info.apiKey),
        // Names only: a header value is a secret like a key, and this list is
        // what the edit form shows before anything is typed.
        headerNames: Object.keys(info.headers ?? {}).sort(),
        ...(problem ? { problem: problem.message } : {}),
        ...(problem?.unregistrable ? { unregistrable: true } : {}),
      };
    });
    // Each live connection's whole served list, from the BFF's own mirror: the
    // browsers' list leaves out what was unticked (`allowlist.ts`), and a picker has
    // to offer it. `selected` is what is served and not hidden, so a model the
    // catalog gained since is picked and one it dropped counts nowhere; null means
    // nothing was ever unticked.
    const connections = Object.fromEntries(
      PROVIDER_TYPES.flatMap((type) => {
        if (!type.connection || !providerSight.isConnected(type.connection)) return [];
        const served = (providerSight.servedModels(type.connection) ?? []).map((m) => m.id);
        const hidden = modelCaps.hiddenModels().get(type.connection);
        return [
          [
            type.connection,
            { selected: hidden ? served.filter((id) => !hidden.has(id)) : null, served },
          ],
        ];
      }),
    );
    return c.json({ types: PROVIDER_TYPES, providers, connections });
  });

  // The models picked from a connection the app-server holds. What is stored is the
  // served models left out (`allowlist.ts`), so later additions show up. Only for
  // a connection type's live connection — a provider we render carries its own list.
  app.put("/api/providers/connection-models", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const prefix = typeof body?.prefix === "string" ? body.prefix : "";
    if (!PROVIDER_TYPES.some((type) => type.connection === prefix)) {
      return c.text(`${prefix || "That"} is not a connection the app-server holds`, 400);
    }
    if (!providerSight.isConnected(prefix)) return c.text(`${prefix} is not connected`, 409);
    const models = Array.isArray(body?.models)
      ? body.models.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [];
    if (models.length === 0) return c.text("Pick at least one model", 400);
    const picked = new Set(models);
    const served = (providerSight.servedModels(prefix) ?? []).map((m) => m.id);
    modelCaps.setHiddenModels(
      prefix,
      served.filter((id) => !picked.has(id)),
    );
    return c.json({ prefix, models: served.filter((id) => picked.has(id)) });
  });

  app.post("/api/providers", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    let parsed: ParsedProvider;
    const body: unknown = await c.req.json().catch(() => null);
    try {
      parsed = parseProviderBody(body, {
        stored: storedProvider((body as { prefix?: unknown } | null)?.prefix),
      });
    } catch (error) {
      if (error instanceof ProviderError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 400);
    }
    const stored = modelCaps.endpoints()[parsed.prefix];
    if (parsed.connection) {
      const update = (body as { update?: unknown }).update === true;
      return connectProvider(c, parsed, stored !== undefined, update);
    }
    if (stored?.name && stored.name !== parsed.name) {
      return c.text(
        `Another provider already answers to "${parsed.name}" — two providers cannot share the handle ${parsed.prefix}.`,
        409,
      );
    }
    if (!stored && providerSight.isConnected(parsed.prefix)) {
      return c.text(
        `The app-server already has a connection serving ${parsed.prefix}/ — name the provider something else.`,
        409,
      );
    }
    modelCaps.unretire(parsed.prefix);
    // Unticked on a connection that once held this prefix: stale now that a named
    // provider owns it, and it would hide that provider's own models.
    modelCaps.clearHiddenModels(parsed.prefix);
    modelCaps.setEndpoint(parsed.prefix, {
      name: parsed.name,
      type: parsed.type,
      api: parsed.api,
      scope: parsed.scope,
      baseUrl: parsed.baseUrl,
      models: parsed.models,
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
    });
    // Nothing here declares what a model can do — vision, reasoning and the real
    // context window are per model and set on the model, so a save here must not
    // write (or flatten) a single capability.
    const reloadStarted = Date.now();
    const mod = await resyncMods("Settings → providers", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    // A reload answers success even when the app-server refused the registration;
    // only its diagnostics report says so, and only one written by this reload counts.
    const loadError =
      mod === "reloaded"
        ? providerLoadErrors(await readDiagnostics().catch(() => null), reloadStarted).get(
            parsed.prefix,
          )
        : undefined;
    return c.json({
      provider: {
        prefix: parsed.prefix,
        name: parsed.name,
        type: parsed.type,
        api: parsed.api,
        scope: parsed.scope,
        baseUrl: parsed.baseUrl,
        models: parsed.models,
        headerNames: Object.keys(
          parsed.headers ?? modelCaps.endpoint(parsed.prefix)?.headers ?? {},
        ).sort(),
      },
      mod: mod ?? "failed",
      ...(loadError ? { loadError } : {}),
    });
  });

  /**
   * A type the app-server's own connection serves (`ProviderType.connection`):
   * the key and endpoint go to `connect_provider`, and no mod is rendered for it.
   * Upstream's connect is create-or-update, so an existing connection is refused
   * rather than having its key silently replaced — its row's Edit does that.
   */
  async function connectProvider(
    c: Context,
    parsed: ParsedProvider,
    ownedHere: boolean,
    update: boolean,
  ) {
    const providerId = parsed.connection as string;
    if (ownedHere) {
      return c.text(
        `A provider of yours already uses the handle ${parsed.prefix}/ — remove it before connecting ${parsed.name}.`,
        409,
      );
    }
    // `update` is the row's Edit: re-issuing connect_provider is upstream's own
    // edit (create-or-update), so only a fresh add is refused over a live one.
    if (!update && providerSight.isConnected(providerId)) {
      return c.text(
        `${parsed.name} is already connected — use Edit on its row to change the key.`,
        409,
      );
    }
    const fields = {
      apiKey: parsed.apiKey ?? "",
      // Only a custom endpoint: a stored one replaces every catalog model's base.
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
    };
    try {
      await connect(providerId, fields);
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
    // Back to the catalog's endpoint: upstream's update keeps a stored base URL
    // when none is sent, and only a disconnect removes it. The connect above has
    // checked the key, so the gap between these two is the only risk left.
    if (update && !parsed.baseUrl && providerSight.baseUrlFor(providerId)) {
      try {
        await disconnect(providerId);
        await connect(providerId, fields);
      } catch (error) {
        return c.text(
          `${parsed.name} was disconnected to clear its endpoint and did not connect again: ${errorMessage(error)}`,
          502,
        );
      }
    }
    // A fresh connection starts from everything it serves; picks from an earlier
    // one would hide models the operator never chose against. An edit keeps them.
    if (!update) modelCaps.clearHiddenModels(providerId);
    await providerSight.refresh().catch(() => {});
    return c.json({
      provider: {
        prefix: parsed.prefix,
        name: parsed.name,
        type: parsed.type,
        api: parsed.api,
        scope: parsed.scope,
        baseUrl: parsed.baseUrl,
        models: parsed.models,
        connection: providerId,
      },
      mod: "unchanged",
    });
  }

  app.delete("/api/providers", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const prefix = slugifyName(c.req.query("prefix"));
    if (!prefix) return c.text("prefix is required", 400);
    const removed = modelCaps.removeProvider(prefix);
    const mod = await resyncMods("Settings → providers", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    return c.json({ removed, mod: mod ?? "failed" });
  });

  /**
   * What an endpoint says it serves. POST with the key in the body, not a query
   * string: a URL is the one thing that ends up in logs.
   */
  /**
   * What a probe is asked about: the endpoint fields of the form, with a blank
   * key falling back to the stored one — an edit form starts blank every time
   * because nothing can read a key back. The header rows typed so far join the
   * stored set (same fallback rule); when the form sent no `headers` field at
   * all, the stored set probes as-is.
   */
  async function probeFields(c: Context): Promise<{
    api: string;
    baseUrl: string;
    key: string;
    headers: Record<string, string>;
    connection: boolean;
  }> {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const typed = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const prefix = slugifyName(body?.prefix);
    const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl : "";
    // The stored key and headers go only where they were saved for. The probe's
    // URL comes from the request, so falling back unconditionally would post a
    // provider's secret to whatever address the form — or a forged request —
    // names. Changing the URL in the form means typing the key again.
    const saved = prefix ? modelCaps.endpoints()[prefix] : undefined;
    const savedUrl = saved?.baseUrl ?? providerType(saved?.type)?.baseUrl ?? "";
    const trusted = saved !== undefined && sameEndpoint(baseUrl, savedUrl);
    const key = typed || (trusted ? (saved?.apiKey ?? "") : "");
    const stored = (trusted ? saved?.headers : undefined) ?? {};
    let headers = stored;
    if (body?.headers !== undefined && body.headers !== null) {
      try {
        headers = { ...stored, ...parseHeaderMap(body.headers) };
      } catch {
        // A probe only reports: a malformed row is refused by the save, and a
        // probe with whatever the rest of the form says is still useful.
      }
    }
    return {
      api: typeof body?.api === "string" ? body.api : "openai-completions",
      baseUrl,
      key,
      headers,
      connection: Boolean(providerType(body?.type)?.connection) && !storedProvider(prefix),
    };
  }

  /** Whether two base URLs name the same endpoint: scheme, host, port and path. */
  function sameEndpoint(left: string, right: string): boolean {
    const canonical = (value: string): string | null => {
      try {
        const url = new URL(value.trim());
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
      } catch {
        return null;
      }
    };
    const a = canonical(left);
    return a !== null && a === canonical(right);
  }

  /**
   * The sheet's Edit sends the prefix it edits: a provider of ours stored there
   * keeps its key when the field is left blank and stays a provider you name, even
   * one saved before its type became a connection.
   */
  function storedProvider(prefix: unknown): boolean {
    const slug = slugifyName(prefix);
    return slug !== "" && modelCaps.endpoints()[slug] !== undefined;
  }

  /** A failed probe says what the endpoint said — it is the operator's to read. */
  function providerText(error: unknown): string {
    return error instanceof ProviderError ? error.message : errorMessage(error);
  }

  app.post("/api/providers/models", async (c) => {
    const probe = await probeFields(c);
    if (!probe.baseUrl) return c.text("baseUrl is required", 400);
    try {
      const models = await probeProviderModels({
        api: probe.api,
        baseUrl: probe.baseUrl,
        apiKey: probe.key,
        headers: probe.headers,
      });
      // A connection serves its own catalog, so its probe only proves the key; a
      // named provider is offered only ids the mod can register.
      return c.json(probe.connection ? { models, skipped: [] } : partitionModelIds(models));
    } catch (error) {
      return c.text(providerText(error), 400);
    }
  });
}
