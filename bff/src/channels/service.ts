/**
 * Settings → Telegram: the operations the section performs, over whatever file
 * access the caller provides — in the BFF, `read_file` / `write_file` on the
 * one permanent upstream connection (the same `codexIo`), because the state
 * files are `/root/.letta` files the browser cannot reach. Kept apart from
 * `routes.ts` so each is testable alone; the on-disk shapes live in `state.ts`.
 *
 * Every write is a read-merge-write of the whole file: the gateway also
 * writes `pairing.yaml` (a stranger messaging the bot creates a pending), so
 * the merge window is real but tiny and last-writer-wins inside each process;
 * the worst case is a lost pairing code, which the sender regenerates by
 * messaging again.
 */

import { randomUUID } from "node:crypto";
import {
  accountView,
  createTelegramAccount,
  DM_POLICIES,
  findTelegramAccount,
  LEGACY_MIGRATED_ACCOUNT_ID,
  patchTelegramAccount,
  pendingIsExpired,
  presentButUnparseable,
  type RawEntry,
  readChannelFiles,
  renderAccounts,
  renderPairing,
  renderRoutes,
  TELEGRAM_ACCOUNTS_PATH,
  TELEGRAM_PAIRING_PATH,
  TELEGRAM_ROUTING_PATH,
  type TelegramAccountSummary,
  type TelegramPendingSummary,
  type TelegramRouteSummary,
  toPublicAccount,
  toPublicPending,
  toPublicRoute,
} from "./state.ts";

export interface ChannelsIo {
  /** File contents, or null when the file does not exist. Throws on any other failure. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/** A body the settings screen got wrong (missing token on create, bad token shape…). */
export class InvalidTelegramRequestError extends Error {}
/** A pairing code that is not pending (unknown, already consumed, or expired). */
export class TelegramPairingNotFoundError extends Error {}
/**
 * A state file is present but corrupt. Reading leniently is fine (empty
 * store); overwriting a torn file with a rebuilt one would destroy a stored
 * account, so every write path refuses first — the operator repairs by hand.
 */
export class TelegramStateCorruptError extends Error {}

/** Telegram bot tokens are `<bot id>:<secret>`; everything else is a paste error. */
const BOT_TOKEN_PATTERN = /^\d{4,}:[A-Za-z0-9_-]{20,}$/;

export interface TelegramStatus {
  configured: boolean;
  account: TelegramAccountSummary | null;
  routes: TelegramRouteSummary[];
  pending: TelegramPendingSummary[];
}

/** What the settings screen shows. Expired pendings are not listed. */
export async function loadTelegramStatus(
  io: ChannelsIo,
  nowMs = Date.now(),
): Promise<TelegramStatus> {
  const { accounts, routes, pairing } = await readChannelFiles(io);
  const account = findTelegramAccount(accounts);
  return {
    configured: account !== null,
    account: account ? toPublicAccount(account) : null,
    routes: routes
      .map(toPublicRoute)
      .filter((route): route is TelegramRouteSummary => route !== null),
    pending: pairing.pending
      .filter((entry) => !pendingIsExpired(entry, nowMs))
      .map(toPublicPending)
      .filter((pending): pending is TelegramPendingSummary => pending !== null),
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Upstream mints codes uppercase and compares case-sensitively; inputs are uppercased. */
function upper(text: string | null): string | null {
  return text ? text.toUpperCase() : null;
}

function entryAccountId(entry: RawEntry): string {
  return textOrNull(entry.accountId) ?? LEGACY_MIGRATED_ACCOUNT_ID;
}

function assertParseable(what: string, text: string | null): void {
  if (presentButUnparseable(text)) {
    throw new TelegramStateCorruptError(
      `${what} exists but is not valid JSON — refusing to overwrite it; repair or remove it by hand (\`letta channels status\` inside the gateway container reads the rest).`,
    );
  }
}

/**
 * Create-or-update the one telegram account. First save creates the uuid
 * account upstream's wizard would have made (token required then); later
 * saves clone-and-patch it, so unknown fields, other array entries and the
 * stored token all survive an omitted field. Returns the browser-facing
 * summary — the token is written, never echoed.
 */
export async function saveTelegramAccount(
  io: ChannelsIo,
  body: unknown,
  nowMs = Date.now(),
): Promise<TelegramAccountSummary> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidTelegramRequestError("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  if ("token" in input && input.token !== null && input.token !== "") {
    if (typeof input.token !== "string" || !BOT_TOKEN_PATTERN.test(input.token.trim())) {
      throw new InvalidTelegramRequestError(
        "Bot token must look like <digits>:<secret>, as @BotFather issues it",
      );
    }
  }
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    throw new InvalidTelegramRequestError("enabled must be true or false");
  }
  if (
    "dmPolicy" in input &&
    !(DM_POLICIES as readonly string[]).includes(input.dmPolicy as string)
  ) {
    throw new InvalidTelegramRequestError(`dmPolicy must be one of: ${DM_POLICIES.join(", ")}`);
  }
  if (
    "displayName" in input &&
    input.displayName !== null &&
    typeof input.displayName !== "string"
  ) {
    throw new InvalidTelegramRequestError("displayName must be text");
  }

  const { accounts, raw } = await readChannelFiles(io);
  assertParseable("accounts.json", raw.accounts);
  const existing = findTelegramAccount(accounts);
  const storedToken = existing ? accountView(existing).token : null;
  // Write-only field: present-and-nonempty replaces, absent or empty keeps
  // whatever is stored — same contract as the Codex `apiKey`.
  const token = textOrNull(input.token) ?? storedToken;
  if (!existing && !token) {
    throw new InvalidTelegramRequestError("A bot token is required to configure Telegram");
  }
  const now = new Date(nowMs).toISOString();
  const displayName = textOrNull(input.displayName);
  // A fresh account starts enabled; a stored one keeps its switch unless the
  // body says otherwise.
  const enabled =
    "enabled" in input ? (input.enabled as boolean) : existing ? existing.enabled === true : true;
  const dmPolicy =
    "dmPolicy" in input ? (input.dmPolicy as TelegramAccountSummary["dmPolicy"]) : null;

  if (!existing) {
    const created = createTelegramAccount(randomUUID(), token as string, displayName, now);
    if (dmPolicy !== null) created.dmPolicy = dmPolicy;
    accounts.push(created);
    await io.write(TELEGRAM_ACCOUNTS_PATH, renderAccounts(accounts));
    return toPublicAccount(created);
  }

  patchTelegramAccount(existing, {
    token: textOrNull(input.token),
    enabled,
    // `dmPolicy` in the body was validated above; absent keeps the stored one.
    dmPolicy: dmPolicy ?? accountView(existing).dmPolicy,
    displayName,
    now,
  });
  await io.write(TELEGRAM_ACCOUNTS_PATH, renderAccounts(accounts));
  return toPublicAccount(existing);
}

/**
 * Approve a pairing, mirroring upstream's `completePairing`: consume the
 * pending entry (append the approved user) *and* add-or-replace the route for
 * its chat, both of which the gateway re-reads live — no restart needed.
 */
export async function approvePairing(
  io: ChannelsIo,
  body: unknown,
  nowMs = Date.now(),
): Promise<{ route: TelegramRouteSummary }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidTelegramRequestError("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  const code = textOrNull(input.code);
  const agentId = textOrNull(input.agentId);
  const conversationId = textOrNull(input.conversationId);
  if (!code || !agentId || !conversationId) {
    throw new InvalidTelegramRequestError("code, agentId and conversationId are required");
  }

  const { routes, pairing, raw } = await readChannelFiles(io);
  assertParseable("pairing.yaml", raw.pairing);
  assertParseable("routing.json", raw.routing);
  const now = new Date(nowMs).toISOString();
  const wanted = upper(code);
  const pendingIndex = pairing.pending.findIndex(
    (entry) => upper(textOrNull(entry.code)) === wanted,
  );
  if (pendingIndex < 0) throw new TelegramPairingNotFoundError("No such pending pairing");
  const pending = pairing.pending[pendingIndex] as RawEntry;
  if (pendingIsExpired(pending, nowMs)) {
    throw new TelegramPairingNotFoundError("This pairing code has expired");
  }
  const chatId = textOrNull(pending.chatId);
  const senderId = textOrNull(pending.senderId);
  if (!chatId || !senderId) {
    throw new TelegramPairingNotFoundError("This pairing entry has no chat or sender to route");
  }
  const accountId = textOrNull(pending.accountId) ?? LEGACY_MIGRATED_ACCOUNT_ID;

  pairing.pending.splice(pendingIndex, 1);
  // Upstream's `consumePairingCode` skips a duplicate (accountId, senderId);
  // a sender re-pairing after a TTL must not leave a second row.
  if (
    !pairing.approved.some(
      (entry) => entryAccountId(entry) === accountId && textOrNull(entry.senderId) === senderId,
    )
  ) {
    pairing.approved.push({
      accountId,
      senderId,
      ...(typeof pending.senderName === "string" ? { senderName: pending.senderName } : {}),
      approvedAt: now,
    });
  }

  // Upstream keys routes by (accountId, chatId): a stale row from another
  // account must keep standing (upstream would have added a second row), and
  // the row we re-point is the one the gateway resolves for THIS account.
  let route = routes.find(
    (entry) => entry.chatId === chatId && entryAccountId(entry) === accountId,
  );
  if (route) {
    // Re-route: keep whatever else the row carried (its own `enabled`,
    // `createdAt`, …) and move only where messages go.
    route.agentId = agentId;
    route.conversationId = conversationId;
    route.updatedAt = now;
  } else {
    route = {
      accountId,
      chatId,
      chatType: "direct",
      threadId: null,
      agentId,
      conversationId,
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    };
    routes.push(route);
  }

  // pairing first: an approved user with no route yet is harmless for one
  // inbound message, while a route with no approved user would answer a
  // stranger whose pending entry still stands.
  await io.write(TELEGRAM_PAIRING_PATH, renderPairing(pairing));
  await io.write(TELEGRAM_ROUTING_PATH, renderRoutes(routes));

  const shown = toPublicRoute(route);
  if (!shown) throw new Error("route without a chat id cannot be listed");
  return { route: shown };
}

export interface PairingBindingNames {
  agent: string | null;
  conversation: string | null;
}

/**
 * The notice is one short line, and it names what the chat just connected to
 * — “who am I talking to” is the whole question a paired user has. Names
 * that could not be resolved fall back to the generic line: a plain notice
 * beats no notice.
 */
export function pairingOutcomeText(binding: PairingBindingNames | null): string {
  const agent = binding?.agent ?? null;
  const conversation = binding?.conversation ?? null;
  if (agent && conversation) return `✅ Paired with ${agent} · ${conversation}`;
  if (agent) return `✅ Paired with ${agent}`;
  if (conversation) return `✅ Paired with ${conversation}`;
  return "✅ Pairing approved — send a message and your agent will answer.";
}

/**
 * Tell a chat its pairing was approved. Upstream never does this —
 * `bindChannelPairing` only writes the files, so the approved user finds out
 * only by speaking first. The BFF has the token and the Bot API has a verb,
 * so approving from Settings pushes the outcome to the chat that earned it.
 * Best effort in every way: it never throws — the pairing is already real on
 * disk — and a network that fails quietly just means the user learns by
 * messaging. The token is read here and sent nowhere but api.telegram.org.
 */
export async function notifyPairingApproved(
  io: ChannelsIo,
  chatId: string,
  binding: PairingBindingNames | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { accounts } = await readChannelFiles(io);
    const account = findTelegramAccount(accounts);
    const token = account ? accountView(account).token : null;
    // A disabled bot cannot speak: its account is off, and saying so silently
    // is honest — the approve itself already stood.
    if (!account || !token || account.enabled !== true) return false;
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: pairingOutcomeText(binding),
      }),
      // The pairing already stands on disk; a hanging Telegram must not hang
      // the request on top of it.
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    // Everything here is courtesy: the file read rides the one upstream
    // connection and can fail; the network can fail; Telegram can refuse. A
    // pairing written a moment ago is real whatever happens to this notice.
    return false;
  }
}

/** Ignore a pending code. False when no pending entry carried it (→ 404). */
export async function dropPending(io: ChannelsIo, code: string): Promise<boolean> {
  const { pairing, raw } = await readChannelFiles(io);
  assertParseable("pairing.yaml", raw.pairing);
  const wanted = upper(code.trim());
  const kept = pairing.pending.filter((entry) => upper(textOrNull(entry.code)) !== wanted);
  if (kept.length === pairing.pending.length) return false;
  await io.write(
    TELEGRAM_PAIRING_PATH,
    renderPairing({ pending: kept, approved: pairing.approved }),
  );
  return true;
}

/** Remove every route for a chat — the gateway re-reads routing.json per message. False → 404. */
export async function dropRoutes(io: ChannelsIo, chatId: string): Promise<boolean> {
  const { routes, raw } = await readChannelFiles(io);
  assertParseable("routing.json", raw.routing);
  const kept = routes.filter((entry) => entry.chatId !== chatId);
  if (kept.length === routes.length) return false;
  await io.write(TELEGRAM_ROUTING_PATH, renderRoutes(kept));
  return true;
}
