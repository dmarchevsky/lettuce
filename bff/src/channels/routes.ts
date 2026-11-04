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
  saveTelegramAccount,
  TelegramPairingNotFoundError,
} from "./service.ts";

export interface TelegramRouteDeps {
  /** The one upstream connection: the file channel dies with it. */
  isReady: () => boolean;
  /** The `telegram` compose-profile token — no gateway container, no channel. */
  telegramEnabled: boolean;
  io: ChannelsIo;
}

export function registerTelegramRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: TelegramRouteDeps,
): void {
  const { isReady, telegramEnabled, io } = deps;

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
      return c.json(await approvePairing(io, body));
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
