/**
 * Settings → Codex and the run viewer. The files themselves are explained in
 * `service.ts`; these four routes gate them by the `codex` compose-profile token
 * and by a live app-server, because the io goes through the app-server file
 * channel. `index.ts` registers them where they used to sit, so middleware order
 * is unchanged.
 * The session check is not here on purpose: `index.ts` gates every `/api/*` route
 * with `requireSession` before registering these.
 * */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { isCodexThreadId } from "./rollout.ts";
import {
  type CodexFileIo,
  getCodexRun,
  listCodexRuns,
  loadCodexSettings,
  saveCodexSettings,
  suggestedCodexBaseUrl,
} from "./service.ts";
import { InvalidCodexSettingsError, toPublicCodexSettings } from "./settings.ts";

export interface CodexRouteDeps {
  /** The one upstream connection: the file channel dies with it. */
  isReady: () => boolean;
  /** The `codex` compose-profile token — nothing to configure without the CLI. */
  codexEnabled: boolean;
  io: CodexFileIo;
}

export function registerCodexRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: CodexRouteDeps,
): void {
  const { isReady, codexEnabled, io } = deps;

  app.get("/api/codex/settings", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    try {
      const [settings, suggestedBaseUrl] = await Promise.all([
        loadCodexSettings(io),
        suggestedCodexBaseUrl(io),
      ]);
      return c.json({ settings: toPublicCodexSettings(settings), suggestedBaseUrl });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.put("/api/codex/settings", async (c) => {
    // Gated by the `codex` profile token: nothing to configure without the CLI,
    // and the connect-time reapply has already forced the stored switch off.
    if (!codexEnabled) return c.text("Codex workers are off: COMPOSE_PROFILES", 404);
    if (!isReady()) return c.text("App-server is not connected", 503);
    const body = await c.req.json().catch(() => null);
    try {
      const saved = await saveCodexSettings(io, body);
      return c.json({ settings: toPublicCodexSettings(saved) });
    } catch (error) {
      if (error instanceof InvalidCodexSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/codex/runs", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
    try {
      return c.json({ runs: await listCodexRuns(io, limit) });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/codex/runs/:threadId", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const threadId = c.req.param("threadId");
    // The id becomes part of a file lookup; only a real Codex thread id gets that far.
    if (!isCodexThreadId(threadId)) return c.text("Not a Codex thread id", 400);
    try {
      const run = await getCodexRun(io, threadId);
      return run ? c.json({ run }) : c.text("No such Codex run", 404);
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });
}
