/**
 * Settings → Claude Code and the run viewer — the sibling of `codex/routes.ts`
 * with Claude's own file names and session ids. The io is the same app-server
 * file channel, so the gating is identical: `claude` profile token, live
 * app-server.
 * The session check is not here on purpose: `index.ts` gates every `/api/*` route
 * with `requireSession` before registering these.
 * */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import {
  type ClaudeFileIo,
  getClaudeRun,
  listClaudeRuns,
  loadClaudeSettings,
  saveClaudeSettings,
} from "./service.ts";
import { InvalidClaudeSettingsError, toPublicClaudeSettings } from "./settings.ts";
import { isClaudeSessionId } from "./transcript.ts";

export interface ClaudeRouteDeps {
  isReady: () => boolean;
  /** The `claude` compose-profile token, exactly like Codex's. */
  claudeEnabled: boolean;
  io: ClaudeFileIo;
}

export function registerClaudeRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: ClaudeRouteDeps,
): void {
  const { isReady, claudeEnabled, io } = deps;

  app.get("/api/claude/settings", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    try {
      return c.json({ settings: toPublicClaudeSettings(await loadClaudeSettings(io)) });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.put("/api/claude/settings", async (c) => {
    if (!claudeEnabled) return c.text("Claude Code workers are off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const body = await c.req.json().catch(() => null);
    try {
      const saved = await saveClaudeSettings(io, body);
      return c.json({ settings: toPublicClaudeSettings(saved) });
    } catch (error) {
      if (error instanceof InvalidClaudeSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/claude/runs", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
    try {
      return c.json({ runs: await listClaudeRuns(io, limit) });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/claude/runs/:sessionId", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const sessionId = c.req.param("sessionId");
    // The id becomes part of a file lookup; only a real Claude session id gets that far.
    if (!isClaudeSessionId(sessionId)) return c.text("Not a Claude session id", 400);
    try {
      const run = await getClaudeRun(io, sessionId);
      return run ? c.json({ run }) : c.text("No such Claude run", 404);
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });
}
