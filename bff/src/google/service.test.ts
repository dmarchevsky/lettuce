import { describe, expect, test } from "bun:test";
import { GOOGLE_REVOKE_URI, GOOGLE_USERINFO_URI } from "./oauth.ts";
import { scopesForPermissions } from "./policy.ts";
import { GoogleAccessError, type GoogleIo, GoogleService } from "./service.ts";
import {
  GOOGLE_SETTINGS_FILE,
  GOOGLE_SIDECAR_FILE,
  GOOGLE_TOKEN_URI,
  type SidecarConfig,
} from "./settings.ts";

const G = "https://www.googleapis.com/auth/";

function memoryIo() {
  const policy = new Map<string, string>();
  const creds = new Map<string, string>();
  const io: GoogleIo = {
    readPolicy: async (name) => policy.get(name) ?? null,
    writePolicy: async (name, content) => void policy.set(name, content),
    listCreds: async () => [...creds.keys()],
    readCred: async (name) => creds.get(name) ?? null,
    writeCred: async (name, content) => void creds.set(name, content),
    deleteCred: async (name) => void creds.delete(name),
  };
  return { io, policy, creds };
}

/**
 * A fake Google: grants whatever scopes `grant` says, records revokes. Like the
 * real one, a revoke removes the account's whole grant: every refresh token
 * that account was issued so far stops working, not just the one named.
 */
function fakeGoogle(opts: { grant?: (asked: string[]) => string[] } = {}) {
  const revoked: string[] = [];
  const dead = new Set<string>();
  const issuedTo = new Map<string, string>();
  let account = "Me@Example.com";
  let tokenCount = 0;
  let lastAsked: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === GOOGLE_TOKEN_URI) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        if (dead.has(form.get("refresh_token") ?? "")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: "a2", scope: lastAsked.join(" ") });
      }
      tokenCount += 1;
      issuedTo.set(`refresh-${tokenCount}`, account);
      issuedTo.set(`access-${tokenCount}`, account);
      const scopes = (opts.grant ?? ((asked) => asked))(lastAsked);
      return Response.json({
        access_token: `access-${tokenCount}`,
        refresh_token: `refresh-${tokenCount}`,
        expires_in: 3600,
        scope: scopes.join(" "),
      });
    }
    if (url === GOOGLE_REVOKE_URI) {
      const token = new URLSearchParams(String(init?.body)).get("token") ?? "";
      revoked.push(token);
      const owner = issuedTo.get(token);
      for (const [issued, to] of issuedTo) if (to === owner) dead.add(issued);
      return new Response("", { status: 200 });
    }
    if (url === GOOGLE_USERINFO_URI) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ email: issuedTo.get(auth.replace(/^Bearer /, "")) ?? account });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return {
    fetch,
    revoked,
    /** Refresh tokens Google no longer honours. */
    dead,
    /** The account the next consent signs in as. */
    signInAs(email: string) {
      account = email;
    },
    ask(url: string) {
      lastAsked = (new URL(url).searchParams.get("scope") ?? "").split(" ");
      return new URL(url).searchParams.get("state") ?? "";
    },
  };
}

function setup(opts: Parameters<typeof fakeGoogle>[0] = {}) {
  const mem = memoryIo();
  const google = fakeGoogle(opts);
  const mcp: boolean[] = [];
  const service = new GoogleService({
    io: mem.io,
    fetch: google.fetch,
    redirectUri: "https://ui.example/api/google/oauth/callback",
    syncMcpEntry: async (serving) => void mcp.push(serving),
    log: () => {},
  });
  const sidecar = () => JSON.parse(mem.policy.get(GOOGLE_SIDECAR_FILE) ?? "{}") as SidecarConfig;
  const connect = async () => {
    const state = google.ask(await service.startConnect());
    return service.finishConnect({ state, code: "c" });
  };
  return { ...mem, google, service, mcp, sidecar, connect };
}

const CLIENT = { clientId: "id.apps.googleusercontent.com", clientSecret: "secret" };
const POLICY = { gmail: "readonly", calendar: "full", tasks: "manage" };

describe("connecting", () => {
  test("asks for exactly the policy's scopes and serves them", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    expect(t.sidecar().enabled).toBe(false);

    const url = new URL(await t.service.startConnect());
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(
      scopesForPermissions(POLICY as never),
    );
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
    expect(url.searchParams.get("access_type")).toBe("offline");

    const { email } = await t.connect();
    expect(email).toBe("me@example.com");
    expect([...t.creds.keys()]).toEqual(["me@example.com.json"]);
    expect(t.sidecar()).toMatchObject({
      enabled: true,
      email: "me@example.com",
      permissions: ["gmail:readonly", "calendar:full", "tasks:manage"],
    });
    expect(t.mcp.at(-1)).toBe(true);
  });

  test("a state can be used once only, and a made-up one never", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    const state = t.google.ask(await t.service.startConnect());
    await t.service.finishConnect({ state, code: "c" });
    await expect(t.service.finishConnect({ state, code: "c" })).rejects.toThrow(GoogleAccessError);
    await expect(t.service.finishConnect({ state: "forged", code: "c" })).rejects.toThrow(
      GoogleAccessError,
    );
  });

  test("a scope left unticked lowers the served level", async () => {
    const t = setup({ grant: (asked) => asked.filter((s) => s !== `${G}calendar`) });
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    expect(t.sidecar().permissions).toEqual([
      "gmail:readonly",
      "calendar:readonly",
      "tasks:manage",
    ]);
    expect((await t.service.status()).needsReconnect).toBe(true);
  });

  test("a token wider than the policy is revoked, not kept", async () => {
    const t = setup({ grant: (asked) => [...asked, `${G}gmail.send`] });
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await expect(t.connect()).rejects.toThrow(/more than the current settings allow/);
    expect(t.google.revoked).toEqual(["refresh-1"]);
    expect(t.creds.size).toBe(0);
    expect(t.sidecar().enabled).toBe(false);
  });

  test("reconnecting the same account keeps the new token working", async () => {
    // Revoking the replaced token revoked the account's grant, and with it the
    // token just issued: the first refresh after a reconnect got invalid_grant.
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.connect();
    expect(t.google.revoked).toEqual([]);
    expect([...t.creds.keys()]).toEqual(["me@example.com.json"]);
    expect(t.google.dead.has("refresh-2")).toBe(false);
    const { warning, settings } = await t.service.verify();
    expect(warning).toBeNull();
    expect(settings.grant?.email).toBe("me@example.com");
  });

  test("switching to another account revokes the old account's token only", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    t.google.signInAs("other@example.com");
    const { email } = await t.connect();
    expect(email).toBe("other@example.com");
    expect(t.google.revoked).toEqual(["refresh-1"]);
    expect([...t.creds.keys()]).toEqual(["other@example.com.json"]);
    expect(t.google.dead.has("refresh-2")).toBe(false);
    expect((await t.service.verify()).warning).toBeNull();
  });

  test("a too-wide reconnect of the same account drops the stored token too", async () => {
    // The revoke of the rejected token takes the account's grant with it, so
    // the stored token cannot be left in place looking connected.
    let wide = false;
    const t = setup({ grant: (asked) => (wide ? [...asked, `${G}gmail.send`] : asked) });
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    wide = true;
    await expect(t.connect()).rejects.toThrow(/more than the current settings allow/);
    expect(t.google.dead.has("refresh-1")).toBe(true);
    expect(t.creds.size).toBe(0);
    expect((await t.service.status()).grant).toBeNull();
    expect(t.sidecar().enabled).toBe(false);
  });
});

describe("changing the policy", () => {
  test("narrowing revokes the token and stops serving", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: { ...POLICY, gmail: "send" } });
    await t.connect();
    await t.service.save({ permissions: { gmail: "readonly" } });
    expect(t.google.revoked).toEqual(["refresh-1"]);
    expect(t.creds.size).toBe(0);
    expect(t.sidecar().enabled).toBe(false);
    expect(t.mcp.at(-1)).toBe(false);
  });

  test("switching tasks between manage and full keeps the token", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: { ...POLICY, tasks: "full" } });
    await t.connect();
    await t.service.save({ permissions: { tasks: "manage" } });
    expect(t.google.revoked).toEqual([]);
    expect(t.sidecar().permissions).toContain("tasks:manage");
  });

  test("widening keeps the token and waits for a reconnect", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    const { settings } = await t.service.save({ permissions: { gmail: "send" } });
    expect(t.google.revoked).toEqual([]);
    expect(settings.needsReconnect).toBe(true);
    expect(t.sidecar().permissions).toContain("gmail:readonly");
  });

  test("disabling stops serving but keeps the grant", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.service.save({ enabled: false });
    expect(t.sidecar()).toMatchObject({ enabled: false, clientSecret: "", permissions: [] });
    expect(t.creds.size).toBe(1);
  });

  test("a dropped profile token stops serving while the stored switch and grant stay intact", async () => {
    let on = true;
    const t = setup();
    const service = new GoogleService({
      io: t.io,
      fetch: t.google.fetch,
      redirectUri: "https://ui.example/api/google/oauth/callback",
      syncMcpEntry: async (serving) => void t.mcp.push(serving),
      profileEnabled: () => on,
      log: () => {},
    });
    await service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    const state = t.google.ask(await service.startConnect());
    await service.finishConnect({ state, code: "c" });
    expect(t.sidecar().enabled).toBe(true);

    on = false; // COMPOSE_PROFILES loses `google`, and the BFF reconnects
    await service.reapply();
    expect(t.sidecar().enabled).toBe(false);
    expect(t.mcp.at(-1)).toBe(false);
    const status = await service.status();
    expect(status.enabled).toBe(false);
    expect(status.grant?.email).toBe("me@example.com"); // grant kept, not revoked
    expect(t.creds.size).toBe(1);
    expect(t.google.revoked).toEqual([]);

    on = true; // the token comes back: the setup is still there, switch included
    await service.reapply();
    expect(t.sidecar().enabled).toBe(true);
    expect(t.mcp.at(-1)).toBe(true);
    expect((await service.status()).enabled).toBe(true);
  });

  test("a new OAuth client drops the old client's token", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.service.save({ clientSecret: "rotated" });
    expect(t.google.revoked).toEqual(["refresh-1"]);
    expect((await t.service.status()).grant).toBeNull();
  });

  test("the secret never reaches the public view", async () => {
    const t = setup();
    const { settings } = await t.service.save({ ...CLIENT });
    expect(JSON.stringify(settings)).not.toContain('secret"');
    expect(settings.hasClientSecret).toBe(true);
  });

  test("an unknown level is refused", async () => {
    const t = setup();
    await expect(t.service.save({ permissions: { gmail: "everything" } })).rejects.toThrow();
    await expect(t.service.save({ permissions: { drive: "full" } })).rejects.toThrow();
  });
});

describe("allowed recipients", () => {
  test("saved normalised, served to the sidecar, and the token left alone", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: { ...POLICY, gmail: "send" } });
    await t.connect();
    const { settings } = await t.service.save({
      allowedRecipients: [" Friend@Example.com ", "", "@Example.ORG", "friend@example.com"],
    });
    expect(settings.allowedRecipients).toEqual(["friend@example.com", "@example.org"]);
    expect(t.sidecar().allowedRecipients).toEqual(["friend@example.com", "@example.org"]);
    expect(t.google.revoked).toEqual([]);
    expect(settings.needsReconnect).toBe(false);
  });

  test("an empty list means no restriction, and is the default", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    expect(t.sidecar().allowedRecipients).toEqual([]);
    await t.service.save({ allowedRecipients: ["a@example.com"] });
    await t.service.save({ allowedRecipients: [] });
    expect(t.sidecar().allowedRecipients).toEqual([]);
  });

  test("other saves keep the list", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.service.save({ allowedRecipients: ["a@example.com"] });
    const { settings } = await t.service.save({ permissions: { gmail: "readonly" } });
    expect(settings.allowedRecipients).toEqual(["a@example.com"]);
  });

  test("a sidecar that serves nothing gets no list", async () => {
    const t = setup();
    await t.service.save({ allowedRecipients: ["a@example.com"] });
    expect(t.sidecar()).toMatchObject({ enabled: false, allowedRecipients: [] });
  });

  test("an entry that is not an address or @domain is refused, naming it", async () => {
    const t = setup();
    for (const bad of [
      "alice",
      "a@b",
      "Alice <a@example.com>",
      "a@example.com, b@example.com",
      "a b@example.com",
      "@",
    ]) {
      await expect(t.service.save({ allowedRecipients: [bad] })).rejects.toThrow(bad.trim());
    }
    await expect(t.service.save({ allowedRecipients: "a@example.com" })).rejects.toThrow();
    await expect(t.service.save({ allowedRecipients: [1] })).rejects.toThrow();
  });

  test("a stored list with junk in it loads what is valid", async () => {
    const t = setup();
    t.policy.set(
      GOOGLE_SETTINGS_FILE,
      JSON.stringify({
        enabled: false,
        allowedRecipients: ["ok@example.com", 3, "nope", "@example.org"],
      }),
    );
    expect((await t.service.status()).allowedRecipients).toEqual([
      "ok@example.com",
      "@example.org",
    ]);
  });
});

describe("disconnect and verify", () => {
  test("disconnect revokes and clears", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.service.disconnect();
    expect(t.google.revoked).toEqual(["refresh-1"]);
    expect(t.creds.size).toBe(0);
    expect(t.sidecar().enabled).toBe(false);
  });

  test("verify marks a token Google refuses as lost, keeping the account", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    t.google.dead.add("refresh-1"); // revoked by the account owner, outside the app
    const { settings, warning } = await t.service.verify();
    expect(settings.grant?.email).toBe("me@example.com");
    expect(settings.grant?.lostAt).toBeString();
    expect(settings.needsReconnect).toBe(true);
    expect(warning).toMatch(/no longer accepts the token for me@example.com/);
    // Still served, so a Google call tells the agent to send the user to reconnect.
    expect(t.sidecar().enabled).toBe(true);
  });

  test("a tool's auth failure marks the grant lost, once", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    expect(await t.service.markLost("invalid_grant")).toEqual({ email: "me@example.com" });
    const first = (await t.service.status()).grant?.lostAt;
    expect(first).toBeString();
    await t.service.markLost("invalid_grant again");
    expect((await t.service.status()).grant?.lostAt).toBe(first);
    expect(t.creds.size).toBe(1);
  });

  test("reconnecting after a loss clears it, and revokes nothing", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    t.google.dead.add("refresh-1");
    await t.service.verify();
    await t.connect();
    const status = await t.service.status();
    expect(status.grant?.lostAt).toBeUndefined();
    expect(status.needsReconnect).toBe(false);
    expect(t.google.revoked).toEqual([]);
    expect((await t.service.verify()).warning).toBeNull();
  });

  test("opening Settings re-checks a grant marked lost, and clears a mistaken loss", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.service.markLost("a 403 that was not about the sign-in");
    await t.service.checkIfDue(0);
    expect((await t.service.status()).grant?.lostAt).toBeUndefined();
  });

  test("a token that works again clears the loss", async () => {
    const t = setup();
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    await t.service.markLost("a transient 401 that looked like one");
    await t.service.verify();
    expect((await t.service.status()).grant?.lostAt).toBeUndefined();
  });

  test("opening Settings checks with Google at most every few minutes", async () => {
    let now = 1_000_000;
    const t = setup();
    // A service with a controllable clock over the same files and fake Google.
    const service = new GoogleService({
      io: t.io,
      fetch: t.google.fetch,
      redirectUri: "https://ui.example/api/google/oauth/callback",
      syncMcpEntry: async () => {},
      log: () => {},
      now: () => now,
    });
    await service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    const state = t.google.ask(await service.startConnect());
    await service.finishConnect({ state, code: "c" });

    await service.checkIfDue(60_000);
    t.google.dead.add("refresh-1");
    now += 30_000;
    await service.checkIfDue(60_000); // too soon: not asked
    expect((await service.status()).grant?.lostAt).toBeUndefined();
    now += 31_000;
    await service.checkIfDue(60_000);
    expect((await service.status()).grant?.lostAt).toBeString();
  });
});

describe("where the Google client comes from", () => {
  const ENVED = { clientId: "env-id.apps.googleusercontent.com", clientSecret: "env-secret" };

  function withEnvClient(env?: { clientId: string; clientSecret: string }) {
    const mem = memoryIo();
    const google = fakeGoogle();
    const service = new GoogleService({
      io: mem.io,
      fetch: google.fetch,
      redirectUri: "https://ui.example/api/google/oauth/callback",
      syncMcpEntry: async () => {},
      envClient: env,
      log: () => {},
    });
    return {
      service,
      google,
      connect: async () => {
        const state = google.ask(await service.startConnect());
        return service.finishConnect({ state, code: "c" });
      },
      /** What the settings file holds, as opposed to what takes effect. */
      stored: () =>
        JSON.parse(mem.policy.get(GOOGLE_SETTINGS_FILE) ?? "{}") as {
          clientId: string;
          clientSecret: string | null;
        },
      sidecar: () => JSON.parse(mem.policy.get(GOOGLE_SIDECAR_FILE) ?? "{}") as SidecarConfig,
      credential: () =>
        JSON.parse([...mem.creds.values()][0] ?? "{}") as {
          client_id: string;
          client_secret: string;
        },
    };
  }

  async function connected(env?: { clientId: string; clientSecret: string }) {
    const t = withEnvClient(env);
    await t.service.save({ ...CLIENT, enabled: true, permissions: POLICY });
    await t.connect();
    return t;
  }

  test("the environment pair is the live one", async () => {
    const t = await connected(ENVED);
    expect((await t.service.status()).clientId).toBe(ENVED.clientId);
    expect((await t.service.status()).clientSource).toBe("env");
    // The sidecar and the stored token both run the client that issued the
    // consent — either mismatch and every refresh fails.
    expect(t.sidecar().clientId).toBe(ENVED.clientId);
    expect(t.sidecar().clientSecret).toBe(ENVED.clientSecret);
    expect(t.credential().client_id).toBe(ENVED.clientId);
  });

  test("the file keeps the pair it held, so dropping the variables falls back", async () => {
    const t = await connected(ENVED);
    // Writing env's secret into the file would replace the fallback with the
    // thing it is the fallback for, and outlive the variables being removed.
    expect(t.stored().clientId).toBe(CLIENT.clientId);
    expect(t.stored().clientSecret).toBe(CLIENT.clientSecret);
  });

  test("without the variables the stored pair is the live one", async () => {
    const t = await connected(undefined);
    expect((await t.service.status()).clientSource).toBe("stored");
    expect(t.sidecar().clientId).toBe(CLIENT.clientId);
    expect(t.credential().client_id).toBe(CLIENT.clientId);
  });

  test("editing the stored client while env provides one keeps the grant", async () => {
    const t = await connected(ENVED);
    const before = (await t.service.status()).grant?.email;
    // The typed pair is not the live one, so nothing about the token changed and
    // nothing should have been revoked — the warning used to claim it had.
    const { warning } = await t.service.save({
      clientId: "typed-again.apps.googleusercontent.com",
    });
    expect(warning).toBeNull();
    expect(t.google.revoked).toEqual([]);
    expect((await t.service.status()).grant?.email).toBe(before);
  });

  test("rotating the env pair out of band is not a client change anyone sees", async () => {
    // Honest about the one case this design cannot detect: a rotated env pair is
    // invisible to a save, because both sides of the comparison resolve to it.
    // The token simply stops refreshing, and `verify()` marks it lost then — the
    // same path Google's own out-of-band revoke takes (see "verify marks a token
    // Google refuses as lost"), so nothing extra is worth storing for it.
    const t = await connected(ENVED);
    expect((await t.service.verify()).warning).toBeNull();
  });

  test("a half-set pair is not a client", async () => {
    const t = await connected({ clientId: ENVED.clientId, clientSecret: "" });
    expect((await t.service.status()).clientSource).toBe("stored");
    expect(t.sidecar().clientId).toBe(CLIENT.clientId);
  });
});
