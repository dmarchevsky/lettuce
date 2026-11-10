/**
 * The session-listing route — the session viewer's spine, tested the way the
 * provider and channel routes are: a bare Hono app over a real PiService on a
 * temp directory, so the assertions land on the JSON the panel actually reads.
 * The other pi routes are tool- and settings-shaped and covered in `pi.test.ts`.
 */

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { RouteEnv } from "../route-env.ts";
import { registerPiRoutes } from "./routes.ts";
import type { PiRunMeta } from "./runner.ts";
import { PiService } from "./service.ts";

const SESSION = "01a10e10-08ec-705d-a364-5cfa40e1a963";

function meta(runId: string, startedAt: string, session: string | null): PiRunMeta {
  return {
    runId,
    kind: "run",
    agentId: null,
    conversationId: null,
    session,
    prompt: `task ${runId.slice(0, 4)}`,
    model: null,
    target: "worker@pi.example.invalid",
    startedAt,
    endedAt: "2026-10-05T12:05:00.000Z",
    state: "completed",
    exitCode: 0,
    settled: true,
    eventCount: 4,
    lastEventAt: null,
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
    error: null,
  };
}

async function routes(piEnabled = true) {
  const dir = await mkdtemp(`${tmpdir()}/pi-routes-`);
  const piService = new PiService({
    paths: { dir },
    featureEnabled: () => piEnabled,
    spawner: () => {
      throw new Error("no spawns in a route test");
    },
  });
  const app = new Hono<RouteEnv>();
  registerPiRoutes(app, {
    piService,
    piEnabled,
    resyncMods: async () => ({}),
    hardened: {},
  });
  return { store: piService.store, app };
}

test("a session's runs come back oldest first, with the focus ids the panel needs", async () => {
  const { store, app } = await routes();
  await store.create(
    meta("33333333-3333-4333-8333-333333333333", "2026-10-05T12:03:00.000Z", SESSION),
  );
  await store.create(
    meta("11111111-1111-4111-8111-111111111111", "2026-10-05T12:01:00.000Z", SESSION),
  );
  await store.create(
    meta("22222222-2222-4222-8222-222222222222", "2026-10-05T12:02:00.000Z", null),
  );

  const response = await app.fetch(new Request(`http://x/api/pi/session/${SESSION}/runs`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { session: string; runs: PiRunMeta[]; capped: boolean };
  expect(body.session).toBe(SESSION);
  expect(body.runs.map((run) => run.startedAt)).toEqual([
    "2026-10-05T12:01:00.000Z",
    "2026-10-05T12:03:00.000Z",
  ]);
  expect(body.runs[0]?.runId).toBe("11111111-1111-4111-8111-111111111111");
  expect(body.capped).toBe(false);
});

test("an unknown session is an empty list, not a 404 — the panel says so itself", async () => {
  const { app } = await routes();
  const response = await app.fetch(
    new Request("http://x/api/pi/session/00000000-0000-4000-8000-000000000000/runs"),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { runs: unknown[] }).runs).toEqual([]);
});

test("the route refuses a string that is not a session id, and answers 404 while pi is off", async () => {
  const { app } = await routes();
  // The id is validated before the store is touched: a path-traversal attempt or a
  // hand-typed id cannot make the listing scan the run directory.
  expect((await app.fetch(new Request("http://x/api/pi/session/not-a-uuid/runs"))).status).toBe(
    400,
  );
  expect((await app.fetch(new Request("http://x/api/pi/session/not-a-uuid/runs"))).status).toBe(
    400,
  );

  const off = await routes(false);
  expect((await off.app.fetch(new Request(`http://x/api/pi/session/${SESSION}/runs`))).status).toBe(
    404,
  );
});

test("the stop route answers like the tool, and refuses a non-run id", async () => {
  // The card's two buttons come through here, so the flag has to arrive intact:
  // detach closes the capture (and there is none to close), the default asks for
  // the remote process it cannot find. Both refusals are 409s with different
  // reasons, and `force` — the older body — still means the default.
  const { store, app } = await routes();
  const runId = "44444444-4444-4444-8444-444444444444";
  await store.create(meta(runId, "2026-10-05T12:01:00.000Z", SESSION));

  const detached = await app.fetch(
    new Request(`http://x/api/pi/runs/${runId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detach: true }),
    }),
  );
  expect(detached.status).toBe(409);
  expect(((await detached.json()) as { text: string }).text).toContain("not being captured");

  const stopped = await app.fetch(
    new Request(`http://x/api/pi/runs/${runId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    }),
  );
  expect(stopped.status).toBe(409);
  expect(((await stopped.json()) as { text: string }).text).toContain("cannot be killed");

  expect(
    (
      await app.fetch(
        new Request("http://x/api/pi/runs/not-a-uuid/stop", { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(400);
});
