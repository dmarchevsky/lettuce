import { type BffConfig, isAllowedUser } from "../config.ts";
import { errorMessage } from "../errors.ts";
import { CF_ACCESS_JWT_HEADER, verifyAccessJwt } from "./cf-access.ts";
import {
  decodeSession,
  readCookie,
  SESSION_COOKIE,
  type SessionPayload,
} from "./session-cookie.ts";

export interface ResolvedSession {
  session: SessionPayload;
  /** Set when a session was just minted from an Access JWT: send it back. */
  setCookie?: string;
}

export interface ResolveSessionDeps {
  config: BffConfig;
  /** Build a fresh session and its cookie for `email`. */
  mint: (email: string) => { session: SessionPayload; cookie: string };
  log: (message: string) => void;
  /** Injectable for tests. */
  verify?: typeof verifyAccessJwt;
}

/**
 * The session a request carries: the cookie if it is valid, otherwise — when
 * `SIGNIN=cf-access` — one minted from the Access JWT Cloudflare attached.
 *
 * Both the HTTP middleware and the `/ws` upgrade go through here. The upgrade
 * used to check only the cookie, so once the 30-day cookie expired while the
 * Access login was still good, every WebSocket upgrade was refused and the app
 * sat on "Reconnecting…" until a page reload happened to pass through the
 * middleware and mint a new one.
 */
export async function resolveSession(
  request: Request,
  deps: ResolveSessionDeps,
): Promise<ResolvedSession | null> {
  const { config } = deps;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  // `config.signin` is part of the check, not just of the minting below: a
  // signature this valid only proves the cookie came from us, and the method that
  // issued it is the half that says what it proves.
  const existing = token ? decodeSession(token, config.sessionSecret, config.signin) : null;
  if (existing) return { session: existing };

  // Only the method that reads Cloudflare's header looks at it. A stray
  // Cf-Access-Jwt-Assertion at a password instance — or at one behind a tunnel
  // with no Access policy on it — proves nothing about who is typing, and there
  // may be no team domain configured to verify it against at all.
  if (config.signin !== "cf-access") return null;
  const jwt = request.headers.get(CF_ACCESS_JWT_HEADER);
  if (!jwt) return null;

  try {
    const { email } = await (deps.verify ?? verifyAccessJwt)(jwt, {
      teamDomain: config.cfAccessTeamDomain,
      audience: config.cfAccessAud,
      issuer: config.cfAccessIssuer,
    });
    if (!isAllowedUser(config, email)) {
      deps.log(`Rejected Access sign-in for ${email} (not in allowlist)`);
      return null;
    }
    const minted = deps.mint(email);
    deps.log(`Signed in ${email} via Cloudflare Access`);
    return { session: minted.session, setCookie: minted.cookie };
  } catch (error) {
    deps.log(`Access JWT verification failed: ${errorMessage(error)}`);
    return null;
  }
}
