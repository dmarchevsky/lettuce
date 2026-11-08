/**
 * The Hono mount for the workspace delete, kept apart from the guard chain in
 * `delete.ts` for the same reason `google/routes.ts` is apart from its service:
 * the mount is the part that can only be proven by asking a real Hono app.
 *
 * `index.ts` calls `registerFilesRoutes(app, …)` below the session middleware,
 * and `files/routes.test.ts` mounts the same function on its own app — so the
 * query key, the status codes and the two response shapes are asserted, not just
 * the guard's decision. The route is `POST` with the path in the query because
 * the body would be a second way to say the same thing.
 */

import type { Hono } from "hono";
import type { RouteEnv } from "../route-env.ts";
import { hardenedResponse } from "../security-headers.ts";
import { deleteWorkspaceEntry } from "./delete.ts";

export interface FilesRouteDeps {
  /** The hardened header set from `security-headers.ts`, for the text responses. */
  hardened: Record<string, string>;
  /** Workspace root; only a test moves it off `/work`. */
  root?: string;
}

export function registerFilesRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: FilesRouteDeps,
): void {
  app.post("/api/files/delete", async (c) => {
    const result = await deleteWorkspaceEntry(
      { hasSession: !!c.get("session"), root: deps.root },
      { path: c.req.query("path") },
    );
    // The handler picked the status; plain numbers do not satisfy Hono's json
    // overload, which is the entire reason for the cast.
    const status = result.status as 200;
    return result.json !== undefined
      ? c.json(result.json, status)
      : hardenedResponse(deps.hardened, result.text ?? "", {}, result.status);
  });
}
