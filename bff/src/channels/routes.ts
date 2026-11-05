/**
 * Settings → Telegram. The state files themselves are explained in `state.ts`;
 * these five routes gate them by the `telegram` compose-profile token — the
 * one that creates the `channel-gateway` container, so without it there is no
 * bot to configure — and by a live app-server, because the io goes through the
 * app-server file channel.
 *
 * What applies live and what does not: routes and pairing approvals are
 * re-read by the gateway per inbound message, so approve/remove need nothing;
 * account changes (token, `enabled`) are read only at gateway startup, so
 * they apply when the supervise wrapper restarts it on the file change
 * (docker/channel-gateway-supervise.sh).
 *
 * The session check is not here on purpose: `index.ts` gates every `/api/*`
 * route with `requireSession` before registering these.
 */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import type { ChannelsIo } from "./service.ts";
import {
  approvePairing,
  dropPending,
  dropRoutes,
  InvalidTelegramRequestError,
  loadTelegramStatus,
  notifyPairingApproved,
  type PairingBindingNames,
  saveTelegramAccount,
  TelegramPairingNotFoundError,
} from "./service.ts";

export interface TelegramRouteDeps {
  /** The one upstream connection: the file channel dies with it. */
  isReady: () => boolean;
  /** The `telegram` compose-profile token — no gateway container, no channel. */
  telegramEnabled: boolean;
  io: ChannelsIo;
  /** Injected in tests; the real Bot API call is the global fetch. */
  send?: typeof fetch;
  /** Human-readable names for the bound pair, for the chat's notice. */
  bindingNames?: (agentId: string, conversationId: string) => Promise<PairingBindingNames>;
}

export function registerTelegramRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: TelegramRouteDeps,
): void {
  const { isReady, telegramEnabled, io, send = fetch, bindingNames } = deps;

  app.get("/api/channels/telegram", async (c) => {
    if (!telegramEnabled) return c.text("Telegram is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    try {
      return c.json(await loadTelegramStatus(io));
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.put("/api/channels/telegram/account", async (c) => {
    if (!telegramEnabled) return c.text("Telegram is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const body = await c.req.json().catch(() => null);
    try {
      const account = await saveTelegramAccount(io, body);
      // The account summary only — the bot token is write-only and never
      // leaves the BFF, not even to this session.
      return c.json({ account });
    } catch (error) {
      if (error instanceof InvalidTelegramRequestError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.post("/api/channels/telegram/pairings/approve", async (c) => {
    if (!telegramEnabled) return c.text("Telegram is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const body = await c.req.json().catch(() => null);
    try {
      const result = await approvePairing(io, body);
      // The pairing is real the moment the files are written; telling the
      // chat is a courtesy to the human on the other side, and its failure
      // never unwinds the approval — it only says so in `notified`.
      let binding: PairingBindingNames | null = null;
      if (bindingNames && result.route.agentId && result.route.conversationId) {
        binding = await bindingNames(result.route.agentId, result.route.conversationId).catch(
          () => null,
        );
      }
      const notified = await notifyPairingApproved(io, result.route.chatId, binding, send);
      return c.json({ ...result, notified });
    } catch (error) {
      if (error instanceof InvalidTelegramRequestError) return c.text(error.message, 400);
      if (error instanceof TelegramPairingNotFoundError) return c.text(error.message, 404);
      return c.text(errorMessage(error), 502);
    }
  });

  // Ignore a pending pairing. The code arrives as a query param: DELETE
  // bodies are not a thing browsers send reliably.
  app.delete("/api/channels/telegram/pairings", async (c) => {
    if (!telegramEnabled) return c.text("Telegram is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.text("code is required", 400);
    try {
      return (await dropPending(io, code))
        ? c.json({ dropped: true })
        : c.text("No such pending pairing", 404);
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.delete("/api/channels/telegram/routes", async (c) => {
    if (!telegramEnabled) return c.text("Telegram is off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const chatId = c.req.query("chatId")?.trim() ?? "";
    if (!chatId) return c.text("chatId is required", 400);
    try {
      return (await dropRoutes(io, chatId))
        ? c.json({ dropped: true })
        : c.text("No route for this chat", 404);
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });
}
