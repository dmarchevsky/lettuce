/**
 * `SIGNIN=google`: Google answers who you are, and this instance decides whether
 * that answer is on its allowlist.
 *
 * It uses the **same OAuth client as Settings → Google Workspace**, from
 * `docker/.env` rather than from Settings — sign-in happens before anybody could
 * have opened Settings, so env is the only source that can satisfy it. One
 * client, two flows: this one asks for the identity scopes only, online-only, and
 * never keeps a token. The workspace consent keeps a refresh token for agents;
 * a login keeps a session cookie.
 *
 * The client and the sidecar are deliberately not coupled beyond the credentials:
 * the `google` profile token gates the sidecar, and turning it off must not lock
 * the owner out of the app.
 */

import type { Hono } from "hono";
import { type BffConfig, isAllowedUser } from "../config.ts";
import { errorMessage } from "../errors.ts";
import {
  type Fetch,
  GOOGLE_AUTH_URI,
  GOOGLE_USERINFO_URI,
  newPkce,
  newState,
  postForm,
  readTokenResponse,
} from "../google/oauth.ts";
import { IDENTITY_SCOPES } from "../google/policy.ts";
import { GOOGLE_TOKEN_URI } from "../google/settings.ts";
import { resultPage } from "../html-page.ts";
import type { RouteEnv } from "../route-env.ts";
import { hardenedResponse } from "../security-headers.ts";
import type { SessionPayload } from "./session-cookie.ts";

/** Long enough to finish a consent screen on a phone, short enough not to linger. */
const PENDING_TTL_MS = 10 * 60 * 1000;

export class GoogleSignInError extends Error {}

interface PendingLogin {
  verifier: string;
  expiresAt: number;
}

interface GoogleSignInOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Injectable so the round trip is testable without Google. */
  fetchImpl?: Fetch;
  now?: () => number;
}

export class GoogleSignIn {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleSignInOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The consent URL. No `access_type=offline` and no `prompt=consent`: a login
   * asks who you are, not for standing access, so there is nothing to store. */
  startUrl(): string {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(state);
    }
    const state = newState();
    const { verifier, challenge } = newPkce();
    this.pending.set(state, { verifier, expiresAt: now + PENDING_TTL_MS });

    const url = new URL(GOOGLE_AUTH_URI);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", IDENTITY_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** The address Google says this is. Throws for a cancelled, expired or unverified one. */
  async finish(query: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ email: string }> {
    if (query.error) {
      throw new GoogleSignInError("Google reported a problem, so nobody signed in.");
    }
    const state = query.state;
    const pending = state ? this.pending.get(state) : undefined;
    if (!state || !pending || pending.expiresAt < this.now()) {
      throw new GoogleSignInError("That sign-in attempt has expired or did not start here.");
    }
    // Single-use, and before the exchange: a code Google already handed out for
    // this `state` proves nothing about the visitor holding it now.
    this.pending.delete(state);
    if (!query.code) throw new GoogleSignInError("Google returned no code.");

    const tokens = await readTokenResponse(
      await postForm(this.fetchImpl, GOOGLE_TOKEN_URI, {
        grant_type: "authorization_code",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: query.code,
        redirect_uri: this.options.redirectUri,
        code_verifier: pending.verifier,
      }),
    );
    if (!tokens.access_token) throw new GoogleSignInError("Google returned no access token.");

    const response = await this.fetchImpl(GOOGLE_USERINFO_URI, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!response.ok)
      throw new GoogleSignInError(`Google userinfo answered HTTP ${response.status}`);
    const account = (await response.json()) as {
      email?: unknown;
      email_verified?: unknown;
    };
    if (typeof account.email !== "string" || !account.email.includes("@")) {
      throw new GoogleSignInError("Google did not say which account this is.");
    }
    // An unverified address is a name anyone can register, and the allowlist is
    // the only gate in this method — so it has to be an address Google vouches for.
    if (account.email_verified !== true) {
      throw new GoogleSignInError("Google does not consider that address verified.");
    }
    return { email: account.email.trim().toLowerCase() };
  }
}

interface GoogleSignInRouteDeps {
  config: BffConfig;
  signIn: GoogleSignIn;
  /** Whether the method is live at all — false when the credentials are missing. */
  enabled: boolean;
  redirectUri: string;
  mint: (email: string) => { session: SessionPayload; cookie: string };
  log: (message: string) => void;
  hardened: Record<string, string>;
}

export function registerGoogleSignInRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: GoogleSignInRouteDeps,
): void {
  const { config, signIn, enabled, redirectUri, mint, log, hardened } = deps;

  if (!enabled) return;

  app.get("/auth/google/start", (c) => c.redirect(signIn.startUrl(), 302));

  // Google writes here. Not gated on a session, like the workspace callback:
  // the single-use `state` minted by /start is what authorises the visit.
  app.get("/auth/google/callback", async (c) => {
    try {
      const { email } = await signIn.finish({
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
      });
      if (!isAllowedUser(config, email)) {
        log(`Rejected Google sign-in for ${email} (not in allowlist)`);
        return resultPage({
          hardened,
          title: "Not allowed here",
          detail: `${email} is not on this instance's allowlist.`,
          status: 403,
          note: "The allowlist is ALLOWED_USERS in docker/.env.",
        });
      }
      log(`Signed in ${email} with Google`);
      const { cookie } = mint(email);
      return hardenedResponse(hardened, null, { location: "/", "set-cookie": cookie }, 302);
    } catch (error) {
      log(`Google sign-in failed: ${errorMessage(error)}`);
      // A failure page must not read like a success one, and the one hint it can
      // give has to fit every failure here — an expired state, a cancelled
      // consent, an unverified address and a misregistered redirect URI alike.
      return resultPage({
        hardened,
        title: "Sign-in did not finish",
        detail: errorMessage(error),
        status: 400,
        note: `If this repeats, the Google client must list this origin's redirect URI: ${redirectUri}.`,
      });
    }
  });
}
