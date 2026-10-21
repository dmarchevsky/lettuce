import { describe, expect, test } from "bun:test";
import type { BffConfig } from "../config.ts";
import { type ResolveSessionDeps, resolveSession } from "./resolve-session.ts";
import { encodeSession, SESSION_COOKIE, type SessionPayload } from "./session-cookie.ts";

const SECRET = "test-secret";

function config(signin: BffConfig["signin"]): BffConfig {
  return {
    signin,
    sessionSecret: SECRET,
    allowedUsers: ["me@example.com"],
    cfAccessTeamDomain: "team",
    cfAccessAud: "aud",
    cfAccessIssuer: null,
  } as unknown as BffConfig;
}

function deps(signin: BffConfig["signin"], email: string | Error): ResolveSessionDeps {
  return {
    config: config(signin),
    mint: (who) => ({
      session: { email: who, exp: 9_999_999_999, via: signin },
      cookie: `minted-for-${who}`,
    }),
    log: () => {},
    verify: async () => {
      if (email instanceof Error) throw email;
      return { email };
    },
  };
}

function request(headers: Record<string, string>): Request {
  return new Request("https://app.example/ws", { headers });
}

const now = Math.floor(Date.now() / 1000);
const validCookie = `${SESSION_COOKIE}=${encodeSession({ email: "me@example.com", exp: now + 3600, via: "cf-access" }, SECRET)}`;
const expiredCookie = `${SESSION_COOKIE}=${encodeSession({ email: "me@example.com", exp: now - 10, via: "cf-access" }, SECRET)}`;

describe("resolveSession", () => {
  test("a valid cookie wins, and nothing is minted", async () => {
    const resolved = await resolveSession(
      request({ cookie: validCookie, "cf-access-jwt-assertion": "jwt" }),
      deps("cf-access", "me@example.com"),
    );
    expect(resolved?.session.email).toBe("me@example.com");
    expect(resolved?.setCookie).toBeUndefined();
  });

  test("an expired cookie with a valid Access JWT mints a new session", async () => {
    const resolved = await resolveSession(
      request({ cookie: expiredCookie, "cf-access-jwt-assertion": "jwt" }),
      deps("cf-access", "me@example.com"),
    );
    expect(resolved?.setCookie).toBe("minted-for-me@example.com");
  });

  test("an expired cookie and no JWT is signed out", async () => {
    const resolved = await resolveSession(
      request({ cookie: expiredCookie }),
      deps("cf-access", "me@example.com"),
    );
    expect(resolved).toBeNull();
  });

  test("a JWT for someone off the allowlist is refused", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("cf-access", "stranger@example.com"),
    );
    expect(resolved).toBeNull();
  });

  test("a JWT that fails verification is refused", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("cf-access", new Error("bad signature")),
    );
    expect(resolved).toBeNull();
  });

  test("a cookie minted under another method is signed out", async () => {
    // The case that matters: `SIGNIN=none` (and the old dev bypass) hands a
    // signature-valid cookie to any visitor, and tightening the method has to
    // retire those sessions rather than honour them for another 30 days.
    const fromNone = `${SESSION_COOKIE}=${encodeSession(
      { email: "me@example.com", exp: now + 3600, via: "none" },
      SECRET,
    )}`;
    expect(
      await resolveSession(request({ cookie: fromNone }), deps("password", "x@e.com")),
    ).toBeNull();
    // And one predating the field entirely: correctly signed, no `via` at all.
    const before = `${SESSION_COOKIE}=${encodeSession(
      { email: "me@example.com", exp: now + 3600 } as SessionPayload,
      SECRET,
    )}`;
    expect(
      await resolveSession(request({ cookie: before }), deps("password", "x@e.com")),
    ).toBeNull();
  });

  test("a password instance never reads the Access header", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("password", "me@example.com"),
    );
    expect(resolved).toBeNull();
  });
});
