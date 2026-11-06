/**
 * The delete route as a Hono mount, not just as a decision.
 *
 * `delete.test.ts` proves the guard chain; this proves the wiring around it that
 * only a request can prove: that the path is read from `?path=`, that a refusal
 * comes back as the guard's own sentence with the hardened headers, that the 200
 * body is `{deleted, type}` (what `web/src/lib/delete.ts` reads), and that the
 * default removal is the real one — `rmSync` against a temporary tree, with no
 * injected `remove` anywhere in this file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerFilesRoutes } from "./routes.ts";

let root: string;
const hardened = { "x-frame-options": "DENY" };

function app(connected: boolean) {
  const instance = new Hono<{ Variables: { session?: unknown } }>();
  instance.use("*", async (c, next) => {
    c.set("session", connected ? { email: "owner@example.com" } : undefined);
    await next();
  });
  registerFilesRoutes(instance, { hardened, root });
  return instance;
}

const post = (host: ReturnType<typeof app>, path: string | null) =>
  host.request(
    path === null ? "/api/files/delete" : `/api/files/delete?path=${encodeURIComponent(path)}`,
    { method: "POST" },
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lettuce-delete-route-"));
  mkdirSync(join(root, "agent-local-1", "notes"), { recursive: true });
  writeFileSync(join(root, "agent-local-1", "persona.md"), "hello", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the route is a POST over `?path=`, and the default removal is the filesystem", async () => {
  const file = join(root, "agent-local-1", "persona.md");
  // The body carries what the guard resolved, not the spelling it was handed, and
  // a temporary directory can itself live behind a symlink (`/tmp` on a Mac).
  const real = realpathSync(file);
  const response = await post(app(true), file);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { deleted?: string; type?: string };
  expect(body).toEqual({ deleted: real, type: "file" });
  expect(existsSync(file)).toBe(false);
});

test("a folder goes with its contents, and the body says it was a folder", async () => {
  const dir = join(root, "agent-local-1", "notes");
  const response = await post(app(true), dir);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { deleted?: string; type?: string };
  expect(body.type).toBe("dir");
  expect(existsSync(dir)).toBe(false);
});

test("an anonymous POST is refused before the path is looked at", async () => {
  const file = join(root, "agent-local-1", "persona.md");
  const response = await post(app(false), file);
  expect(response.status).toBe(401);
  expect(existsSync(file)).toBe(true);
});

test("a refusal is the guard's own sentence, with the hardened headers", async () => {
  const response = await post(app(true), root);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("remove its contents instead");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("a missing `path` is a bad request, not an empty string under /work", async () => {
  const response = await post(app(true), null);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Missing path");
});
