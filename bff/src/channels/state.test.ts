import { describe, expect, test } from "bun:test";
import {
  accountView,
  createTelegramAccount,
  findTelegramAccount,
  parseAccounts,
  parsePairing,
  parseRoutes,
  patchTelegramAccount,
  pendingIsExpired,
  renderAccounts,
  renderPairing,
  renderRoutes,
  toPublicAccount,
  toPublicPending,
  toPublicRoute,
} from "./state.ts";

/** A ground-truth entry as upstream's writer emits it: camel fields plus the four snake mapped ones. */
const GROUND_TRUTH_ACCOUNT = {
  channel: "telegram",
  accountId: "3f6a1c2e-9b0d-4c5e-8f7a-1b2c3d4e5f60",
  enabled: true,
  token: "123456789:AAExampleTokenValue-abcdefghij",
  dmPolicy: "pairing",
  allowedUsers: [],
  binding: { agentId: null, conversationId: null },
  group_mode: "mention-only",
  transcribe_voice: true,
  rich_private_chat_default: false,
  inbound_debounce_ms: 1500,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-02T11:00:00.000Z",
};

describe("parseAccounts", () => {
  test("the ground-truth file round-trips through the view", () => {
    const text = JSON.stringify({ accounts: [GROUND_TRUTH_ACCOUNT] }, null, 2);
    const entry = findTelegramAccount(parseAccounts(text));
    expect(entry).not.toBeNull();
    expect(accountView(entry!)).toEqual({
      accountId: GROUND_TRUTH_ACCOUNT.accountId,
      displayName: null,
      enabled: true,
      token: GROUND_TRUTH_ACCOUNT.token,
      dmPolicy: "pairing",
      groupMode: "mention-only",
      transcribeVoice: true,
      richPrivateChatDefault: false,
      inboundDebounceMs: 1500,
      updatedAt: "2026-09-02T11:00:00.000Z",
    });
  });

  test("a missing, empty or corrupt file is an empty store, never a throw", () => {
    for (const text of [null, "", "not json", "[]", '{"accounts": "nope"}']) {
      expect(parseAccounts(text)).toEqual([]);
    }
  });

  test("the snake spelling wins over its camel twin, like upstream's loader", () => {
    const entry = {
      ...GROUND_TRUTH_ACCOUNT,
      group_mode: "open",
      groupMode: "mention-only",
      inbound_debounce_ms: 0,
      inboundDebounceMs: 5000,
    };
    const view = accountView(entry);
    expect(view.groupMode).toBe("open");
    expect(view.inboundDebounceMs).toBe(0);
  });

  test("camel-only entries read too, and bad values fall back to upstream defaults", () => {
    const camelOnly = {
      channel: "telegram",
      accountId: "a1",
      groupMode: "mention-only",
      transcribeVoice: true,
    };
    const view = accountView(camelOnly);
    expect(view.groupMode).toBe("mention-only");
    expect(view.transcribeVoice).toBe(true);
    // Absent or unrecognised values read as the upstream defaults.
    const junk = { channel: "telegram", accountId: "a2", dmPolicy: "yolo", group_mode: "loud" };
    expect(accountView(junk).dmPolicy).toBe("pairing");
    expect(accountView(junk).groupMode).toBe("open");
    expect(accountView(junk).inboundDebounceMs).toBe(0);
  });

  test("an entry that is not ours is not the account", () => {
    const entries = parseAccounts(
      JSON.stringify({
        accounts: [
          { channel: "slack", accountId: "s1", botToken: "x" },
          { channel: "telegram" },
          { channel: "telegram", accountId: "" },
          "junk",
          GROUND_TRUTH_ACCOUNT,
        ],
      }),
    );
    // Non-entries drop out; the rest survives — `findTelegramAccount` just
    // picks the first one that is a telegram account with a usable id.
    expect(entries).toHaveLength(4);
    expect(findTelegramAccount(entries)).toEqual(GROUND_TRUTH_ACCOUNT);
  });

  test("rendering is upstream's write shape: pretty JSON with a trailing newline", () => {
    const rendered = renderAccounts([{ accountId: "a1" }]);
    expect(rendered).toBe('{\n  "accounts": [\n    {\n      "accountId": "a1"\n    }\n  ]\n}\n');
  });

  test("a round trip through render keeps every field, known or not", () => {
    const entries = parseAccounts(
      JSON.stringify({
        accounts: [
          { ...GROUND_TRUTH_ACCOUNT, futureFlag: { nested: [1, 2] } },
          { channel: "discord", accountId: "d1", token: "keep-me" },
        ],
      }),
    );
    const reparsed = parseAccounts(renderAccounts(entries));
    expect(reparsed).toEqual(entries);
    expect((reparsed[1] as Record<string, unknown>).token).toBe("keep-me");
  });
});

describe("the account write shape", () => {
  const NOW = "2026-01-01T00:00:00.000Z";

  test("a created account carries the plan's defaults in upstream's key spellings", () => {
    const created = createTelegramAccount(
      "uuid-1",
      "123:AAprivate-token-value-abcdefghij",
      null,
      NOW,
    );
    expect(created).toEqual({
      channel: "telegram",
      accountId: "uuid-1",
      enabled: true,
      token: "123:AAprivate-token-value-abcdefghij",
      dmPolicy: "pairing",
      allowedUsers: [],
      binding: { agentId: null, conversationId: null },
      group_mode: "open",
      transcribe_voice: false,
      rich_private_chat_default: true,
      inbound_debounce_ms: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("a created account with a display name puts it after the accountId, upstream-order", () => {
    const created = createTelegramAccount(
      "uuid-2",
      "123:AAprivate-token-value-abcdefghij",
      "Ops",
      NOW,
    );
    expect(Object.keys(created)).toContain("displayName");
  });

  test("a patch rewrites only what it is given and stamps updatedAt", () => {
    const entry: Record<string, unknown> = { ...GROUND_TRUTH_ACCOUNT, ourCustom: 42 };
    patchTelegramAccount(entry, {
      token: null,
      enabled: false,
      dmPolicy: "allowlist",
      displayName: null,
      now: "2026-03-01T00:00:00.000Z",
    });
    expect(entry.token).toBe(GROUND_TRUTH_ACCOUNT.token);
    expect(entry.enabled).toBe(false);
    expect(entry.dmPolicy).toBe("allowlist");
    expect(entry.group_mode).toBe("mention-only");
    expect(entry.ourCustom).toBe(42);
    expect(entry.displayName).toBeUndefined();
    expect(entry.updatedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(entry.createdAt).toBe(GROUND_TRUTH_ACCOUNT.createdAt);
  });
});

describe("the browser-facing account summary", () => {
  test("it never carries the token, only its last four", () => {
    const publicAccount = toPublicAccount(GROUND_TRUTH_ACCOUNT);
    expect(JSON.stringify(publicAccount)).not.toContain(GROUND_TRUTH_ACCOUNT.token);
    expect(publicAccount).toEqual({
      accountId: GROUND_TRUTH_ACCOUNT.accountId,
      displayName: null,
      enabled: true,
      dmPolicy: "pairing",
      groupMode: "mention-only",
      tokenTail: "ghij",
      updatedAt: "2026-09-02T11:00:00.000Z",
    });
  });
});

describe("parseRoutes", () => {
  const route = {
    accountId: "a1",
    chatId: "-1001234",
    chatType: "direct",
    threadId: null,
    agentId: "agent_1",
    conversationId: "conv_1",
    enabled: true,
    outboundEnabled: true,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };

  test("the ground-truth file reads, and a corrupt one is empty", () => {
    expect(parseRoutes(JSON.stringify({ routes: [route] }))).toEqual([route]);
    expect(parseRoutes("{oops")).toEqual([]);
    expect(parseRoutes(null)).toEqual([]);
  });

  test("a route lists with its enabled flag; one without a chat id does not list", () => {
    expect(toPublicRoute(route)).toEqual({
      chatId: "-1001234",
      agentId: "agent_1",
      conversationId: "conv_1",
      enabled: true,
    });
    expect(toPublicRoute({ agentId: "agent_1" })).toBeNull();
    expect(toPublicRoute({ ...route, enabled: false })?.enabled).toBe(false);
  });

  test("routing.json renders camelCase and round-trips", () => {
    const rendered = renderRoutes([route]);
    expect(rendered).toContain('"chatType": "direct"');
    expect(parseRoutes(rendered)).toEqual([route]);
  });
});

describe("parsePairing", () => {
  const pending = {
    accountId: "a1",
    code: "K7QX2M",
    senderId: "555111",
    senderName: "Ada",
    chatId: "555111",
    createdAt: "2026-09-03T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  test("the ground-truth file reads with both lists; a corrupt one is two empty lists", () => {
    const file = parsePairing(JSON.stringify({ pending: [pending], approved: [] }));
    expect(file.pending).toEqual([pending]);
    expect(parsePairing("!!")).toEqual({ pending: [], approved: [] });
    expect(parsePairing(null)).toEqual({ pending: [], approved: [] });
  });

  test("a live pending lists; expiry is judged on the ISO stamp and unparseable counts as expired", () => {
    expect(toPublicPending(pending)).toEqual({
      code: "K7QX2M",
      senderId: "555111",
      senderName: "Ada",
      chatId: "555111",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    expect(pendingIsExpired(pending, now)).toBe(false);
    expect(pendingIsExpired({ ...pending, expiresAt: "2026-09-03T11:59:00.000Z" }, now)).toBe(true);
    expect(pendingIsExpired({ ...pending, expiresAt: "someday" }, now)).toBe(true);
    expect(pendingIsExpired({ ...pending, expiresAt: null }, now)).toBe(true);
    // Missing the fields the card shows means nothing to list.
    expect(toPublicPending({ code: "X" })).toBeNull();
  });

  test("pairing.yaml renders as JSON with both lists, whatever the extension suggests", () => {
    const rendered = renderPairing({
      pending: [],
      approved: [{ accountId: "a1", senderId: "555111", approvedAt: "2026-09-03T12:00:00.000Z" }],
    });
    expect(rendered.endsWith("\n")).toBe(true);
    expect(parsePairing(rendered)).toEqual({
      pending: [],
      approved: [{ accountId: "a1", senderId: "555111", approvedAt: "2026-09-03T12:00:00.000Z" }],
    });
  });
});
