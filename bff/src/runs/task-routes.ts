/**
 * `GET /api/task-runs` and `GET /api/task-runs/:taskId/events` — the Runs pane's
 * file-backed list, the sibling of `claude/routes.ts` over a different tree.
 *
 * Two differences worth stating. There is no profile token here: no Compose token
 * applies to a directory the app-server always writes, so the gate is the session
 * `index.ts` already puts in front of every `/api/*`. And there is no `isReady()`
 * check, on purpose — these files outlive the app-server process, so a list that
 * answered 503 while the app-server was down would withhold the one thing that
 * is still true about it.
 */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import { isTaskId, type TaskLogStore } from "./task-logs.ts";

/** Query bounds, so a listing cannot be asked for a whole archive in one call. */
const MAX_LIST_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function registerTaskRunRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  store: TaskLogStore,
): void {
  app.get("/api/task-runs", async (c) => {
    const limit = positiveInt(c.req.query("limit"), 25, MAX_LIST_LIMIT) || 1;
    const cursor = positiveInt(c.req.query("cursor"), 0, Number.MAX_SAFE_INTEGER);
    try {
      return c.json(await store.list({ limit, cursor }));
    } catch (error) {
      // Local filesystem facts: a directory that vanished mid-scan is reported,
      // never retried, and never a 500 for what the caller can see is fine.
      return c.text(errorMessage(error), 500);
    }
  });

  app.get("/api/task-runs/:taskId/events", async (c) => {
    const taskId = c.req.param("taskId") ?? "";
    // The id becomes two file names; only a task id the listing could have
    // produced gets that far (`task-logs.ts` re-checks the resolved path).
    if (!isTaskId(taskId)) return c.text("Not a task run id", 400);
    const after = positiveInt(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER);
    const limit = positiveInt(c.req.query("limit"), 200, MAX_EVENT_LIMIT) || 1;
    try {
      const page = await store.events(taskId, { after, limit });
      return page ? c.json(page) : c.text("No such task run", 404);
    } catch (error) {
      return c.text(errorMessage(error), 500);
    }
  });
}
