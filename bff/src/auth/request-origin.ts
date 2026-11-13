/**
 * Same-site request forgery protection for the HTTP routes.
 *
 * The session cookie is `SameSite=Lax`, which keeps another *site's* POST from
 * carrying it — and a site is a registrable domain, not an origin. Ports are not
 * part of it. An agent's web app published at `http://<host>:3005` is the same
 * site as the app at `http://<host>:8090`, so a form or `fetch` on that page
 * arrives here with the owner's cookie attached, and the agent that wrote the
 * page can make the owner's browser change the password, add an MCP server or
 * approve a tool call.
 *
 * So a state-changing request must come from this app's own origin. The rules
 * are the ones the `/ws` upgrade already uses (`origin.ts`), applied to every
 * method that changes something:
 *
 * - `Origin` present → it must pass `checkUpgradeOrigin`. Browsers send `Origin`
 *   on every cross-origin request and on every same-origin POST.
 * - `Origin` absent → `Sec-Fetch-Site`, when the browser sent one, must not say
 *   the request came from elsewhere.
 * - Neither header → not a browser (the smoke suite, `deploy-check`, curl), and
 *   there is no ambient cookie to forge with. Allowed.
 */

import type { Access } from "../config.ts";
import { checkUpgradeOrigin, type OriginCheck } from "./origin.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What `Sec-Fetch-Site` says when the request was started by another origin. */
const FOREIGN_FETCH_SITES = new Set(["cross-site", "same-site"]);

export function checkRequestOrigin(
  request: { method: string; headers: Headers },
  access: Access,
  publicOrigin: string,
): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const origin = request.headers.get("origin");
  if (origin) {
    // `Origin: null` is what a sandboxed frame or a redirected cross-origin
    // request sends; it is a browser, and it is not us.
    if (origin === "null") return { ok: false, reason: "opaque Origin" };
    return checkUpgradeOrigin(origin, access, publicOrigin, request.headers.get("host"));
  }

  return startedElsewhere(request.headers)
    ? { ok: false, reason: `Sec-Fetch-Site ${request.headers.get("sec-fetch-site")}` }
    : { ok: true };
}

/**
 * Whether the browser says another origin started this request. Used on its own
 * for the one GET that has an effect worth protecting — see
 * `/api/google/reconnect`.
 */
export function startedElsewhere(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  return site !== undefined && FOREIGN_FETCH_SITES.has(site);
}
