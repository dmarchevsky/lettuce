import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { BffConfig } from "../config.ts";
import type { Fetch } from "../google/oauth.ts";
import googleTokenFixture from "./fixtures/google-token-response.json";
import googleUserinfoFixture from "./fixtures/google-userinfo-response.json";
import type { SessionPayload } from "./session-cookie.ts";
import { GoogleSignIn, GoogleSignInError, registerGoogleSignInRoutes } from "./signin-google.ts";

const CLIENT = {
  clientId: "1234.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://lettuce.example.com/auth/google/callback",
};

function signIn(fetchImpl: Fetch, now = () => 1_000): GoogleSignIn {
  return new GoogleSignIn({ ...CLIENT, fetchImpl, now });
}

/** Routes each URL it recognises to a canned answer, and refuses anything else. */
function fakeFetch(token: unknown, userinfo: unknown): Fetch {
  return async (input: string) => {
    if (input.includes("/token")) return Response.json(token);
    if (input.includes("/userinfo")) return Response.json(userinfo);
    throw new Error(`unexpected request to ${input}`);
  };
}

/**
 * Pinned response bodies, so a change to what Google sends is a fixture edit and
 * not a silent break in the one flow no local test can reach. These are Google's
 * documented shapes for the token exchange and the userinfo endpoint, not a live
 * capture — record live ones the first time a real client is configured here, and
 * the diff will say whether the parser still holds.
 */
const GOOD_TOKEN = googleTokenFixture;
const GOOD_USERINFO = googleUserinfoFixture;

function stateOf(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

describe("GoogleSignIn.startUrl", () => {
  test("asks for identity only — no offline access, no standing grant", () => {
    const url = new URL(signIn(fakeFetch({}, {})).startUrl());
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CLIENT.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("scope")).toContain("userinfo.email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    // A login asks who you are. `prompt=consent` and `access_type=offline` are the
    // workspace consent's business, and either would show the wide consent screen.
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(url.searchParams.get("prompt")).toBeNull();
  });
});

describe("GoogleSignIn.finish", () => {
  test("the address comes from userinfo, lower-cased", async () => {
    const service = signIn(fakeFetch(GOOD_TOKEN, { ...GOOD_USERINFO, email: "Me@Example.com" }));
    const state = stateOf(service.startUrl());
    expect(await service.finish({ state, code: "code" })).toEqual({ email: "me@example.com" });
  });

  test("a `state` we did not mint is not a sign-in attempt", async () => {
    const service = signIn(
      fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: true }),
    );
    expect(service.finish({ state: "never-minted", code: "code" })).rejects.toThrow(
      GoogleSignInError,
    );
  });

  test("a `state` is single-use, even inside its window", async () => {
    let now = 1_000;
    const service = signIn(
      fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: true }),
      () => now,
    );
    const state = stateOf(service.startUrl());
    await service.finish({ state, code: "code" });
    now += 1000;
    expect(service.finish({ state, code: "code" })).rejects.toThrow(
      /expired or did not start here/,
    );
  });

  test("a `state` older than the window is gone", async () => {
    let now = 1_000;
    const service = signIn(
      fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: true }),
      () => now,
    );
    const state = stateOf(service.startUrl());
    now += 11 * 60 * 1000;
    expect(service.finish({ state, code: "code" })).rejects.toThrow(/expired/);
  });

  test("Google reporting a problem is not a sign-in", async () => {
    const service = signIn(
      fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: true }),
    );
    const state = stateOf(service.startUrl());
    expect(service.finish({ state, error: "access_denied" })).rejects.toThrow(/reported a problem/);
  });

  test("an unverified address is refused — the allowlist is the only gate here", async () => {
    const service = signIn(
      fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: false }),
    );
    const state = stateOf(service.startUrl());
    expect(service.finish({ state, code: "code" })).rejects.toThrow(
      /not consider that address verified/,
    );
  });

  test("an account Google will not name is refused", async () => {
    const service = signIn(fakeFetch(GOOD_TOKEN, { name: "nobody" }));
    const state = stateOf(service.startUrl());
    expect(service.finish({ state, code: "code" })).rejects.toThrow(/did not say which account/);
  });
});

type TestEnv = { Variables: { session?: unknown } };

function routeApp(allowed: string[]) {
  const app = new Hono<TestEnv>();
  const service = signIn(fakeFetch(GOOD_TOKEN, { email: "me@example.com", email_verified: true }));
  registerGoogleSignInRoutes<TestEnv>(app, {
    config: { allowedUsers: allowed } as unknown as BffConfig,
    signIn: service,
    enabled: true,
    redirectUri: CLIENT.redirectUri,
    mint: (email) => ({
      session: { email, exp: 9_999_999_999 } as SessionPayload,
      cookie: `cookie-for-${email}`,
    }),
    log: () => {},
    hardened: {},
  });
  return { app, service };
}

describe("the Google sign-in routes", () => {
  test("an allowlisted address leaves with a session cookie", async () => {
    const { app, service } = routeApp(["me@example.com"]);
    const state = stateOf(service.startUrl());
    const response = await app.request(`/auth/google/callback?state=${state}&code=code`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("cookie-for-me@example.com");
  });

  test("an address off the allowlist gets a page, not a session", async () => {
    const { app, service } = routeApp(["someone-else@example.com"]);
    const state = stateOf(service.startUrl());
    const response = await app.request(`/auth/google/callback?state=${state}&code=code`);
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("not on this instance");
  });

  test("a broken round trip explains itself, redirect URI included", async () => {
    const { app } = routeApp(["me@example.com"]);
    const response = await app.request("/auth/google/callback?state=nope&code=code");
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(CLIENT.redirectUri);
  });

  test("/start goes to Google, not to our own origin", async () => {
    const { app } = routeApp(["me@example.com"]);
    const location = (await app.request("/auth/google/start")).headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.google.com/")).toBe(true);
  });
});
