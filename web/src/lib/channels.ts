/**
 * Settings → Telegram: the gateway's bot, pairings and chat routes
 * (bff/src/channels/). What applies when: approvals and route removal are
 * re-read by the gateway per inbound message and apply at once; account saves
 * (token, `enabled`) apply when the supervise wrapper restarts the gateway on
 * the file change (docker/channel-gateway/supervise.sh), within seconds.
 */

export interface TelegramAccount {
  accountId: string;
  displayName: string | null;
  enabled: boolean;
  dmPolicy: "pairing" | "allowlist" | "open";
  groupMode: string;
  /** Last four characters of the bot token; the token itself never arrives. */
  tokenTail: string | null;
  updatedAt: string | null;
}

export interface TelegramRoute {
  chatId: string;
  agentId: string | null;
  conversationId: string | null;
  enabled: boolean;
}

export interface TelegramPending {
  code: string;
  senderId: string;
  senderName: string | null;
  chatId: string;
  expiresAt: string | null;
}

export interface TelegramStatus {
  configured: boolean;
  account: TelegramAccount | null;
  routes: TelegramRoute[];
  /** Unexpired only — the BFF drops the rest. */
  pending: TelegramPending[];
}

export interface TelegramAccountUpdate {
  token?: string;
  enabled?: boolean;
  dmPolicy?: TelegramAccount["dmPolicy"];
  displayName?: string | null;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await ok(await fetch(url, init))).json() as Promise<T>;
}

export async function fetchTelegramStatus(): Promise<TelegramStatus> {
  return requestJson<TelegramStatus>("/api/channels/telegram");
}

export async function saveTelegramAccount(update: TelegramAccountUpdate): Promise<TelegramAccount> {
  const body = await requestJson<{ account: TelegramAccount }>("/api/channels/telegram/account", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return body.account;
}

export async function approveTelegramPairing(
  code: string,
  agentId: string,
  conversationId: string,
): Promise<void> {
  await ok(
    await fetch("/api/channels/telegram/pairings/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, agentId, conversationId }),
    }),
  );
}

export async function ignoreTelegramPairing(code: string): Promise<void> {
  await ok(
    await fetch(`/api/channels/telegram/pairings?code=${encodeURIComponent(code)}`, {
      method: "DELETE",
    }),
  );
}

export async function removeTelegramRoute(chatId: string): Promise<void> {
  await ok(
    await fetch(`/api/channels/telegram/routes?chatId=${encodeURIComponent(chatId)}`, {
      method: "DELETE",
    }),
  );
}

/** "expires in 11 min" — the code's own clock, worded before it lapses. */
export function describeExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 1 ? `expires in ${minutes} min` : "expires in seconds";
}

/** The sender's display name, falling back to its numeric Telegram id. */
export function senderLabel(pending: { senderName: string | null; senderId: string }): string {
  const name = pending.senderName?.trim();
  if (name && name !== pending.senderId) return name;
  return `Chat ${pending.senderId}`;
}
