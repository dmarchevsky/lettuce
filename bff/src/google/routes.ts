/**
 * Settings → Google, and the OAuth round trip that grants it.
 *
 * Agents reach Google through the `google-mcp` sidecar; this is where the user
 * decides how far. The policy and the token live on volumes only the BFF and the
 * sidecar mount — never the app-server, where agent shells run — so an agent
 * cannot change its own access. The `GoogleService` itself is built in `index.ts`
 * because the connect pass on every reconnect re-renders the sidecar's config.
 *
 * `index.ts` registers these where they sat, and its `requireSession` middleware
 * already gates `/api/*` — except `/api/google/reconnect` and the OAuth callback,
 * which handle a missing session themselves and say so in their own words.
 */

import type { Context, Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { hardenedResponse } from "../security-headers.ts";
import { googleSettingsUrl } from "./lost-access.ts";
import { GoogleOAuthError } from "./oauth.ts";
import { GoogleAccessError, type GoogleService } from "./service.ts";
import { InvalidGoogleSettingsError } from "./settings.ts";

export interface GoogleRouteDeps {
  googleService: GoogleService;
  /** The `google` profile token — it is also what starts the sidecar. */
  profileEnabled: boolean;
  /** The dev-bypass rule: granting access is refused while an agent could sign itself in. */
  writesAllowed: boolean;
  /** The sidecar's own URL, for its health probe and for its MCP entry. */
  mcpUrl: string;
  redirectUri: string;
  publicOrigin: string;
  /** Carried on the two pages this family renders, which are built here, not by Hono. */
  hardened: Record<string, string>;
}

export function registerGoogleRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: GoogleRouteDeps,
): void {
  const {
    googleService,
    profileEnabled,
    writesAllowed,
    mcpUrl,
    redirectUri,
    publicOrigin,
    hardened,
  } = deps;

  /** Whether the sidecar answers at all — it serves nothing while disabled. */
  async function googleSidecarUp(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/health", mcpUrl), {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The gate Google writes pass but reads do not: while `DEV_BYPASS_EMAIL` is set,
   * an agent can sign itself in, so granting access has to be impossible. The
   * session itself is checked by `requireSession`, above every route.
   */
  function googleWriteRefusal(c: Context): Response | null {
    if (!writesAllowed) {
      return c.text(
        "Google access cannot be changed while DEV_BYPASS_EMAIL is set: agents can sign " +
          "themselves in through the bypass. Use Cloudflare Access, or set " +
          "GOOGLE_ALLOW_DEV_BYPASS=true on a machine only you use.",
        403,
      );
    }
    return null;
  }

  function googleErrorResponse(c: Context, error: unknown): Response {
    if (error instanceof InvalidGoogleSettingsError || error instanceof GoogleAccessError) {
      return c.text(error.message, 400);
    }
    if (error instanceof GoogleOAuthError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 500);
  }

  app.get("/api/google", async (c) => {
    try {
      // Opening Settings → Google asks Google whether the token still works (at
      // most every few minutes), so it shows the truth, not what consent said.
      await googleService.checkIfDue(GOOGLE_STATUS_CHECK_MS);
      const [settings, sidecarUp] = await Promise.all([googleService.status(), googleSidecarUp()]);
      return c.json({
        settings,
        sidecarUp,
        redirectUri: redirectUri,
        writable: writesAllowed,
      });
    } catch (error) {
      return googleErrorResponse(c, error);
    }
  });

  app.put("/api/google", async (c) => {
    // Gated by the `google` profile token, which is also what starts the
    // sidecar; the stored switch is treated as off while it is absent.
    if (!profileEnabled) return c.text("Google is off: COMPOSE_PROFILES", 404);
    const refused = googleWriteRefusal(c);
    if (refused) return refused;
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(await googleService.save(body));
    } catch (error) {
      return googleErrorResponse(c, error);
    }
  });

  const GOOGLE_STATUS_CHECK_MS = 5 * 60 * 1000;

  // One click from a chat link to Google's consent screen: what an agent hands
  // the user when access is lost (`google/lost-access.ts`). A GET because it is a
  // link; it only mints a single-use `state` for the signed-in user and sends
  // them to Google, where nothing happens without their own consent. When it
  // cannot (signed out, read-only, no client saved) it lands on Settings → Google,
  // which says why.
  app.get("/api/google/reconnect", async (c) => {
    const settingsPage = googleSettingsUrl(publicOrigin);
    if (!c.get("session") || !writesAllowed) return c.redirect(settingsPage, 302);
    try {
      return c.redirect(await googleService.startConnect(), 302);
    } catch {
      return c.redirect(settingsPage, 302);
    }
  });

  app.post("/api/google/connect", async (c) => {
    const refused = googleWriteRefusal(c);
    if (refused) return refused;
    try {
      return c.json({ url: await googleService.startConnect() });
    } catch (error) {
      return googleErrorResponse(c, error);
    }
  });

  app.post("/api/google/disconnect", async (c) => {
    const refused = googleWriteRefusal(c);
    if (refused) return refused;
    try {
      return c.json(await googleService.disconnect());
    } catch (error) {
      return googleErrorResponse(c, error);
    }
  });

  app.post("/api/google/verify", async (c) => {
    try {
      return c.json(await googleService.verify());
    } catch (error) {
      return googleErrorResponse(c, error);
    }
  });

  function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  }

  function googleResultPage(title: string, detail: string, status: number): Response {
    const html =
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>${escapeHtml(title)}</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
      `<p><a href="/?settings=google">Back to the app</a> — Settings → Google shows what agents can do.</p>`;
    return hardenedResponse(hardened, html, { "content-type": "text/html; charset=utf-8" }, status);
  }

  // Google's redirect back. Deliberately not gated on the session: with a
  // GOOGLE_OAUTH_REDIRECT_URI override (local testing via localhost) the browser
  // arrives on another origin without our cookie. The single-use `state` minted
  // by the gated /connect is what authorises it.
  app.get("/api/google/oauth/callback", async (c) => {
    try {
      const { email } = await googleService.finishConnect({
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
      });
      return googleResultPage("Google connected", `Agents now act as ${email}.`, 200);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return googleResultPage("Google was not connected", detail, 400);
    }
  });
}
