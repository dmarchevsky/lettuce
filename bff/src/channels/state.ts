/**
 * The on-disk shape of letta-code's Telegram channel state, and our read of it.
 *
 * The gateway keeps its state under `/root/.letta/channels/telegram/` — three
 * JSON files (yes, `pairing.yaml` is JSON despite its name), written by
 * upstream's own `upsertChannelAccount`, `addRoute`, `createPairingCode` and
 * `consumePairingCode`. The `channel_*` protocol commands are unreachable over
 * the WebSocket (the app-server dispatches them only to a stdio-attached
 * gateway), so the BFF edits these files directly, the way it edits
 * `/root/.letta/web-tools/lettuce.json`.
 *
 * These are upstream *internals*, not protocol, so parsing is as lenient as
 * web-tools: a missing or corrupt file is an empty store, never a throw. The
 * one asymmetry is that unknown entries and unknown fields are *kept* —
 * every save is a clone-and-patch of the parsed record, the way upstream's
 * wizard's `cloneAccount` patches its own. An account entry is only treated
 * as ours when it is `channel: "telegram"` with a usable `accountId`;
 * everything else survives a rewrite untouched and simply is not read.
 *
 * A telegram account carries camelCase fields *plus* snake_case for the four
 * upstream-mapped ones (`group_mode`, `transcribe_voice`,
 * `rich_private_chat_default`, `inbound_debounce_ms`): upstream canonicalizes
 * snake → camel on load, snake winning. We read the same way and write only
 * upstream's own write shape (snake for those four, camel for the rest), so a
 * stale camel twin left by some other writer can never disagree with what
 * the gateway sees.
 */

import type { ChannelsIo } from "./service.ts";

/** On the letta-home bind mount, beside codex's and web-tools' files. */
export const TELEGRAM_DIR = "/root/.letta/channels/telegram";
export const TELEGRAM_ACCOUNTS_PATH = `${TELEGRAM_DIR}/accounts.json`;
export const TELEGRAM_ROUTING_PATH = `${TELEGRAM_DIR}/routing.json`;
/** JSON despite the extension — upstream writes JSON here. */
export const TELEGRAM_PAIRING_PATH = `${TELEGRAM_DIR}/pairing.yaml`;

/** A record parsed straight off disk; the point is that no field is lost. */
export type RawEntry = Record<string, unknown>;

/** Upstream `DmPolicy` (types/channels/types.d.ts). */
export const DM_POLICIES = ["pairing", "allowlist", "open"] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];
/** Upstream `TelegramGroupMode`; the default matches upstream's. */
export const TELEGRAM_GROUP_MODES = ["open", "mention-only"] as const;

/** Pairing default (the wizard's); open chat, no voice transcription, debounce off. */
export const DEFAULT_DM_POLICY: DmPolicy = "pairing";
export const DEFAULT_GROUP_MODE = "open";
export const DEFAULT_TRANSCRIBE_VOICE = false;
export const DEFAULT_RICH_PRIVATE_CHAT = true;
export const DEFAULT_INBOUND_DEBOUNCE_MS = 0;

/** Routes with no `accountId` of their own fall back to this one upstream-side. */
export const LEGACY_MIGRATED_ACCOUNT_ID = "__legacy_migrated__";

/** What a browser may see of the account. The bot token is never among it. */
export interface TelegramAccountSummary {
  accountId: string;
  displayName: string | null;
  enabled: boolean;
  dmPolicy: DmPolicy;
  groupMode: string;
  /** Last four characters of the bot token, for display only. */
  tokenTail: string | null;
  updatedAt: string | null;
}

/** One routing row, as the settings screen lists and removes them. */
export interface TelegramRouteSummary {
  chatId: string;
  agentId: string | null;
  conversationId: string | null;
  enabled: boolean;
}

/** A pairing request waiting to be approved. Expired ones are never built. */
export interface TelegramPendingSummary {
  code: string;
  senderId: string;
  senderName: string | null;
  chatId: string;
  expiresAt: string | null;
}

function parseJsonObject(text: string | null): RawEntry | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RawEntry)
      : null;
  } catch {
    return null;
  }
}

function entryArray(value: unknown): RawEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RawEntry => !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Read one string with upstream's precedence: the snake_case key wins over
 * its camelCase twin, because that is what upstream's own canonicalization
 * (`SNAKE_TO_CAMEL`) ends up applying.
 */
function textWithSnakePriority(entry: RawEntry, snake: string, camel: string): string | null {
  return optionalText(entry[snake]) ?? optionalText(entry[camel]);
}

function boolWithSnakePriority(
  entry: RawEntry,
  snake: string,
  camel: string,
  fallback: boolean,
): boolean {
  const value = entry[snake] !== undefined ? entry[snake] : entry[camel];
  return typeof value === "boolean" ? value : fallback;
}

// ── accounts.json ───────────────────────────────────────────────────────────

/** `{"accounts":[…]}`, entries as found. Non-entries are dropped, nothing else is. */
export function parseAccounts(text: string | null): RawEntry[] {
  return entryArray(parseJsonObject(text)?.accounts);
}

export function renderAccounts(entries: RawEntry[]): string {
  return `${JSON.stringify({ accounts: entries }, null, 2)}\n`;
}

/** Our kind of entry: a telegram account with a usable id. */
export function isTelegramAccount(entry: RawEntry): entry is RawEntry & { accountId: string } {
  return entry.channel === "telegram" && typeof entry.accountId === "string" && !!entry.accountId;
}

/** The first telegram entry — v1 supports exactly one bot. */
export function findTelegramAccount(entries: RawEntry[]): RawEntry | null {
  return entries.find(isTelegramAccount) ?? null;
}

/** The whole typed view of one account entry, token included; io-side use only. */
export interface TelegramAccountView {
  accountId: string;
  displayName: string | null;
  enabled: boolean;
  token: string | null;
  dmPolicy: DmPolicy;
  groupMode: string;
  transcribeVoice: boolean;
  richPrivateChatDefault: boolean;
  inboundDebounceMs: number;
  updatedAt: string | null;
}

export function accountView(entry: RawEntry): TelegramAccountView {
  const rawPolicy = textWithSnakePriority(entry, "dm_policy", "dmPolicy");
  const rawMode = textWithSnakePriority(entry, "group_mode", "groupMode");
  const rawDebounce =
    entry.inbound_debounce_ms !== undefined ? entry.inbound_debounce_ms : entry.inboundDebounceMs;
  return {
    accountId: String(entry.accountId),
    displayName: optionalText(entry.displayName),
    enabled: entry.enabled === true,
    token: optionalText(entry.token),
    dmPolicy: (DM_POLICIES as readonly string[]).includes(rawPolicy ?? "")
      ? (rawPolicy as DmPolicy)
      : DEFAULT_DM_POLICY,
    groupMode:
      rawMode !== null && (TELEGRAM_GROUP_MODES as readonly string[]).includes(rawMode)
        ? rawMode
        : DEFAULT_GROUP_MODE,
    transcribeVoice: boolWithSnakePriority(
      entry,
      "transcribe_voice",
      "transcribeVoice",
      DEFAULT_TRANSCRIBE_VOICE,
    ),
    richPrivateChatDefault: boolWithSnakePriority(
      entry,
      "rich_private_chat_default",
      "richPrivateChatDefault",
      DEFAULT_RICH_PRIVATE_CHAT,
    ),
    inboundDebounceMs:
      typeof rawDebounce === "number" && Number.isInteger(rawDebounce) && rawDebounce >= 0
        ? rawDebounce
        : DEFAULT_INBOUND_DEBOUNCE_MS,
    updatedAt: optionalText(entry.updatedAt),
  };
}

/** The browser-facing half of a view: identity and settings, minus the token. */
export function toPublicAccount(entry: RawEntry): TelegramAccountSummary {
  const view = accountView(entry);
  return {
    accountId: view.accountId,
    displayName: view.displayName,
    enabled: view.enabled,
    dmPolicy: view.dmPolicy,
    groupMode: view.groupMode,
    tokenTail: view.token ? view.token.slice(-4) : null,
    updatedAt: view.updatedAt,
  };
}

/**
 * Apply a settings update onto an account entry without losing anything else
 * it carried. Absent fields keep their value; `token` in particular is
 * write-only, so leaving it out keeps the stored one. Mapped fields are
 * written in upstream's snake_case; a stale camel twin already in the entry is
 * left alone because upstream's loader prefers the snake value anyway.
 */
export function patchTelegramAccount(
  entry: RawEntry,
  patch: {
    token: string | null;
    enabled: boolean;
    dmPolicy: DmPolicy;
    displayName: string | null;
    now: string;
  },
): void {
  if (patch.token !== null) entry.token = patch.token;
  entry.enabled = patch.enabled;
  entry.dmPolicy = patch.dmPolicy;
  if (patch.displayName !== null) entry.displayName = patch.displayName;
  entry.updatedAt = patch.now;
}

/**
 * The account the first save creates — the durable effect of upstream's
 * `configure` wizard, in the exact write shape upstream's own writer emits.
 */
export function createTelegramAccount(
  accountId: string,
  token: string,
  displayName: string | null,
  now: string,
): RawEntry {
  return {
    channel: "telegram",
    accountId,
    ...(displayName !== null ? { displayName } : {}),
    enabled: true,
    token,
    dmPolicy: DEFAULT_DM_POLICY,
    allowedUsers: [],
    binding: { agentId: null, conversationId: null },
    group_mode: DEFAULT_GROUP_MODE,
    transcribe_voice: DEFAULT_TRANSCRIBE_VOICE,
    rich_private_chat_default: DEFAULT_RICH_PRIVATE_CHAT,
    inbound_debounce_ms: DEFAULT_INBOUND_DEBOUNCE_MS,
    createdAt: now,
    updatedAt: now,
  };
}

// ── routing.json ────────────────────────────────────────────────────────────

export function parseRoutes(text: string | null): RawEntry[] {
  return entryArray(parseJsonObject(text)?.routes);
}

export function renderRoutes(entries: RawEntry[]): string {
  return `${JSON.stringify({ routes: entries }, null, 2)}\n`;
}

/**
 * A row the settings screen can show and remove — anything without a chat id
 * cannot be addressed, so it is not listed (it stays on disk untouched).
 */
export function toPublicRoute(entry: RawEntry): TelegramRouteSummary | null {
  const chatId = optionalText(entry.chatId);
  if (!chatId) return null;
  return {
    chatId,
    agentId: optionalText(entry.agentId),
    conversationId: optionalText(entry.conversationId),
    enabled: entry.enabled !== false,
  };
}

// ── pairing.yaml (JSON) ─────────────────────────────────────────────────────

export interface PairingFile {
  pending: RawEntry[];
  approved: RawEntry[];
}

export function parsePairing(text: string | null): PairingFile {
  const raw = parseJsonObject(text);
  return { pending: entryArray(raw?.pending), approved: entryArray(raw?.approved) };
}

export function renderPairing(file: PairingFile): string {
  return `${JSON.stringify({ pending: file.pending, approved: file.approved }, null, 2)}\n`;
}

/**
 * Upstream stamps ISO `expiresAt` strings; one that cannot be read is treated
 * as expired, so a corrupt entry can never outlive its display.
 */
export function pendingIsExpired(entry: RawEntry, nowMs: number): boolean {
  const raw = optionalText(entry.expiresAt);
  if (!raw) return true;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? true : at <= nowMs;
}

export function toPublicPending(entry: RawEntry): TelegramPendingSummary | null {
  const code = optionalText(entry.code);
  const senderId = optionalText(entry.senderId);
  const chatId = optionalText(entry.chatId);
  if (!code || !senderId || !chatId) return null;
  return {
    code,
    senderId,
    senderName: optionalText(entry.senderName),
    chatId,
    expiresAt: optionalText(entry.expiresAt),
  };
}

/**
 * One read of all three files — the whole channel state as the BFF can see
 * it. The gateway writes `pairing.yaml` when a stranger messages the bot, so
 * everything here is always read fresh, never cached. A read failure throws
 * (a missing file is `io.read` → null): a save that patched an empty store
 * after a swallowed error would overwrite real state.
 */
export async function readChannelFiles(
  io: ChannelsIo,
): Promise<{ accounts: RawEntry[]; routes: RawEntry[]; pairing: PairingFile }> {
  const [accounts, routing, pairing] = await Promise.all([
    io.read(TELEGRAM_ACCOUNTS_PATH),
    io.read(TELEGRAM_ROUTING_PATH),
    io.read(TELEGRAM_PAIRING_PATH),
  ]);
  return {
    accounts: parseAccounts(accounts),
    routes: parseRoutes(routing),
    pairing: parsePairing(pairing),
  };
}
