/**
 * Cross-site WebSocket protection.
 *
 * A WebSocket handshake is not subject to CORS. The session cookie is what
 * authenticates the socket, and `SameSite=Lax` does not cover WebSocket
 * upgrades — so without an Origin check, any page the signed-in user visits
 * can open a socket to this BFF and act as them for the whole session.
 *
 * Browsers always send `Origin` on a WebSocket upgrade. A non-browser client
 * (the smoke script, a CLI) may omit it, and the app-server itself rejects an
 * unauthenticated upgrade that carries an `Origin` — so an absent header is
 * treated as "not a browser" and allowed, while a present one must match.
 *
 * What "match" means depends on how the app is reached:
 *
 * - **cloudflared**: the Origin must be exactly `PUBLIC_ORIGIN`. Cloudflare
 *   rewrites `Host` to the origin's own address, so the request's Host is not
 *   the user-facing origin and cannot be compared against. The declared public
 *   origin is the only trustworthy answer here, and pinning it also means a
 *   Host-header injection cannot smuggle a different origin through.
 * - **lan**: the app is reached directly, often by LAN IP or `localhost` with a
 *   port that varies between dev and the container. Requiring an exact match
 *   against `PUBLIC_ORIGIN` would break legitimate access, so the rule is
 *   same-origin: the Origin's host and port must equal the request's `Host`
 *   header. That is exactly the property cross-site requests violate, and it
 *   holds however the machine is addressed.
 *
 *   A loopback Origin is additionally accepted in this mode, because the Vite
 *   dev server proxies `/ws` with `changeOrigin` and so presents
 *   `Origin: http://localhost:5173` against a different `Host`. That is not a
 *   weakening: the cross-site attack requires the attacker's page to carry the
 *   victim's cookie to this server, and a page served from a remote host can
 *   never have a loopback Origin. Only something already running on this
 *   machine does.
 *
 *   With one exception, which is exactly "something already running on this
 *   machine": an agent's web app. Those are published on ports 3000-3099 with no
 *   authentication of their own, and cookies are not scoped by port, so a page
 *   an agent serves at `http://localhost:3005` is *same-site* with the app at
 *   `http://localhost:8090` and the browser attaches the session cookie to
 *   whatever it sends here. A loopback Origin on an agent-app port is therefore
 *   refused unless it is this server's own address.
 */

import type { Access } from "../config.ts";

export interface OriginCheck {
  ok: boolean;
  reason?: string;
}

function sameHostAndPort(originUrl: URL, hostHeader: string): boolean {
  const originHost = originUrl.host.toLowerCase();
  const header = hostHeader.trim().toLowerCase();
  if (!header) return false;
  if (originHost === header) return true;
  // A browser sends the default port explicitly only when it is non-default;
  // compare with the default port filled in on both sides.
  const withDefault = (value: string): string => {
    if (value.includes(":")) return value;
    return `${value}:${originUrl.protocol === "https:" ? "443" : "80"}`;
  };
  return withDefault(originHost) === withDefault(header);
}

/**
 * Whether a WebSocket upgrade from `originHeader` may proceed.
 *
 * `access` is how the BFF is reached; `publicOrigin` its declared public origin;
 * `hostHeader` the `Host` header of the upgrade request.
 */
export function checkUpgradeOrigin(
  originHeader: string | null,
  access: Access,
  publicOrigin: string,
  hostHeader: string | null,
): OriginCheck {
  if (originHeader === null || originHeader === "") return { ok: true };

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return { ok: false, reason: `unparseable Origin: ${originHeader}` };
  }

  const declared = publicOrigin.replace(/\/+$/, "");
  if (originHeader.replace(/\/+$/, "") === declared) return { ok: true };

  if (access === "cloudflared") {
    return {
      ok: false,
      reason: `Origin ${originHeader} is not the declared public origin ${declared}`,
    };
  }

  if (hostHeader && sameHostAndPort(originUrl, hostHeader)) return { ok: true };

  if (isLoopbackHostname(originUrl.hostname)) {
    if (isAgentAppPort(originUrl.port)) {
      return { ok: false, reason: `Origin ${originHeader} is an agent app's port` };
    }
    return { ok: true };
  }

  if (!hostHeader) {
    return { ok: false, reason: `no Host header to compare Origin ${originHeader} against` };
  }

  return {
    ok: false,
    reason: `Origin ${originHeader} is not same-origin with host ${hostHeader}`,
  };
}

/** `localhost`, `127.x.x.x` and `::1`, with or without brackets. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * The host ports `docker/compose.yml` publishes for agents' own web apps
 * (`AGENT_APP_PORTS`). A literal on purpose: the range is a literal in the
 * compose file's port mapping too, and nothing configures one without the other.
 */
const AGENT_APP_PORT_FIRST = 3000;
const AGENT_APP_PORT_LAST = 3099;

function isAgentAppPort(port: string): boolean {
  const value = Number(port);
  return port !== "" && value >= AGENT_APP_PORT_FIRST && value <= AGENT_APP_PORT_LAST;
}
