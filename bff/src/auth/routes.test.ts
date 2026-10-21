import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BffConfig, Signin } from "../config.ts";
import { AttemptLockout, PasswordStore } from "./password.ts";
import { OWNER_IDENTITY, registerSignInRoutes } from "./routes.ts";
import type { SessionPayload } from "./session-cookie.ts";

type TestEnv = { Variables: { session?: { email: string } | null } };

async function setup(
  signin: Signin = "password",
  session: { email: string } | null = null,
): Promise<{ app: Hono<TestEnv>; passwords: PasswordStore; lockout: AttemptLockout }> {
  const passwords = new PasswordStore(await mkdtemp(join(tmpdir(), "lettuce-signin-routes-")));
  const lockout = new AttemptLockout();
  const app = new Hono<TestEnv>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  registerSignInRoutes<TestEnv>(app, {
    config: { signin } as unknown as BffConfig,
    passwords,
    lockout,
    mint: (email) => ({
      session: { email, exp: 9_999_999_999 } as SessionPayload,
      cookie: `cookie-for-${email}`,
    }),
    log: () => {},
    hardened: {},
  });
  return { app, passwords, lockout };
}

function post(app: Hono<TestEnv>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const GOOD = "correct horse battery";
const OTHER = "staple on the desk now";

describe("POST /auth/login", () => {
  test("before a password exists it says so, rather than calling it wrong", async () => {
    const { app } = await setup();
    const response = await post(app, "/auth/login", { password: "whatever" });
    expect(response.status).toBe(409);
  });

  test("the right password mints the session and its cookie", async () => {
    const { app, passwords } = await setup();
    await passwords.setPassword(GOOD);
    const response = await post(app, "/auth/login", { password: GOOD });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("cookie-for-owner");
  });

  test("a wrong password costs an attempt and says how many are left", async () => {
    const { app, passwords } = await setup();
    await passwords.setPassword(GOOD);
    const response = await post(app, "/auth/login", { password: "wrong" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; attemptsLeft: number };
    expect(body.ok).toBe(false);
    expect(body.attemptsLeft).toBe(4);
  });

  test("the fifth wrong attempt pauses sign-in and says for how long", async () => {
    const { app, passwords } = await setup();
    await passwords.setPassword(GOOD);
    for (let i = 0; i < 4; i += 1) await post(app, "/auth/login", { password: "wrong" });
    expect((await post(app, "/auth/login", { password: "wrong" })).status).toBe(429);
    const blocked = await post(app, "/auth/login", { password: GOOD });
    // The right password does not get through a pause: the pause is the point.
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });

  test("a success clears the attempts", async () => {
    const { app, passwords } = await setup();
    await passwords.setPassword(GOOD);
    for (let i = 0; i < 4; i += 1) await post(app, "/auth/login", { password: "wrong" });
    expect((await post(app, "/auth/login", { password: GOOD })).status).toBe(200);
    for (let i = 0; i < 4; i += 1) {
      expect((await post(app, "/auth/login", { password: "wrong" })).status).toBe(401);
    }
  });

  test("a method with no password refuses the route outright", async () => {
    const { app } = await setup("cf-access");
    expect((await post(app, "/auth/login", { password: GOOD })).status).toBe(404);
  });
});

describe("POST /auth/setup", () => {
  test("the first one claims the instance and signs the visitor straight in", async () => {
    const { app, passwords } = await setup();
    const response = await post(app, "/auth/setup", { password: GOOD });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`cookie-for-${OWNER_IDENTITY}`);
    expect(await passwords.verify(GOOD)).toBe(true);
  });

  test("a short password is refused before anything is written", async () => {
    const { app, passwords } = await setup();
    expect((await post(app, "/auth/setup", { password: "short" })).status).toBe(400);
    expect(await passwords.claimed()).toBe(false);
  });

  test("exactly one setup ever happens", async () => {
    const { app, passwords } = await setup();
    await post(app, "/auth/setup", { password: GOOD });
    expect((await post(app, "/auth/setup", { password: OTHER })).status).toBe(410);
    // The second visitor does not get to overwrite the first one's password.
    expect(await passwords.verify(GOOD)).toBe(true);
  });
});

describe("POST /auth/change-password", () => {
  test("an anonymous request is refused — /auth/* has no session gate", async () => {
    const { app, passwords } = await setup();
    await passwords.setPassword(GOOD);
    const response = await post(app, "/auth/change-password", { current: GOOD, next: OTHER });
    expect(response.status).toBe(401);
    expect(await passwords.verify(GOOD)).toBe(true);
  });

  test("the current password is proved before the new one is taken", async () => {
    const { app, passwords } = await setup("password", { email: OWNER_IDENTITY });
    await passwords.setPassword(GOOD);
    expect(
      (await post(app, "/auth/change-password", { current: "wrong", next: OTHER })).status,
    ).toBe(403);
    expect(await passwords.verify(GOOD)).toBe(true);

    const ok = await post(app, "/auth/change-password", { current: GOOD, next: OTHER });
    expect(ok.status).toBe(200);
    expect(await passwords.verify(GOOD)).toBe(false);
    expect(await passwords.verify(OTHER)).toBe(true);
  });

  test("a too-short replacement is refused after the current one checked out", async () => {
    const { app, passwords } = await setup("password", { email: OWNER_IDENTITY });
    await passwords.setPassword(GOOD);
    expect(
      (await post(app, "/auth/change-password", { current: GOOD, next: "short" })).status,
    ).toBe(400);
    expect(await passwords.verify(GOOD)).toBe(true);
  });
});

describe("GET /auth/login", () => {
  test("SIGNIN=none hands out the owner's session", async () => {
    const { app } = await setup("none");
    const response = await app.request("/auth/login");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(`cookie-for-${OWNER_IDENTITY}`);
  });

  test("every other method sends the visitor to its credential", async () => {
    const password = await setup("password");
    expect((await password.app.request("/auth/login")).status).toBe(400);

    const cf = await setup("cf-access");
    const cfResponse = await cf.app.request("/auth/login");
    expect(cfResponse.status).toBe(400);
    expect(await cfResponse.text()).toContain("Cloudflare Access");

    const google = await setup("google");
    const googleResponse = await google.app.request("/auth/login");
    expect(googleResponse.status).toBe(302);
    expect(googleResponse.headers.get("location")).toBe("/auth/google/start");
  });
});

describe("the credential body cap", () => {
  test("a body bigger than a credential is refused, not buffered", async () => {
    const { app } = await setup();
    expect((await post(app, "/auth/setup", { password: "x".repeat(4000) })).status).toBe(413);
    const { app: loginApp, passwords } = await setup();
    await passwords.setPassword(GOOD);
    const response = await post(loginApp, "/auth/login", { password: "x".repeat(4000) });
    expect(response.status).toBe(413);
  });

  test("a stream that claims no length is capped as it arrives", async () => {
    const { app } = await setup();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"password":"'));
        for (let i = 0; i < 40; i += 1) controller.enqueue(encoder.encode("a".repeat(200)));
        controller.close();
      },
    });
    const response = await app.request("/auth/setup", { method: "POST", body: stream });
    expect(response.status).toBe(413);
  });

  test("a body that is not JSON is refused as one", async () => {
    const { app } = await setup();
    const response = await app.request("/auth/setup", { method: "POST", body: "password=plain" });
    expect(response.status).toBe(400);
  });
});
