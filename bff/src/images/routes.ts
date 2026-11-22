/**
 * Settings → Image generation: the endpoint the agents draw through, its
 * status, and a test draw that runs exactly what an agent's call runs.
 *
 * All of it is BFF-local — settings and key on `bff-data` — so unlike
 * `web-tools/routes.ts` these handlers need the app-server's file channel only
 * to read back the mod's own state. `index.ts` registers them where they would
 * otherwise sit, and its `requireSession` middleware already gates `/api/*`.
 *
 * Nothing here echoes the API key: the browser gets `hasKey` and nothing else.
 * Every route answers 404 while the `images` compose token is off — the same
 * gating `pi/routes.ts` and `web-tools/routes.ts` do on their token.
 */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { drawImages, endpointFromSettings, type ImageFetch } from "./client.ts";
import { drawFace, FACE_STYLE_PREFIX, facePromptRefusal } from "./face.ts";
import type { ImagesSettingsStore } from "./service.ts";
import {
  InvalidImagesSettingsError,
  imagesEndpointUsable,
  toPublicImagesSettings,
} from "./settings.ts";
import { imagesStatus } from "./status.ts";

/** Fixed so a test draw is comparable across saves — not a prompt of the moment. */
export const IMAGE_TEST_PROMPT =
  "A small red fox sitting in clean snow, flat vector illustration, simple shapes, plain pale sky.";

export interface ImagesRouteDeps {
  /** The `images` compose-profile token; false answers 404 on everything here. */
  imagesEnabled: boolean;
  store: ImagesSettingsStore;
  /** The app-server file channel — only for reading the mod's own state back. */
  isReady: () => boolean;
  read: (path: string) => Promise<string | null>;
  resyncMods: (
    reason: string,
    options: { refreshCatalog: boolean; refreshProviders?: boolean },
  ) => Promise<unknown>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: ImageFetch;
}

const OFF = "Image generation is off: COMPOSE_PROFILES";

export function registerImagesRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: ImagesRouteDeps,
): void {
  const { imagesEnabled, store, isReady, read, resyncMods, fetchImpl } = deps;
  const fetchOptions = fetchImpl ? { fetchImpl } : {};

  app.get("/api/images/settings", async (c) => {
    if (!imagesEnabled) return c.text(OFF, 404);
    try {
      // `faceStylePrefix` rides along so the avatar sheet can show the style line it
      // is about to put in front of a description, in the words the draw will use —
      // a hint copied into the UI is a hint that silently disagrees with the server.
      return c.json({
        settings: toPublicImagesSettings(await store.load()),
        faceStylePrefix: FACE_STYLE_PREFIX,
      });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.put("/api/images/settings", async (c) => {
    if (!imagesEnabled) return c.text(OFF, 404);
    const body = await c.req.json().catch(() => null);
    try {
      const saved = await store.save(body);
      // The tool exists only if the settings are complete, so this save is what
      // makes the mod appear or disappear.
      const mod = await resyncMods("Settings → Image generation", { refreshCatalog: false });
      return c.json({ settings: toPublicImagesSettings(saved), mod });
    } catch (error) {
      if (error instanceof InvalidImagesSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/images/status", async (c) => {
    if (!imagesEnabled) return c.text(OFF, 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    return c.json(await imagesStatus({ settings: await store.load(), read }));
  });

  // The reachability probe: one picture at the configured default size, with a
  // fixed prompt, returned inline. An endpoint that answers this answers an
  // agent's call; an error here is the server's own message, shown as typed.
  app.post("/api/images/test", async (c) => {
    if (!imagesEnabled) return c.text(OFF, 404);
    const settings = await store.load();
    if (!imagesEndpointUsable(settings)) {
      return c.json(
        {
          ok: false,
          error: "Set an endpoint URL and a model first — there is nothing to draw with yet.",
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => null)) as { prompt?: unknown } | null;
    const typed = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const result = await drawImages(
      endpointFromSettings(settings),
      { prompt: typed || IMAGE_TEST_PROMPT, size: settings.size ?? undefined },
      fetchOptions,
    );
    if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
    const first = result.images[0]!;
    return c.json({
      ok: true,
      mediaType: first.mediaType,
      size: settings.size,
      dataUrl: `data:${first.mediaType};base64,${first.b64}`,
    });
  });

  // The avatar sheet's Draw tab: one face from a description, returned inline as
  // a data URL. The browser crops and shrinks it and posts it through
  // `/api/avatars`, so the BFF rasterises nothing and the drawn face lands in the
  // one face library there is. A refusal is the server's own message, key
  // redacted — `face.ts` already walked the size ladder by then, so what reaches
  // the user is a queue, an auth problem, or a server that refuses every size.
  app.post("/api/images/draw-face", async (c) => {
    if (!imagesEnabled) return c.text(OFF, 404);
    const body = (await c.req.json().catch(() => null)) as { prompt?: unknown } | null;
    // Checked before the store is read: a prompt over the budget is caught here
    // rather than cut silently by the server.
    const refusal = facePromptRefusal(body?.prompt);
    if (refusal) return c.text(refusal, 400);
    const settings = await store.load();
    if (!imagesEndpointUsable(settings)) {
      return c.json(
        {
          ok: false,
          error: "Set an endpoint URL and a model first — there is nothing to draw with yet.",
        },
        400,
      );
    }
    // The browser's own abort rides along: the sheet closing is the user saying they do
    // not want that face, and the next rung would otherwise be paid for anyway.
    const drawn = await drawFace(endpointFromSettings(settings), body?.prompt, {
      ...fetchOptions,
      signal: c.req.raw.signal,
    });
    if (!drawn.ok) return c.json({ ok: false, error: drawn.error }, 502);
    return c.json({
      ok: true,
      mediaType: drawn.mediaType,
      size: drawn.size,
      dataUrl: `data:${drawn.mediaType};base64,${drawn.b64}`,
    });
  });
}
