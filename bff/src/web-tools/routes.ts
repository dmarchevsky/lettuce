/**
 * Settings → Web: the switch that turns the native `web_search` / `fetch_webpage`
 * tools on, the status of the search backends behind them, and a test search that
 * runs the same code an agent's call runs.
 *
 * The settings file lives on the app-server (`install.ts`), so these routes need
 * its file channel; everything else is passed in. `index.ts` registers them where
 * they sat, and its `requireSession` middleware already gates `/api/*`.
 */

import type { Hono } from "hono";
import type { CodexFileIo } from "../codex/service.ts";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { loadWebToolsSettings, saveWebToolsSettings } from "./install.ts";
import { type WebToolsBackends, webSearch } from "./service.ts";
import { InvalidWebToolsSettingsError } from "./settings.ts";
import { webToolsStatus } from "./status.ts";

export interface WebToolsRouteDeps {
  /** The file channel: the switch is a file on the app-server. */
  isReady: () => boolean;
  /** The `search` profile token — without the sidecars there is no backend. */
  searchEnabled: boolean;
  io: CodexFileIo;
  resyncMods: (
    reason: string,
    options: { refreshCatalog: boolean; refreshProviders?: boolean },
  ) => Promise<unknown>;
  /** The same backends an agent's `web_search` is given. */
  backends: () => WebToolsBackends;
  searxngUrl: string | null;
  ddgMcpUrl: string | null;
}

export function registerWebToolsRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: WebToolsRouteDeps,
): void {
  const { isReady, searchEnabled, io, resyncMods, backends, searxngUrl, ddgMcpUrl } = deps;

  app.get("/api/web-tools/settings", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    try {
      const settings = await loadWebToolsSettings(io);
      return c.json({ settings: { enabled: settings.enabled } });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.put("/api/web-tools/settings", async (c) => {
    // Gated by the `search` profile token: without the sidecars there is no
    // backend to point the switch at.
    if (!searchEnabled) return c.text("Web search is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const body = await c.req.json().catch(() => null);
    try {
      const saved = await saveWebToolsSettings(io, body);
      const mod = await resyncMods("Settings → Web", { refreshCatalog: false });
      return c.json({ settings: { enabled: saved.enabled }, mod });
    } catch (error) {
      if (error instanceof InvalidWebToolsSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/web-tools/status", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    return c.json(
      await webToolsStatus({
        searxngUrl,
        ddgMcpUrl,
        read: io.read,
      }),
    );
  });

  // The same search an agent's `web_search` runs, so the settings screen can
  // prove the backends answer without starting a turn.
  app.post("/api/web-tools/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { query?: unknown } | null;
    return c.json(await webSearch({ query: body?.query, max_results: 5 }, backends()));
  });
}
