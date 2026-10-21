/**
 * Acceptance test for the invariant the whole architecture rests on:
 * a browser session disappearing must NOT disturb the app-server.
 *
 * See AGENTS.md — the app-server cancels in-flight turns, drops queued messages
 * and rejects pending approvals for a connection that closes. Browser sockets
 * close constantly (tab switch, phone sleep), so they must never be the
 * connection the app-server knows about.
 *
 * Usage: bun scripts/persistence-smoke.ts [bffOrigin]
 */

import { MAX_REPLAY_FRAMES } from "../bff/src/session/buffer.ts";
import { requireTestPassword } from "./harness.ts";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const WS_ORIGIN = ORIGIN.replace(/^http/, "ws");

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Whatever method this stack signs in with. `password` needs LETTUCE_TEST_PASSWORD. */
async function login(): Promise<string> {
  const method = ((await status()) as { signin?: string }).signin;
  const response =
    method === "password"
      ? await fetch(`${ORIGIN}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: requireTestPassword("smoke") }),
        })
      : await fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`No session cookie (status ${response.status})`);
  return cookie.split(";")[0]!;
}

async function status(cookie?: string): Promise<Record<string, any>> {
  return (
    await fetch(`${ORIGIN}/api/status`, cookie ? { headers: { cookie } } : undefined)
  ).json() as Promise<Record<string, any>>;
}

interface Session {
  socket: WebSocket;
  frames: any[];
  waitFor: (predicate: (frame: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (command: Record<string, unknown>) => void;
  close: () => void;
}

function openSession(cookie: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_ORIGIN}/ws`, { headers: { cookie } } as any);
    const frames: any[] = [];
    const waiters: { predicate: (f: any) => boolean; resolve: (f: any) => void }[] = [];

    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.predicate(frame)) {
          waiters.splice(i, 1)[0]!.resolve(frame);
        }
      }
    });

    socket.addEventListener("error", reject);
    socket.addEventListener("open", () =>
      resolve({
        socket,
        frames,
        waitFor: (predicate, timeoutMs = 10_000) =>
          new Promise((res, rej) => {
            const existing = frames.find(predicate);
            if (existing) return res(existing);
            const timer = setTimeout(
              () => rej(new Error(`Timed out; saw: ${frames.map((f) => f.type).join(", ")}`)),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: (f) => {
                clearTimeout(timer);
                res(f);
              },
            });
          }),
        send: (command) => socket.send(JSON.stringify(command)),
        close: () => socket.close(),
      }),
    );
  });
}

const cookie = await login();
console.log(`Authenticated: ${cookie.split("=")[0]}`);

// Other clients may be connected (a phone with the UI open). Compare against
// this baseline rather than assuming the server is idle.
const baseline = (await status(cookie)).sessions;
if (baseline > 0) console.log(`Note: ${baseline} session(s) already connected`);

// ── 1. A session can drive the app-server ────────────────────────────────────
section("1. Session routing");
const a = await openSession(cookie);
const hello = await a.waitFor((f) => f.type === "__bff_hello");
check("receives __bff_hello", Boolean(hello.session_id));
check("upstream is connected", hello.upstream === "connected", hello.upstream);

a.send({ type: "agent_list", request_id: "web-1", query: { limit: 5 } });
const agentList = await a.waitFor((f) => f.type === "agent_list_response");
check("agent_list round trip succeeds", agentList.success === true, agentList);
check(
  "request_id is translated back to the browser's own id",
  agentList.request_id === "web-1",
  agentList.request_id,
);

// ── 2. Two sessions are isolated in request space ────────────────────────────
section("2. Concurrent sessions");
const b = await openSession(cookie);
await b.waitFor((f) => f.type === "__bff_hello");

// Both use the same client-side id; each must get its own response back.
a.send({ type: "agent_list", request_id: "dup", query: { limit: 1 } });
b.send({ type: "conversation_list", request_id: "dup", query: { limit: 1 } });
const aResp = await a.waitFor((f) => f.request_id === "dup" && f.type === "agent_list_response");
const bResp = await b.waitFor(
  (f) => f.request_id === "dup" && f.type === "conversation_list_response",
);
check(
  "session A got its own response despite a colliding id",
  aResp.type === "agent_list_response",
);
check(
  "session B got its own response despite a colliding id",
  bResp.type === "conversation_list_response",
);
check(
  "responses did not leak across sessions",
  !a.frames.some((f) => f.type === "conversation_list_response") &&
    !b.frames.some((f) => f.type === "agent_list_response"),
);

const before = await status(cookie);
check("both sessions registered", before.sessions >= 2, { sessions: before.sessions, baseline });

// ── 3. The command allowlist holds ───────────────────────────────────────────
section("3. Command allowlist");
a.send({ type: "terminal_spawn", request_id: "web-term", terminal_id: "t1", cols: 80, rows: 24 });
const denied = await a.waitFor((f) => f.type === "__bff_error" && f.request_id === "web-term");
check(
  "terminal_spawn is refused from a browser session",
  denied.message.includes("not permitted"),
  denied,
);

// ── 4. THE INVARIANT: dropping browser sockets must not touch upstream ───────
section("4. Browser disconnect does not reach the app-server");
const generationBefore = before.upstream.generation;
a.close();
b.close();
await new Promise((r) => setTimeout(r, 600));

const after = await status(cookie);
check("this test's sessions were unregistered", after.sessions === baseline, {
  after: after.sessions,
  baseline,
});
check("upstream is still connected", after.upstream.state === "connected", after.upstream.state);
check(
  "upstream socket was never re-established",
  after.upstream.generation === generationBefore && after.upstream.generation === 1,
  { before: generationBefore, after: after.upstream.generation },
);

// ── 5. Resume replays exactly what was missed ────────────────────────────────
section("5. Session resume");
const c = await openSession(cookie);
const helloC = await c.waitFor((f) => f.type === "__bff_hello");
const seqAtReconnect = helloC.latest_seq;

c.send({ type: "__bff_resume", from_seq: seqAtReconnect, scopes: [] });
const resumed = await c.waitFor((f) => f.type === "__bff_resume_result");
check("resume from the live head needs no resync", resumed.resync_required === false, resumed);
check("resume from the live head replays nothing", resumed.replayed === 0, resumed);

// A cursor at the very beginning is served by replay, as long as the whole
// retained history fits under the per-replay frame cap. On a stack that has
// been running long enough to buffer more than that, the cap is the correct
// answer and the client resyncs instead — so assert whichever branch applies
// rather than assuming the buffer is small.
c.send({ type: "__bff_resume", from_seq: 0, scopes: [] });
const stale = await c.waitFor((f) => f.type === "__bff_resume_result" && f.from_seq === 0);
if (stale.latest_seq <= MAX_REPLAY_FRAMES) {
  check(
    "an unwrapped buffer under the cap serves an old cursor without a resync",
    stale.resync_required === false,
    stale,
  );
  check("replay covers every buffered frame", stale.replayed === stale.latest_seq, {
    replayed: stale.replayed,
    latest_seq: stale.latest_seq,
  });
} else {
  check(
    `over the ${MAX_REPLAY_FRAMES}-frame replay cap an old cursor resyncs instead`,
    stale.resync_required === true && stale.replayed === 0,
    stale,
  );
}

const ahead = 999_999;
c.send({ type: "__bff_resume", from_seq: ahead, scopes: [] });
const impossible = await c.waitFor((f) => f.type === "__bff_resume_result" && f.from_seq === ahead);
check(
  "a cursor ahead of the buffer forces a resync",
  impossible.resync_required === true,
  impossible,
);

c.close();

// ── 6. Chat plumbing ─────────────────────────────────────────────────────────
section("6. Chat plumbing");
const d = await openSession(cookie);
await d.waitFor((f) => f.type === "__bff_hello");

d.send({ type: "agent_list", request_id: "agents", query: { limit: 5 } });
const agents = await d.waitFor((f) => f.request_id === "agents");
const agentId: string | undefined = agents.agents?.[0]?.id;
check("at least one agent exists", typeof agentId === "string", agents.agents?.length);

if (agentId) {
  d.send({ type: "conversation_create", request_id: "conv", body: { agent_id: agentId } });
  const created = await d.waitFor((f) => f.request_id === "conv");
  const conversationId: string | undefined = created.conversation?.id;
  check(
    "conversation_create succeeds",
    created.success === true && Boolean(conversationId),
    created.error,
  );

  if (conversationId) {
    d.send({
      type: "runtime_start",
      request_id: "rt",
      agent_id: agentId,
      conversation_id: conversationId,
      wait_for_replay: true,
    });
    const started = await d.waitFor((f) => f.request_id === "rt");
    check("runtime_start succeeds", started.success === true, started.error);

    d.send({
      type: "conversation_messages_list",
      request_id: "hist",
      conversation_id: conversationId,
      query: { limit: 50 },
    });
    const history = await d.waitFor((f) => f.request_id === "hist");
    check(
      "history loads",
      history.success === true && Array.isArray(history.messages),
      history.error,
    );

    // Rename and archive both go through conversation_update; `archived` is a
    // real field on the conversation record, not a tag.
    d.send({
      type: "conversation_update",
      request_id: "ren",
      conversation_id: conversationId,
      body: { summary: "Smoke test" },
    });
    const renamed = await d.waitFor((f) => f.request_id === "ren");
    check(
      "rename applies",
      renamed.conversation?.summary === "Smoke test",
      renamed.conversation?.summary,
    );

    d.send({
      type: "conversation_update",
      request_id: "arc",
      conversation_id: conversationId,
      body: { archived: true },
    });
    const archived = await d.waitFor((f) => f.request_id === "arc");
    check(
      "archive applies natively",
      archived.conversation?.archived === true,
      archived.conversation,
    );

    d.send({
      type: "conversation_update",
      request_id: "unarc",
      conversation_id: conversationId,
      body: { archived: false },
    });
    await d.waitFor((f) => f.request_id === "unarc");
  }
}

d.send({ type: "list_models", request_id: "models" });
const models = await d.waitFor((f) => f.request_id === "models");
check("model catalog is available", (models.entries?.length ?? 0) > 0, models.entries?.length);

// A runtime scope subscribes the connection, so status frames should arrive.
const statusFrames = d.frames.filter((f) => f.type === "update_device_status");
check("runtime emits device status", statusFrames.length > 0, statusFrames.length);

d.close();

// ── 7. Files, Memory, Tasks ──────────────────────────────────────────────────
section("7. Files, Memory, Tasks");
const e = await openSession(cookie);
await e.waitFor((f) => f.type === "__bff_hello");

e.send({ type: "agent_list", request_id: "ag2", query: { limit: 5 } });
const ag2 = await e.waitFor((f) => f.request_id === "ag2");
const agent2: string | undefined = ag2.agents?.[0]?.id;

if (agent2) {
  e.send({ type: "conversation_list", request_id: "cl2", query: { agent_id: agent2, limit: 5 } });
  const cl2 = await e.waitFor((f) => f.request_id === "cl2");
  const conv2: string | undefined = cl2.conversations?.[0]?.id;

  if (conv2) {
    e.send({
      type: "runtime_start",
      request_id: "rt2",
      agent_id: agent2,
      conversation_id: conv2,
      wait_for_replay: true,
    });
    await e.waitFor((f) => f.request_id === "rt2");
  }

  const deviceStatus = await e.waitFor((f) => f.type === "update_device_status");
  const cwd: string = deviceStatus.device_status?.current_working_directory ?? "/workspace";
  check(
    "device status carries a working directory",
    typeof cwd === "string" && cwd.length > 0,
    cwd,
  );

  // Files: write, list, read, search. get_tree returns paths RELATIVE to its
  // root, and the search parameter is `query` — both were wrong on first pass.
  const probeFile = `${cwd}/smoke-probe.md`;
  e.send({
    type: "write_file",
    request_id: "wf",
    path: probeFile,
    content: "# smoke\n\nfindable-token here\n",
  });
  const wf = await e.waitFor((f) => f.request_id === "wf");
  check("write_file succeeds", wf.success === true, wf.error);

  e.send({ type: "get_tree", request_id: "gt", path: cwd, depth: 1 });
  const gt = await e.waitFor((f) => f.request_id === "gt");
  const treePaths: string[] = (gt.entries ?? []).map((entry: any) => entry.path);
  check("get_tree lists the new file", treePaths.includes("smoke-probe.md"), treePaths);
  check(
    "get_tree paths are relative to the root",
    treePaths.every((p) => !p.startsWith("/")),
    treePaths,
  );

  e.send({ type: "read_file", request_id: "rf", path: probeFile, encoding: "utf8" });
  const rf = await e.waitFor((f) => f.request_id === "rf");
  check(
    "read_file returns content",
    typeof rf.content === "string" && rf.content.includes("findable-token"),
    rf.error,
  );

  // The chat transcript's file links go through this HTTP route, not the WS
  // file protocol. Plain: an attachment. `?inline=1` (used by message links):
  // a viewable response, but only for PDFs and images — a .md stays an
  // attachment so agent-authored markup never renders on the BFF origin.
  const dlUrl = `${ORIGIN}/api/files/download?path=${encodeURIComponent(probeFile)}`;
  const dl = await fetch(dlUrl, { headers: { cookie } });
  const dlBody = await dl.text();
  check(
    "GET /api/files/download streams the file as an attachment",
    dl.status === 200 &&
      dlBody.includes("findable-token") &&
      (dl.headers.get("content-disposition") ?? "").startsWith("attachment"),
    { status: dl.status, disposition: dl.headers.get("content-disposition") },
  );

  const dlMdInline = await fetch(`${dlUrl}&inline=1`, { headers: { cookie } });
  await dlMdInline.text();
  check(
    "inline=1 on a .md is still an octet-stream attachment",
    dlMdInline.status === 200 &&
      (dlMdInline.headers.get("content-disposition") ?? "").startsWith("attachment") &&
      (dlMdInline.headers.get("content-type") ?? "").startsWith("application/octet-stream"),
    {
      disposition: dlMdInline.headers.get("content-disposition"),
      type: dlMdInline.headers.get("content-type"),
    },
  );

  const pdfProbe = `${cwd}/smoke-probe.pdf`;
  e.send({ type: "write_file", request_id: "wfp", path: pdfProbe, content: "%PDF-1.4 smoke\n" });
  await e.waitFor((f) => f.request_id === "wfp");
  const dlPdfInline = await fetch(
    `${ORIGIN}/api/files/download?path=${encodeURIComponent(pdfProbe)}&inline=1`,
    { headers: { cookie } },
  );
  await dlPdfInline.text();
  check(
    "inline=1 on a .pdf serves application/pdf inline",
    dlPdfInline.status === 200 &&
      (dlPdfInline.headers.get("content-disposition") ?? "").startsWith("inline") &&
      (dlPdfInline.headers.get("content-type") ?? "") === "application/pdf",
    {
      disposition: dlPdfInline.headers.get("content-disposition"),
      type: dlPdfInline.headers.get("content-type"),
    },
  );

  e.send({
    type: "grep_in_files",
    request_id: "gf",
    query: "findable-token",
    cwd,
    max_results: 20,
  });
  const gf = await e.waitFor((f) => f.request_id === "gf");
  check("grep_in_files finds the token", (gf.matches?.length ?? 0) > 0, gf.error ?? gf);

  // Memory
  e.send({ type: "list_memory", request_id: "lm2", agent_id: agent2 });
  const lm2 = await e.waitFor((f) => f.request_id === "lm2");
  check(
    "list_memory returns blocks",
    (lm2.entries?.length ?? 0) > 0,
    lm2.error ?? lm2.entries?.length,
  );

  // Tasks: full CRUD round trip
  e.send({
    type: "cron_add",
    request_id: "ca",
    agent_id: agent2,
    name: "smoke task",
    description: "created by the smoke test",
    cron: "0 9 * * *",
    recurring: true,
    prompt: "say hello",
    timezone: "UTC",
  });
  const ca = await e.waitFor((f) => f.request_id === "ca");
  check("cron_add creates a task", ca.success === true && Boolean(ca.task?.id), ca.error);

  const taskId: string | undefined = ca.task?.id;
  if (taskId) {
    e.send({ type: "cron_list", request_id: "cls", agent_id: agent2 });
    const cls = await e.waitFor((f) => f.request_id === "cls");
    check(
      "cron_list includes it",
      (cls.tasks ?? []).some((t: any) => t.id === taskId),
      cls.tasks?.length,
    );

    e.send({ type: "cron_update", request_id: "cu2", task_id: taskId, name: "smoke task renamed" });
    const cu2 = await e.waitFor((f) => f.request_id === "cu2");
    check("cron_update applies", cu2.success === true, cu2.error);

    e.send({ type: "cron_delete", request_id: "cd", task_id: taskId });
    const cd = await e.waitFor((f) => f.request_id === "cd");
    check("cron_delete removes it", cd.success === true, cd.error);
  }
}

e.close();

// ── 8. Settings: providers and MCP ───────────────────────────────────────────
section("8. Settings");
const g = await openSession(cookie);
await g.waitFor((f) => f.type === "__bff_hello");

g.send({ type: "list_connect_providers", request_id: "prov", target: "local" });
const prov = await g.waitFor((f) => f.request_id === "prov");
const llama = (prov.providers ?? []).find((p: any) => p.id === "llama-cpp");
check("provider catalog loads", (prov.providers?.length ?? 0) > 0, prov.error);
check("llama.cpp is offered as a local provider", Boolean(llama), prov.providers?.length);
check(
  "connection state uses is_connected",
  llama ? typeof llama.connected?.is_connected === "boolean" : false,
  llama?.connected,
);

// MCP: one shared list, kept out of upstream's settings.json (the app-server
// rewrites that file from memory and dropped entries written from outside).
// Only /api/mcp touches it — raw file commands on either settings file are
// refused. The round trip restores whatever list was there, never an empty one.
g.send({ type: "read_file", request_id: "rs1", path: "/root/.letta/settings.json" });
const readRefused = await g.waitFor((f) => f.type === "__bff_error" && f.request_id === "rs1");
check(
  "a browser read of settings.json is refused",
  String(readRefused.message).includes("outside the workspace"),
  readRefused,
);

const mcpBefore = await fetch(`${ORIGIN}/api/mcp`, { headers: { cookie } });
check("GET /api/mcp succeeds", mcpBefore.ok, mcpBefore.status);
if (mcpBefore.ok) {
  const original = ((await mcpBefore.json()).servers ?? []) as Array<{ name: string }>;
  const put = await fetch(`${ORIGIN}/api/mcp`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      servers: [...original, { name: "smoke-mcp", transport: "stdio", command: "true", args: [] }],
    }),
  });
  check("PUT /api/mcp succeeds", put.ok, `${put.status} ${await put.text().catch(() => "")}`);

  const got = await (await fetch(`${ORIGIN}/api/mcp`, { headers: { cookie } })).json();
  const names = (got?.servers ?? []).map((server: { name: string }) => server.name);
  check(
    "GET /api/mcp reports the saved server alongside the existing ones",
    names.includes("smoke-mcp") && original.every((server) => names.includes(server.name)),
    names,
  );

  // A malformed payload is refused rather than written.
  const bad = await fetch(`${ORIGIN}/api/mcp`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ servers: [{ transport: "stdio" }] }),
  });
  check("a nameless MCP server is refused with 400", bad.status === 400, bad.status);

  const restore = await fetch(`${ORIGIN}/api/mcp`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ servers: original }),
  });
  check("smoke MCP change reverted", restore.ok, restore.status);
  const reverted = await (await fetch(`${ORIGIN}/api/mcp`, { headers: { cookie } })).json();
  check(
    "the original MCP servers are back",
    JSON.stringify(reverted?.servers ?? []) === JSON.stringify(original),
    reverted?.servers,
  );
}

// ── Settings → Web ─────────────────────────────────────────────────────────
// Native web_search / fetch_webpage (bff/src/web-tools/). The mod calls the
// BFF over loopback only; from here (not loopback) that route must not exist.
section("Settings → Web");
{
  const internal = await fetch(`${ORIGIN}/internal/web-tools/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "smoke" }),
  });
  check(
    "the mod's internal route is invisible from outside (404)",
    internal.status === 404,
    internal.status,
  );
  for (const tool of ["web_search", "gmail_send", "mcp_call_write"]) {
    const outside = await fetch(`${ORIGIN}/internal/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    check(
      `/internal/tools/${tool} is invisible from outside (404)`,
      outside.status === 404,
      outside.status,
    );
  }

  const native = await fetch(`${ORIGIN}/api/native-tools`, { headers: { cookie } });
  const nativeBody = native.ok ? await native.json() : null;
  check(
    "GET /api/native-tools reports Google tools and bridged servers",
    Array.isArray(nativeBody?.google) && Array.isArray(nativeBody?.bridge?.servers),
    nativeBody,
  );

  const status = await fetch(`${ORIGIN}/api/web-tools/status`, { headers: { cookie } });
  check("GET /api/web-tools/status succeeds", status.ok, status.status);
  const current = status.ok ? await status.json() : null;
  check("the web-tools mod is installed", current?.modInstalled === true, current);
  check(
    "the mod loaded without errors",
    (current?.modErrors ?? []).length === 0,
    current?.modErrors,
  );
  check("SearXNG answers", current?.searxng === "up", current);

  const search = await fetch(`${ORIGIN}/api/web-tools/test`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ query: "letta code agent" }),
  });
  const answer = search.ok ? await search.json() : null;
  check(
    "a test search returns results",
    answer?.isError === false &&
      /^Web results for|Found \d+ search results/m.test(answer?.text ?? ""),
    answer,
  );

  const before = await (
    await fetch(`${ORIGIN}/api/web-tools/settings`, { headers: { cookie } })
  ).json();
  const flip = await fetch(`${ORIGIN}/api/web-tools/settings`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: !before.settings.enabled }),
  });
  check("PUT /api/web-tools/settings succeeds", flip.ok, flip.status);
  const bad = await fetch(`${ORIGIN}/api/web-tools/settings`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  check("a malformed switch is refused with 400", bad.status === 400, bad.status);
  const restore = await fetch(`${ORIGIN}/api/web-tools/settings`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: before.settings.enabled }),
  });
  check("the web-tools switch is restored", restore.ok, restore.status);

  const mcp = await (await fetch(`${ORIGIN}/api/mcp`, { headers: { cookie } })).json();
  check(
    "the seeded duckduckgo MCP server is retired",
    !(mcp?.servers ?? []).some(
      (server: { name: string; url?: string }) =>
        server.name === "duckduckgo" && server.url === "http://ddg-mcp:8000/mcp",
    ),
    mcp?.servers,
  );
}

// ── Settings → Google Workspace ───────────────────────────────────────────────────────
// Read-only, apart from one refused write: connecting needs a human at Google's
// consent screen. What must hold is that the status never leaks the client
// secret, and that a dev-bypass deployment refuses changes (an agent could
// otherwise sign itself in through the bypass and widen its own access).
section("Settings → Google Workspace");
const googleRes = await fetch(`${ORIGIN}/api/google`, { headers: { cookie } });
check("GET /api/google succeeds", googleRes.ok, googleRes.status);
const googleText = googleRes.ok ? await googleRes.text() : "";
const googleStatus = googleText ? JSON.parse(googleText) : null;
check(
  "the client secret is never sent to a browser",
  !googleText.includes('clientSecret"'),
  googleStatus?.settings && Object.keys(googleStatus.settings),
);
if (googleStatus && googleStatus.writable === false) {
  const refused = await fetch(`${ORIGIN}/api/google`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  check("dev-bypass sessions cannot change Google access", refused.status === 403, refused.status);
}
if (googleStatus?.settings?.serving) {
  check("the Google sidecar answers while serving", googleStatus.sidecarUp === true, googleStatus);
}

// channel_* is off the allowlist on purpose: the app-server never dispatches
// those commands to a WebSocket client, so allowing them would hang.
g.send({ type: "channels_list", request_id: "chan" });
const chanRefusal = await g.waitFor((f) => f.type === "__bff_error" && f.request_id === "chan");
check(
  "channel commands are refused rather than left hanging",
  chanRefusal.message.includes("not permitted"),
  chanRefusal,
);

g.close();

// ── 9. Backpressure ──────────────────────────────────────────────────────────
section("9. Rate limiting");
const h = await openSession(cookie);
await h.waitFor((f) => f.type === "__bff_hello");

// The app-server applies no backpressure and a client render loop once OOM'd
// it. A flood must be stopped here, at the session boundary.
for (let i = 0; i < 200; i += 1) {
  h.send({ type: "agent_list", request_id: `flood-${i}`, query: { limit: 1 } });
}
const throttled = await h.waitFor(
  (f) => f.type === "__bff_error" && String(f.message).includes("Rate limit"),
);
check("a command flood is throttled at the BFF", Boolean(throttled), throttled?.message);

// The upstream connection must be unharmed by the flood.
const afterFlood = await status(cookie);
check(
  "upstream survived the flood",
  afterFlood.upstream.state === "connected",
  afterFlood.upstream,
);
check(
  "upstream socket was not recycled by the flood",
  afterFlood.upstream.generation === 1,
  afterFlood.upstream.generation,
);

h.close();

// ── 10. Unauthenticated access is refused ────────────────────────────────────
section("10. Authentication");
// Signed out is accepted and then closed with 4401, not refused: a refused
// upgrade reaches a browser as a bare 1006, indistinguishable from offline, and
// the app sat on "Reconnecting…" forever. The socket never joins the registry.
const anon = await new Promise<{ code: number; first: string | null }>((resolve) => {
  const socket = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/ws`);
  let first: string | null = null;
  socket.onmessage = (event) => {
    first ??= String(event.data);
  };
  socket.onclose = (event) => resolve({ code: event.code, first });
  setTimeout(() => resolve({ code: -1, first }), 5000);
});
check("unauthenticated /ws is closed with 4401", anon.code === 4401, anon);
check(
  "and told why before the close",
  anon.first !== null && JSON.parse(anon.first).type === "__bff_auth_required",
  anon.first,
);

// An anonymous /api/status must not fingerprint the deployment. The signed-in
// payload carries the running letta-code version, backend kind, protocol
// version and session count; none of that belongs to an unauthenticated caller.
const anonStatus = await (await fetch(`${ORIGIN}/api/status`)).json();
check(
  "anonymous /api/status reports only what a sign-in screen needs",
  anonStatus.authenticated === false &&
    typeof anonStatus.signin === "string" &&
    anonStatus.upstream === undefined &&
    anonStatus.sessions === undefined &&
    anonStatus.latest_seq === undefined &&
    anonStatus.user === undefined,
  anonStatus,
);

const authStatus = await (await fetch(`${ORIGIN}/api/status`, { headers: { cookie } })).json();
check(
  "a signed-in /api/status still reports the operational detail",
  authStatus.authenticated === true &&
    authStatus.upstream?.state === "connected" &&
    typeof authStatus.latest_seq === "number",
  authStatus,
);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
