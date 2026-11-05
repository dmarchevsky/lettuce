/**
 * The five Telegram routes over an in-memory `/root/.letta` — the same shape
 * of test the provider routes use (a bare Hono app, no server, no upstream):
 * the io is a Map, so the assertions land on what would actually be written
 * to disk, which is exactly where the token-masking and merge contracts bite.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTelegramRoutes } from "./routes.ts";
import type { ChannelsIo } from "./service.ts";
import { TELEGRAM_ACCOUNTS_PATH, TELEGRAM_PAIRING_PATH, TELEGRAM_ROUTING_PATH } from "./state.ts";

type TestEnv = { Variables: { session?: unknown } };

const ACCOUNTS_FIXTURE = {
  accounts: [
    {
      channel: "telegram",
      accountId: "acct-1",
      enabled: true,
      token: "987654321:AAStoredSecretValue_wxyz0123",
      dmPolicy: "pairing",
      allowedUsers: [],
      binding: { agentId: null, conversationId: null },
      group_mode: "open",
      transcribe_voice: false,
      rich_private_chat_default: true,
      inbound_debounce_ms: 0,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
    // Another channel's entry: ours must never disturb it.
    { channel: "discord", accountId: "d1", token: "discord-secret" },
  ],
};

const ROUTING_FIXTURE = {
  routes: [
    {
      accountId: "acct-1",
      chatId: "555111",
      chatType: "direct",
      threadId: null,
      agentId: "agent_old",
      conversationId: "conv_old",
      enabled: true,
      outboundEnabled: true,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      accountId: "acct-1",
      chatId: "777222",
      chatType: "direct",
      threadId: null,
      agentId: "agent_a",
      conversationId: "conv_a",
      enabled: false,
      outboundEnabled: true,
      createdAt: "2026-09-01T10:00:00.000Z",
    },
  ],
};

const LIVE_PENDING = {
  accountId: "acct-1",
  code: "K7QX2M",
  senderId: "555111",
  senderName: "Ada",
  chatId: "555111",
  createdAt: "2026-09-03T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const EXPIRED_PENDING = { ...LIVE_PENDING, code: "OLDCODE", expiresAt: "2020-01-01T00:00:00.000Z" };

function setup(
  options: {
    files?: Record<string, unknown>;
    enabled?: boolean;
    ready?: boolean;
    /** The Bot API call; default throws so no test can ever reach the network. */
    send?: typeof fetch;
    bindingNames?: (
      agentId: string,
      conversationId: string,
    ) => Promise<{ agent: string | null; conversation: string | null }>;
  } = {},
) {
  const store = new Map<string, string>();
  for (const [path, value] of Object.entries(options.files ?? {})) {
    store.set(path, JSON.stringify(value, null, 2));
  }
  const io: ChannelsIo = {
    async read(path) {
      return store.get(path) ?? null;
    },
    async write(path, content) {
      store.set(path, content);
    },
  };
  const app = new Hono<TestEnv>();
  registerTelegramRoutes(app, {
    isReady: () => options.ready ?? true,
    telegramEnabled: options.enabled ?? true,
    io,
    send:
      options.send ??
      ((async () => {
        throw new Error("no network in tests");
      }) as unknown as typeof fetch),
    bindingNames: options.bindingNames,
  });
  const disk = (path: string): Record<string, unknown> | null => {
    const text = store.get(path);
    return text === undefined ? null : (JSON.parse(text) as Record<string, unknown>);
  };
  return { app, store, io, disk };
}

function send(app: Hono<TestEnv>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /api/channels/telegram", () => {
  test("an empty state dir is an unconfigured screen, not an error", async () => {
    const { app } = setup();
    const response = await send(app, "GET", "/api/channels/telegram");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      account: null,
      routes: [],
      pending: [],
    });
  });

  test("corrupt files read as the empty store", async () => {
    const { app } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: "not json at all",
        [TELEGRAM_ROUTING_PATH]: "{oops",
        [TELEGRAM_PAIRING_PATH]: "",
      },
    });
    expect(await (await send(app, "GET", "/api/channels/telegram")).json()).toEqual({
      configured: false,
      account: null,
      routes: [],
      pending: [],
    });
  });

  test("the status lists account, routes and live pendings — and never the token", async () => {
    const { app } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE,
        [TELEGRAM_ROUTING_PATH]: ROUTING_FIXTURE,
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING, EXPIRED_PENDING], approved: [] },
      },
    });
    const response = await send(app, "GET", "/api/channels/telegram");
    const json = (await response.json()) as {
      configured: boolean;
      account: Record<string, unknown>;
      routes: unknown[];
      pending: unknown[];
    };
    expect(json.configured).toBe(true);
    expect(json.account).toEqual({
      accountId: "acct-1",
      displayName: null,
      enabled: true,
      dmPolicy: "pairing",
      groupMode: "open",
      tokenTail: "0123",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(json.routes).toEqual([
      { chatId: "555111", agentId: "agent_old", conversationId: "conv_old", enabled: true },
      { chatId: "777222", agentId: "agent_a", conversationId: "conv_a", enabled: false },
    ]);
    // Only the unexpired pending is listed.
    expect(json.pending).toEqual([
      {
        code: "K7QX2M",
        senderId: "555111",
        senderName: "Ada",
        chatId: "555111",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    const text = JSON.stringify(json);
    expect(text).not.toContain("AAStoredSecretValue");
    expect(text).not.toContain("discord-secret");
  });
});

describe("PUT /api/channels/telegram/account", () => {
  test("create requires a token", async () => {
    const { app, store } = setup();
    expect((await send(app, "PUT", "/api/channels/telegram/account", {})).status).toBe(400);
    expect((await send(app, "PUT", "/api/channels/telegram/account", null)).status).toBe(400);
    expect(store.size).toBe(0);
  });

  test("a create with a valid token writes the exact on-disk shape", async () => {
    const { app, disk } = setup();
    const response = await send(app, "PUT", "/api/channels/telegram/account", {
      token: "123456789:AAExampleTokenValue-abcdefghij",
    });
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as { account: Record<string, unknown> };
    expect(account.tokenTail).toBe("ghij");
    expect(account.enabled).toBe(true);
    expect(account.dmPolicy).toBe("pairing");
    expect(account.accountId).toMatch(/^[0-9a-f-]{36}$/);
    const onDisk = disk(TELEGRAM_ACCOUNTS_PATH);
    expect(onDisk).not.toBeNull();
    const entry = (onDisk!.accounts as Record<string, unknown>[])[0]!;
    expect(entry.channel).toBe("telegram");
    expect(entry.token).toBe("123456789:AAExampleTokenValue-abcdefghij");
    expect(entry.allowedUsers).toEqual([]);
    expect(entry.binding).toEqual({ agentId: null, conversationId: null });
    // Mapped fields in snake_case, the rest in camel — upstream's write shape.
    expect(entry.group_mode).toBe("open");
    expect(entry.transcribe_voice).toBe(false);
    expect(entry.rich_private_chat_default).toBe(true);
    expect(entry.inbound_debounce_ms).toBe(0);
    expect(entry.groupMode).toBeUndefined();
    expect(entry.createdAt).toBe(entry.updatedAt);
  });

  test("a bad token shape, a non-boolean switch and a bogus policy are 400s", async () => {
    const { app, store } = setup();
    const bad = [
      { token: "not-a-bot-token" },
      { token: "12:short" },
      { token: 42 },
      { token: "123456789:AAExampleTokenValue-abcdefghij", enabled: "yes" },
      { token: "123456789:AAExampleTokenValue-abcdefghij", dmPolicy: "yolo" },
      { token: "123456789:AAExampleTokenValue-abcdefghij", displayName: 7 },
    ];
    for (const body of bad) {
      expect((await send(app, "PUT", "/api/channels/telegram/account", body)).status).toBe(400);
    }
    expect(store.size).toBe(0);
  });

  test("an update keeps the stored token, unknown fields and the other channel's entry", async () => {
    const { app, disk } = setup({ files: { [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE } });
    const response = await send(app, "PUT", "/api/channels/telegram/account", {
      enabled: false,
      dmPolicy: "open",
    });
    expect(response.status).toBe(200);
    const accounts = disk(TELEGRAM_ACCOUNTS_PATH)!.accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toEqual(ACCOUNTS_FIXTURE.accounts[1]);
    const telegram = accounts[0]!;
    expect(telegram.token).toBe(ACCOUNTS_FIXTURE.accounts[0]!.token);
    expect(telegram.enabled).toBe(false);
    expect(telegram.dmPolicy).toBe("open");
    expect(telegram.group_mode).toBe("open");
    expect(telegram.updatedAt).not.toBe("2026-09-01T10:00:00.000Z");
    expect(telegram.createdAt).toBe("2026-09-01T10:00:00.000Z");
    // The response masks the token exactly like the status route.
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("AAStoredSecretValue");
    expect(body).toContain('"tokenTail":"0123"');
  });

  test("a resend of the same token is accepted and changes nothing secret", async () => {
    const { app, disk } = setup({ files: { [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE } });
    const response = await send(app, "PUT", "/api/channels/telegram/account", {
      token: ACCOUNTS_FIXTURE.accounts[0]!.token,
    });
    expect(response.status).toBe(200);
    const accounts = disk(TELEGRAM_ACCOUNTS_PATH)!.accounts as Record<string, unknown>[];
    expect(accounts[0]!.token).toBe(ACCOUNTS_FIXTURE.accounts[0]!.token);
  });
});

describe("POST /api/channels/telegram/pairings/approve", () => {
  const approve = (app: Hono<TestEnv>, body: unknown) =>
    send(app, "POST", "/api/channels/telegram/pairings/approve", body);

  test("a lowercase code approves the pending entry upstream minted uppercase", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: {
          pending: [
            { code: "AB12CD", senderId: "9", chatId: "11", expiresAt: "2099-01-01T00:00:00.000Z" },
          ],
          approved: [],
        },
      },
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "ab12cd",
      agentId: "a1",
      conversationId: "c1",
    });
    expect(response.status).toBe(200);
    expect(disk(TELEGRAM_PAIRING_PATH)).toEqual({
      pending: [],
      approved: [
        { accountId: "__legacy_migrated__", senderId: "9", approvedAt: expect.any(String) },
      ],
    });
  });

  test("re-approving a sender leaves one approved row — upstream skips the duplicate", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: {
          pending: [
            { code: "AB12CD", senderId: "9", chatId: "11", expiresAt: "2099-01-01T00:00:00.000Z" },
          ],
          approved: [{ accountId: "__legacy_migrated__", senderId: "9", approvedAt: "earlier" }],
        },
        [TELEGRAM_ROUTING_PATH]: { routes: [] },
      },
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "AB12CD",
      agentId: "a1",
      conversationId: "c1",
    });
    expect(response.status).toBe(200);
    const approved = disk(TELEGRAM_PAIRING_PATH)!["approved"] as Record<string, unknown>[];
    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvedAt).toBe("earlier");
  });

  test("a stale route from another account keeps standing; approval adds the row THIS account resolves", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: {
          pending: [
            {
              code: "AB12CD",
              senderId: "9",
              chatId: "11",
              accountId: "acct-2",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ],
          approved: [],
        },
        [TELEGRAM_ROUTING_PATH]: {
          routes: [
            {
              accountId: "acct-1",
              chatId: "11",
              agentId: "old-agent",
              conversationId: "old-conv",
              enabled: true,
            },
          ],
        },
      },
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "AB12CD",
      agentId: "a1",
      conversationId: "c1",
    });
    expect(response.status).toBe(200);
    const routes = disk(TELEGRAM_ROUTING_PATH)!.routes as Record<string, unknown>[];
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ accountId: "acct-1", agentId: "old-agent" });
    expect(routes[1]).toMatchObject({
      accountId: "acct-2",
      chatId: "11",
      agentId: "a1",
      conversationId: "c1",
    });
  });

  test("a present-but-corrupt accounts.json is refused, never written over", async () => {
    const { app, store } = setup();
    store.set(TELEGRAM_ACCOUNTS_PATH, '{ "accounts": [\n  broken');
    const response = await send(app, "PUT", "/api/channels/telegram/account", {
      token: "987654321:AAStoredSecretValue_wxyz0123",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/not valid JSON/);
    expect(store.get(TELEGRAM_ACCOUNTS_PATH)).toBe('{ "accounts": [\n  broken');
  });

  test("it consumes the pending, appends the approved user, and adds the route", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE,
        [TELEGRAM_ROUTING_PATH]: { routes: [] },
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] },
      },
    });
    const response = await approve(app, {
      code: "K7QX2M",
      agentId: "agent_home",
      conversationId: "conv_home",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      route: {
        chatId: "555111",
        agentId: "agent_home",
        conversationId: "conv_home",
        enabled: true,
      },
      // The setup stub cannot reach the Bot API, and saying so is the point.
      notified: false,
    });
    const pairing = disk(TELEGRAM_PAIRING_PATH)! as {
      pending: unknown[];
      approved: Record<string, unknown>[];
    };
    expect(pairing.pending).toEqual([]);
    expect(pairing.approved[0]).toMatchObject({
      accountId: "acct-1",
      senderId: "555111",
      senderName: "Ada",
    });
    expect(typeof pairing.approved[0]!.approvedAt).toBe("string");
    const routes = (disk(TELEGRAM_ROUTING_PATH)! as { routes: Record<string, unknown>[] }).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      accountId: "acct-1",
      chatId: "555111",
      chatType: "direct",
      threadId: null,
      agentId: "agent_home",
      conversationId: "conv_home",
      enabled: true,
      outboundEnabled: true,
    });
    expect(routes[0]!.createdAt).toBe(routes[0]!.updatedAt);
  });

  test("a pending without an accountId routes to the legacy-migrated account", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: {
          pending: [{ ...LIVE_PENDING, accountId: undefined }],
          approved: [],
        },
      },
    });
    expect((await approve(app, { code: "K7QX2M", agentId: "a", conversationId: "c" })).status).toBe(
      200,
    );
    const routes = (disk(TELEGRAM_ROUTING_PATH)! as { routes: Record<string, unknown>[] }).routes;
    expect(routes[0]!.accountId).toBe("__legacy_migrated__");
  });

  test("an existing route for the chat is re-pointed, not duplicated, and keeps its own fields", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_ROUTING_PATH]: ROUTING_FIXTURE,
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] },
      },
    });
    expect(
      (await approve(app, { code: "K7QX2M", agentId: "a2", conversationId: "c2" })).status,
    ).toBe(200);
    const routing = (disk(TELEGRAM_ROUTING_PATH)! as { routes: Record<string, unknown>[] }).routes;
    expect(routing).toHaveLength(2);
    const reRouted = routing.find((r) => r.chatId === "555111")!;
    expect(reRouted.agentId).toBe("a2");
    expect(reRouted.conversationId).toBe("c2");
    expect(reRouted.createdAt).toBe("2026-09-01T10:00:00.000Z");
  });

  test("approve tells the chat through the Bot API — and says whether it landed", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const { app } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE,
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] },
        [TELEGRAM_ROUTING_PATH]: { routes: [] },
      },
      send: (async (url: unknown, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "K7QX2M",
      agentId: "a1",
      conversationId: "c1",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { notified: boolean }).notified).toBe(true);
    expect(calls).toHaveLength(1);
    // The stored token rides to api.telegram.org and to the response body:
    // the payload is chat + text, nothing else.
    expect(calls[0]!.url).toContain("api.telegram.org");
    expect(calls[0]!.body.chat_id).toBe("555111");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("AAStoredSecretValue");
  });

  test("the notice names the agent and conversation it could resolve", async () => {
    let text = "";
    const { app } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE,
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] },
        [TELEGRAM_ROUTING_PATH]: { routes: [] },
      },
      bindingNames: async () => ({ agent: "Memo", conversation: "Daily log" }),
      send: (async (_url: unknown, init: { body: string }) => {
        text = (JSON.parse(init.body) as { text: string }).text;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "K7QX2M",
      agentId: "agent_home",
      conversationId: "conv_home",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { notified: boolean }).notified).toBe(true);
    expect(text).toBe("✅ Paired with Memo · Daily log");
  });

  test("an approve still stands when the notice cannot be delivered", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE,
        [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] },
        [TELEGRAM_ROUTING_PATH]: { routes: [] },
      },
      send: (async () => {
        throw new Error("telegram unreachable");
      }) as unknown as typeof fetch,
    });
    const response = await send(app, "POST", "/api/channels/telegram/pairings/approve", {
      code: "K7QX2M",
      agentId: "a1",
      conversationId: "c1",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { notified: boolean }).notified).toBe(false);
    // The pairing itself moved on disk regardless of the notice.
    expect(disk(TELEGRAM_PAIRING_PATH)!.pending).toEqual([]);
    expect(disk(TELEGRAM_ROUTING_PATH)!.routes).toHaveLength(1);
  });

  test("an unknown or expired code is a 404; a missing field is a 400; nothing moves", async () => {
    const { app, store } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: { pending: [EXPIRED_PENDING], approved: [] },
      },
    });
    expect((await approve(app, { code: "NOPE", agentId: "a", conversationId: "c" })).status).toBe(
      404,
    );
    expect(
      (await approve(app, { code: "OLDCODE", agentId: "a", conversationId: "c" })).status,
    ).toBe(404);
    expect((await approve(app, { code: "OLDCODE" })).status).toBe(400);
    expect(store.get(TELEGRAM_PAIRING_PATH)).toContain("OLDCODE");
    expect(store.has(TELEGRAM_ROUTING_PATH)).toBe(false);
  });
});

describe("DELETE /api/channels/telegram/pairings", () => {
  test("a known code is dropped from pending; the approved list survives", async () => {
    const { app, disk } = setup({
      files: {
        [TELEGRAM_PAIRING_PATH]: {
          pending: [LIVE_PENDING, EXPIRED_PENDING],
          approved: [{ accountId: "acct-1", senderId: "1", approvedAt: "x" }],
        },
      },
    });
    const response = await send(app, "DELETE", "/api/channels/telegram/pairings?code=K7QX2M");
    expect(response.status).toBe(200);
    const pairing = disk(TELEGRAM_PAIRING_PATH)! as { pending: { code: string }[] };
    expect(pairing.pending.map((p) => p.code)).toEqual(["OLDCODE"]);
  });

  test("an unknown code is 404, a missing code is 400", async () => {
    const { app, store } = setup({
      files: { [TELEGRAM_PAIRING_PATH]: { pending: [LIVE_PENDING], approved: [] } },
    });
    expect((await send(app, "DELETE", "/api/channels/telegram/pairings?code=ZZZ")).status).toBe(
      404,
    );
    expect((await send(app, "DELETE", "/api/channels/telegram/pairings")).status).toBe(400);
    expect(store.get(TELEGRAM_PAIRING_PATH)).toContain("K7QX2M");
  });
});

describe("DELETE /api/channels/telegram/routes", () => {
  test("every row for the chat goes, the others stay", async () => {
    const { app, disk } = setup({ files: { [TELEGRAM_ROUTING_PATH]: ROUTING_FIXTURE } });
    const response = await send(app, "DELETE", "/api/channels/telegram/routes?chatId=555111");
    expect(response.status).toBe(200);
    const routes = (disk(TELEGRAM_ROUTING_PATH)! as { routes: Record<string, unknown>[] }).routes;
    expect(routes.map((r) => r.chatId)).toEqual(["777222"]);
  });

  test("an unknown chat is 404, a missing chatId is 400", async () => {
    const { app, store } = setup({ files: { [TELEGRAM_ROUTING_PATH]: ROUTING_FIXTURE } });
    expect((await send(app, "DELETE", "/api/channels/telegram/routes?chatId=999")).status).toBe(
      404,
    );
    expect((await send(app, "DELETE", "/api/channels/telegram/routes")).status).toBe(400);
    expect(store.get(TELEGRAM_ROUTING_PATH)).toContain("555111");
  });
});

describe("the feature token and the upstream connection gate every route", () => {
  const calls: [string, string][] = [
    ["GET", "/api/channels/telegram"],
    ["PUT", "/api/channels/telegram/account"],
    ["POST", "/api/channels/telegram/pairings/approve"],
    ["DELETE", "/api/channels/telegram/pairings?code=K7QX2M"],
    ["DELETE", "/api/channels/telegram/routes?chatId=555111"],
  ];

  test("404 on every route while the telegram token is off", async () => {
    const { app, store } = setup({
      enabled: false,
      files: { [TELEGRAM_ACCOUNTS_PATH]: ACCOUNTS_FIXTURE },
    });
    for (const [method, path] of calls) {
      expect((await send(app, method, path)).status, `${method} ${path}`).toBe(404);
    }
    // Gated routes must not even reach the files.
    expect(store.size).toBe(1);
  });

  test("503 on every route while the app-server is not connected", async () => {
    const { app } = setup({ ready: false });
    for (const [method, path] of calls) {
      expect((await send(app, method, path)).status, `${method} ${path}`).toBe(503);
    }
  });
});
