/**
 * The routes behind Settings → Remote pi and the in-transcript run card. All
 * of it is BFF-local — settings and keys on `bff-data`, runs captured from the
 * BFF's own ssh spawns — so the only thing these handlers borrow from `index.ts`
 * is the service singleton, whether the profile token is on, and the mod
 * resync that runs after a save. `index.ts` calls `registerPiRoutes` where the
 * routes used to sit, so middleware order is unchanged.
 * The session check is not here on purpose: `index.ts` gates every `/api/*` route
 * with `requireSession` before registering these.
 */

import type { Hono } from "hono";
import { isAgentId } from "../agents/id-list.ts";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { hardenedResponse } from "../security-headers.ts";
import {
  assertEffectiveUsable,
  effectivePiSettings,
  InvalidPiAgentSettingsError,
  parsePiAgentSettings,
} from "./agent-settings.ts";
import {
  InvalidPiSettingsError,
  isPiRunId,
  type PiService,
  piConfigured,
  toPublicPiSettings,
} from "./service.ts";
import { parsePiRun, summarizePiRun } from "./transcript.ts";

/** What a handler may borrow from the boot module. */
export interface PiRouteDeps {
  piService: PiService;
  /** The `pi` compose-profile token; false answers 404 on everything here. */
  piEnabled: boolean;
  resyncMods: (
    reason: string,
    options: { refreshCatalog: boolean; refreshProviders?: boolean },
  ) => Promise<unknown>;
  /** Carried on the artifact response, which is built here rather than by Hono. */
  hardened: Record<string, string>;
}

/** File types a run artifact comes back as; anything else is octet-stream. */
const PI_FILE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  // html and svg would run scripts on our own origin; they come back as text.
};

/** A body may carry form values that are not saved yet — a check tests those. */
function piDraftFromBody(body: unknown): Partial<Record<string, unknown>> {
  if (!body || typeof body !== "object") return {};
  const r = body as Record<string, unknown>;
  const draft: Partial<Record<string, unknown>> = {};
  for (const field of ["host", "user", "pathPrepend", "workdir"] as const) {
    if (typeof r[field] === "string") draft[field] = r[field];
  }
  if (r.port !== undefined) draft.port = r.port;
  return draft;
}

/** What a check is about: saved values, or the form's, plus whose host to use. */
function piCheckBody(body: unknown): { draft: Record<string, unknown>; agentId: string | null } {
  const r = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof r.agent_id === "string" && isAgentId(r.agent_id) ? r.agent_id : null;
  return { draft: piDraftFromBody(body), agentId };
}

export function registerPiRoutes<Env extends RouteEnv>(app: Hono<Env>, deps: PiRouteDeps): void {
  const { piService, piEnabled, resyncMods, hardened } = deps;
  /**
   * One agent's own Remote Pi settings: its workdir, and if it must, its own host.
   * Stored by the BFF beside the pi settings and resolved at tool-call time, so
   * the four pi tools stay exactly the four tools upstream sees.
   */
  async function piAgentPayload(agentId: string) {
    const global = await piService.load();
    const effective = await piService.settingsFor(agentId);
    return {
      agentId,
      override: piService.agentSettings.get(agentId),
      effective: toPublicPiSettings(effective),
      globalConfigured: piConfigured(global),
      globalTarget:
        global.host && global.user ? `${global.user}@${global.host}:${global.port}` : null,
      check: await piService.lastCheck(effective),
    };
  }

  app.get("/api/pi/settings", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const settings = await piService.load();
    return c.json({
      settings: toPublicPiSettings(settings),
      // What the last check said about the saved target, or null. The UI adds
      // "changed since the last check" itself; the BFF only remembers facts.
      check: await piService.lastCheck(settings),
      // Which agents point somewhere of their own, so the shared section can say
      // "2 agents use their own settings" instead of being surprised by them.
      agents: Object.entries(piService.agentSettings.all()).map(([agentId, override]) => ({
        agentId,
        mode: override.mode,
      })),
    });
  });

  app.put("/api/pi/settings", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const body = await c.req.json().catch(() => null);
    try {
      const saved = await piService.save(body);
      const mod = await resyncMods("Settings → Remote pi", { refreshCatalog: false });
      // Save answers the question automatically, because an unpinned or
      // unreachable host is otherwise discovered by an agent's failed run. A
      // check that cannot run never fails the save.
      const check = await piService.checkHost(saved).catch(() => null);
      return c.json({ settings: toPublicPiSettings(saved), mod, check });
    } catch (error) {
      if (error instanceof InvalidPiSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/pi/agent/:agentId", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
    return c.json(await piAgentPayload(agentId));
  });

  app.put("/api/pi/agent/:agentId", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
    const body = await c.req.json().catch(() => null);
    const override = parsePiAgentSettings(body);
    if (!override) {
      return c.text("Body must be { mode, host, port, user, pathPrepend, workdir, model }", 400);
    }
    try {
      assertEffectiveUsable(await effectivePiSettings(await piService.load(), override));
    } catch (error) {
      if (error instanceof InvalidPiAgentSettingsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 500);
    }
    piService.agentSettings.set(agentId, override);
    await piService.agentSettings.drain();
    // Same courtesy as the shared settings: answer the host question right away.
    const check = await piService.checkHost({}, agentId).catch(() => null);
    return c.json({ ...(await piAgentPayload(agentId)), check });
  });

  /** Back to inheriting everything. */
  app.delete("/api/pi/agent/:agentId", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const agentId = c.req.param("agentId");
    if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
    piService.agentSettings.remove(agentId);
    await piService.agentSettings.drain();
    return c.json(await piAgentPayload(agentId));
  });

  /** Check the host — saved values, or the form's, when they are not saved yet. */
  app.post("/api/pi/check", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const body = await c.req.json().catch(() => null);
    try {
      const { draft, agentId } = piCheckBody(body);
      return c.json({ check: await piService.checkHost(draft as never, agentId) });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  /**
   * TOFU pin: ssh-keyscan a host and write what it answers. A different key
   * already pinned for that host is a 409 with both fingerprints — replacing it
   * is a second, deliberate click.
   */
  app.post("/api/pi/pin-host", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const options = {
      ...(typeof body?.host === "string" ? { host: body.host } : {}),
      ...(Number.isFinite(Number(body?.port)) && body?.port !== undefined && body?.port !== ""
        ? { port: Number(body.port) }
        : {}),
      ...(body?.force === true ? { force: true } : {}),
      ...(typeof body?.agent_id === "string" && isAgentId(body.agent_id)
        ? { agentId: body.agent_id }
        : {}),
    };
    try {
      const pinned = await piService.pinHost(options);
      if (pinned.changed) return c.json({ pinned }, 409);
      return c.json({ pinned });
    } catch (error) {
      return c.text(errorMessage(error), 400);
    }
  });

  /** Generate or rotate the lettuce-held deploy key; only the public half is served. */
  app.post("/api/pi/generate-key", async (c) => {
    if (!piEnabled) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
    try {
      const settings = await piService.generateKeyPair();
      return c.json({ settings: toPublicPiSettings(settings) });
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
  });

  app.get("/api/pi/runs", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
    const runs = (await piService.listRuns(limit)).map(summarizePiRun);
    return c.json({ runs });
  });

  app.get("/api/pi/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!isPiRunId(runId)) return c.text("Not a run id", 400);
    const meta = await piService.getRun(runId);
    if (!meta) return c.text("No such run", 404);
    const events = (await piService.store.readEventsTail(runId, 8_000_000)) ?? "";
    return c.json({ run: parsePiRun(meta, events), capturing: piService.runner.isRunning(runId) });
  });

  // Structured status for the in-transcript run card — the same facts pi_status
  // carries as prose, cheap enough to poll every few seconds.
  app.get("/api/pi/runs/:runId/status", async (c) => {
    const runId = c.req.param("runId");
    if (!isPiRunId(runId)) return c.text("Not a run id", 400);
    const status = await piService.statusFacts(runId);
    if (!status) return c.text("No such run", 404);
    return c.json({ status });
  });

  // The card's Stop / Force stop buttons; same paths as the pi_stop tool.
  app.post("/api/pi/runs/:runId/stop", async (c) => {
    const runId = c.req.param("runId");
    if (!isPiRunId(runId)) return c.text("Not a run id", 400);
    const body = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
    const answer = await piService.stopRun(runId, body?.force === true);
    return c.json(answer, answer.isError ? 409 : 200);
  });

  // Artifacts a pi_fetch pulled in (C1): the card lists them, links open them.
  app.get("/api/pi/runs/:runId/files", async (c) => {
    const runId = c.req.param("runId");
    if (!isPiRunId(runId)) return c.text("Not a run id", 400);
    return c.json({ files: await piService.store.listFiles(runId) });
  });

  app.get("/api/pi/runs/:runId/files/:name", async (c) => {
    const runId = c.req.param("runId");
    if (!isPiRunId(runId)) return c.text("Not a run id", 400);
    const bytes = await piService.store.readFile(runId, c.req.param("name"));
    if (!bytes) return c.text("No such file", 404);
    const ext = c.req.param("name").split(".").pop()?.toLowerCase() ?? "";
    return hardenedResponse(hardened, bytes, {
      "content-type": PI_FILE_TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="${c.req.param("name")}"`,
      "cache-control": "private, max-age=300",
    });
  });
}
