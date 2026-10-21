/**
 * The sign-in surface: what a browser posts, and who gets a session cookie for
 * it.
 *
 * Three of the four methods live here. `cf-access` has no route of its own — a
 * visitor who gets past Cloudflare Access already carries a JWT that
 * `resolve-session.ts` turns into a session on the way in — and `google` lives
 * in `signin-google.ts`, because a redirect round trip is not a form post.
 *
 * `/auth/*` is outside the `requireSession` gate that covers `/api/*`, so the
 * routes that need an identity ask for it themselves. There is no CSRF token:
 * the session cookie is `SameSite=Lax`, which already stops another site's POST
 * from carrying it.
 */

import type { Context, Hono } from "hono";
import type { BffConfig } from "../config.ts";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { hardenedResponse } from "../security-headers.ts";
import {
  type AttemptLockout,
  assertPasswordIsUsable,
  MIN_PASSWORD_LENGTH,
  type PasswordStore,
} from "./password.ts";
import type { SessionPayload } from "./session-cookie.ts";

/** The identity behind `password` and `none`: one instance, one owner, no address. */
export const OWNER_IDENTITY = "owner";

interface SignInRouteDeps {
  config: BffConfig;
  passwords: PasswordStore;
  lockout: AttemptLockout;
  /** A fresh session for an identity, with the cookie that carries it. */
  mint: (email: string) => { session: SessionPayload; cookie: string };
  log: (message: string) => void;
  /** Carried on the redirects and pages this family builds by hand. */
  hardened: Record<string, string>;
}

/**
 * A credential post is one password and a field name. Anything bigger is not a
 * sign-in attempt, and these three routes answer before anybody is
 * authenticated, so the cap is applied to the bytes actually read: a
 * `content-length` is a claim the client makes, and a chunked request can claim
 * nothing at all.
 */
const MAX_CREDENTIAL_BODY_BYTES = 1024;

type PostedBody =
  | { readonly kind: "body"; readonly fields: Record<string, unknown> }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readPostedBody(request: Request): Promise<PostedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CREDENTIAL_BODY_BYTES) return { kind: "too-large" };

  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_CREDENTIAL_BODY_BYTES) {
      await reader.cancel();
      return { kind: "too-large" };
    }
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return { kind: "invalid" };
    return { kind: "body", fields: parsed as Record<string, unknown> };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * The parsed body, or the refusal that explains the problem. Every route here
 * takes exactly one kind of body, so the refusal is phrased as a fact about the
 * request rather than a description of the limit.
 */
async function readFields(c: Context): Promise<Record<string, unknown> | Response> {
  const posted = await readPostedBody(c.req.raw);
  if (posted.kind === "body") return posted.fields;
  return posted.kind === "too-large"
    ? c.text("That request is too large to be a sign-in.", 413)
    : c.text("Send a JSON body.", 400);
}

/** One string field, or empty: a missing field is a wrong answer, not a crash. */
function field(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  return typeof value === "string" ? value : "";
}

export function registerSignInRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: SignInRouteDeps,
): void {
  const { config, passwords, lockout, mint, log, hardened } = deps;

  const passwordOnly = (c: Context): Response | null =>
    config.signin === "password"
      ? null
      : c.text(`This instance signs people in with SIGNIN=${config.signin}, not a password.`, 404);

  /** The lockout's own answer, so a paused sign-in says how long rather than just "no". */
  const paused = (c: Context, seconds: number): Response =>
    c.json(
      {
        ok: false,
        error: `Too many attempts — sign-in pauses for ${seconds}s.`,
        retryAfter: seconds,
      },
      429,
      { "retry-after": String(seconds) },
    );

  // The unauthenticated instance's only door: `SIGNIN=none` is machine-local by
  // boot rule (`assertSigninIsSafe`), so this is the "Continue" of a laptop
  // browser, not a way in. Every other method sends the visitor to its own
  // credential instead of pretending a GET can produce one.
  app.get("/auth/login", (c) => {
    if (config.signin === "none") {
      log(`Sign-in is off — issued a session to a visitor (machine-local instance).`);
      const { cookie } = mint(OWNER_IDENTITY);
      return hardenedResponse(hardened, null, { location: "/", "set-cookie": cookie }, 302);
    }
    if (config.signin === "google") return c.redirect("/auth/google/start", 302);
    if (config.signin === "cf-access") return c.text("Sign in via Cloudflare Access.", 400);
    return c.text("Sign in with the password for this instance.", 400);
  });

  app.post("/auth/login", async (c) => {
    const refused = passwordOnly(c);
    if (refused) return refused;

    const waiting = lockout.waitSeconds();
    if (waiting) return paused(c, waiting);

    // No credential yet means the setup screen is the right one, and a login
    // form is what the visitor was given — say so with a status the SPA can act
    // on rather than reporting a wrong password it could not have matched.
    if (!(await passwords.current())) {
      return c.json({ ok: false, error: "No password has been chosen on this instance." }, 409);
    }

    const posted = await readFields(c);
    if (posted instanceof Response) return posted;

    const password = field(posted, "password");
    if (await passwords.verify(password)) {
      lockout.recordSuccess();
      const { cookie } = mint(OWNER_IDENTITY);
      c.header("set-cookie", cookie);
      return c.json({ ok: true });
    }

    const lockedFor = lockout.recordFailure();
    log("Rejected a sign-in attempt: wrong password.");
    if (lockedFor) return paused(c, lockedFor);
    return c.json(
      {
        ok: false,
        error: "Wrong password.",
        attemptsLeft: lockout.attemptsLeft(),
        minPasswordLength: MIN_PASSWORD_LENGTH,
      },
      401,
    );
  });

  // First run: the deployment flow that replaced "put a password in .env". Open
  // exactly until a credential exists, and closed by the same read that every
  // other route uses, so there is no second notion of "not yet claimed".
  app.post("/auth/setup", async (c) => {
    const refused = passwordOnly(c);
    if (refused) return refused;
    if (await passwords.current()) {
      return c.text("A password is already set on this instance.", 410);
    }

    const posted = await readFields(c);
    if (posted instanceof Response) return posted;

    const password = field(posted, "password");
    try {
      assertPasswordIsUsable(password);
    } catch (error) {
      return c.text(errorMessage(error), 400);
    }

    await passwords.setPassword(password);
    log("Sign-in password set for the first time — this instance is now claimed.");
    const { cookie } = mint(OWNER_IDENTITY);
    c.header("set-cookie", cookie);
    return c.json({ ok: true });
  });

  app.post("/auth/change-password", async (c) => {
    const refused = passwordOnly(c);
    if (refused) return refused;
    // `/auth/*` is not behind `requireSession`, and changing the password that
    // guards this instance is not something an anonymous request gets to do.
    if (!c.get("session")) return c.text("Unauthorized", 401);

    const posted = await readFields(c);
    if (posted instanceof Response) return posted;

    const current = field(posted, "current");
    const next = field(posted, "next");

    if (!(await passwords.verify(current))) {
      log("Refused a password change: the current password did not match.");
      return c.text("That is not the current password.", 403);
    }
    try {
      assertPasswordIsUsable(next);
    } catch (error) {
      return c.text(errorMessage(error), 400);
    }

    await passwords.setPassword(next);
    log("Sign-in password changed.");
    return c.json({ ok: true });
  });
}
