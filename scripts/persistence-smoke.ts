/**
 * Acceptance test for the invariant the whole architecture rests on:
 * a browser session disappearing must NOT disturb the app-server.
 *
 * See AGENTS.md — the app-server cancels in-flight turns, drops queued messages
 * and rejects pending approvals for a connection that closes. Browser sockets
 * close constantly (tab switch, phone sleep), so they must never be the
 * connection the app-server knows about.
 *
 * Usage: bun scripts/persistence-smoke.ts [bffOrigin] [--allow-stale-build]
 *
 * It proves the invariant against the build this checkout produced: every case
 * here is about what the running BFF does, so scoring a bundle from before the
 * branch is worse than not running it.
 */

import { MAX_REPLAY_FRAMES } from "../bff/src/session/buffer.ts";
import {
  type BffSession,
  devSignIn,
  driveTurn,
  openBffSession,
  parseArgs,
  requireServedBuild,
} from "./harness.ts";

const { origin: ORIGIN, staleBuild } = parseArgs(process.argv.slice(2));

await requireServedBuild(ORIGIN, staleBuild);

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

/** Whatever method this stack signs in with — the shared helper reads the mode. */
async function login(): Promise<string> {
  return devSignIn(ORIGIN);
}

/** The few `/api/status` fields this suite asserts on, typed instead of `any`. */
interface StatusBody {
  sessions: number;
  /** `generation` counts upstream socket re-establishments — the invariant this suite asserts. */
  upstream: { state: string; generation: number };
}

async function status(cookie?: string): Promise<StatusBody> {
  return (
    await fetch(`${ORIGIN}/api/status`, cookie ? { headers: { cookie } } : undefined)
  ).json() as Promise<StatusBody>;
}

/** The shared frame-capturing BFF session, typed once in `scripts/harness.ts`. */
type Session = BffSession;

/**
 * A frame as it arrives: a flat object of fields this suite reads one at a time.
 *
 * This used to be `any` in one place and radiated out from there, so every read
 * compiled whether or not the field existed — a rename upstream turns into a check
 * that compares `undefined` to `undefined` instead of a red line. Each reader
 * below returns what the old `undefined` would have collapsed to, so the checks
 * behave exactly as they did.
 */
type Frame = Record<string, unknown>;

/** The string a frame field holds; "" when it holds anything else. */
const str = (frame: Frame, key: string): string =>
  typeof frame[key] === "string" ? (frame[key] as string) : "";
/** The number a frame field holds; undefined when it holds anything else. */
const num = (frame: Frame, key: string): number | undefined =>
  typeof frame[key] === "number" ? (frame[key] as number) : undefined;
/** A nested record on a frame (`conversation`, `device_status`, `connected`). */
const obj = (frame: Frame, key: string): Frame | undefined => {
  const value = frame[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Frame)
    : undefined;
};
/** A list of records on a frame (`agents`, `entries`, `tasks`), empty when it is not one. */
const list = (frame: Frame, key: string): Frame[] =>
  Array.isArray(frame[key]) ? (frame[key] as Frame[]) : [];
/** The id of the first record in a list field — `agents[0].id`. */
const firstId = (frame: Frame, key: string): string | undefined => {
  const id = list(frame, key)[0]?.id;
  return typeof id === "string" ? id : undefined;
};
/** The id of a nested record — `conversation.id`, `task.id`. */
const nestedId = (frame: Frame, key: string): string | undefined => {
  const id = obj(frame, key)?.id;
  return typeof id === "string" ? id : undefined;
};

const openSession = (cookie: string): Promise<Session> => openBffSession(ORIGIN, cookie);

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
check("upstream is connected", hello.upstream === "connected", str(hello, "upstream"));

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
  str(denied, "message").includes("not permitted"),
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
if ((num(stale, "latest_seq") ?? Number.POSITIVE_INFINITY) <= MAX_REPLAY_FRAMES) {
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
const agentId: string | undefined = firstId(agents, "agents");
check("at least one agent exists", typeof agentId === "string", list(agents, "agents").length);

if (agentId) {
  d.send({ type: "conversation_create", request_id: "conv", body: { agent_id: agentId } });
  // Cold app-servers answer this slowly on purpose: at connect the BFF subscribes
  // to every (agent, conversation) scope it knows, and on an install with 100+
  // conversations that flood sits ahead of every command in the queue. Measured
  // 20-25 s at 134 conversations; a warm answer is ~0.2 s.
  const created = await d.waitFor((f) => f.request_id === "conv", 45_000);
  const conversationId: string | undefined = nestedId(created, "conversation");
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
      obj(renamed, "conversation")?.summary === "Smoke test",
      obj(renamed, "conversation")?.summary,
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
      obj(archived, "conversation")?.archived === true,
      obj(archived, "conversation"),
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
check(
  "model catalog is available",
  list(models, "entries").length > 0,
  list(models, "entries").length,
);

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
const agent2: string | undefined = firstId(ag2, "agents");

if (agent2) {
  e.send({ type: "conversation_list", request_id: "cl2", query: { agent_id: agent2, limit: 5 } });
  const cl2 = await e.waitFor((f) => f.request_id === "cl2");
  const conv2: string | undefined = firstId(cl2, "conversations");

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
  const cwdField = obj(deviceStatus, "device_status")?.current_working_directory;
  const hasCwd = typeof cwdField === "string" && cwdField.length > 0;
  const cwd: string = hasCwd ? (cwdField as string) : "/workspace";
  check("device status carries a working directory", hasCwd, cwdField);

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
  const treePaths: string[] = list(gt, "entries").map((entry) => str(entry, "path"));
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
  check("grep_in_files finds the token", list(gf, "matches").length > 0, gf.error ?? gf);

  // Memory
  e.send({ type: "list_memory", request_id: "lm2", agent_id: agent2 });
  const lm2 = await e.waitFor((f) => f.request_id === "lm2");
  check(
    "list_memory returns blocks",
    list(lm2, "entries").length > 0,
    lm2.error ?? list(lm2, "entries").length,
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
  check("cron_add creates a task", ca.success === true && Boolean(nestedId(ca, "task")), ca.error);

  const taskId: string | undefined = nestedId(ca, "task");
  if (taskId) {
    e.send({ type: "cron_list", request_id: "cls", agent_id: agent2 });
    const cls = await e.waitFor((f) => f.request_id === "cls");
    check(
      "cron_list includes it",
      list(cls, "tasks").some((task) => task.id === taskId),
      list(cls, "tasks").length,
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
const llama = list(prov, "providers").find((p) => p.id === "llama-cpp");
check("provider catalog loads", list(prov, "providers").length > 0, prov.error);
check("llama.cpp is offered as a local provider", Boolean(llama), list(prov, "providers").length);
const llamaConnected = llama ? obj(llama, "connected")?.is_connected : undefined;
check(
  "connection state uses is_connected",
  typeof llamaConnected === "boolean",
  llama ? obj(llama, "connected") : undefined,
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
  str(chanRefusal, "message").includes("not permitted"),
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

// ── 11. Turn settling (scripted provider) ───────────────────────────────────
// A scripted OpenAI-compatible endpoint answers with a complete SSE chat
// completion and then **holds the response open** after `data: [DONE]` — the
// local-turn analogue of the stall upstream fixed on the Cloud path (#5847).
// The local backend's SDK honors `[DONE]` and must settle without body EOF: the
// shared harness turn-driver sends a real message through a throwaway agent
// wired to it, and the turn must settle end-to-end — `turn_finished` arrives
// and the answer is stored — while the socket is still open. If an SDK or
// adapter change ever regresses to waiting for EOF, the 180 s bound goes red.
// Needs no real model on the machine, so it runs on every host that runs the
// suite.
section("11. Turn settling (scripted provider)");
const PROBE_PREFIX = "smoke-settle";
const PROBE_MODEL = `${PROBE_PREFIX}/probe`;
const settleCookie = cookie;

// The app-server dials the baseUrl from inside its container, so the host must
// be reachable from there: docker's host alias, or an override for hosts that
// resolve it differently. No literal address is stored here (check-prod-info).
const hostAddress = process.env.SMOKE_HOST_ADDRESS ?? "host.docker.internal";
let probeServer: ReturnType<typeof Bun.serve> | undefined;
let settleSession: BffSession | undefined;
let settleAgentId: string | undefined;

function sseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

try {
  probeServer = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "probe", object: "model" }] });
      }
      if (path === "/v1/chat/completions") {
        const body = (await req.json()) as { stream?: boolean };
        if (!body.stream) {
          return Response.json({
            choices: [
              { message: { role: "assistant", content: "SETTLE-OK" }, finish_reason: "stop" },
            ],
          });
        }
        // A complete completion, then the real `data: [DONE]` sentinel (raw,
        // NOT JSON-quoted — the SDK's iterator only terminates on the exact
        // sentinel), then the body is deliberately held open. Settling must
        // not depend on reading further.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                sseFrame({
                  choices: [{ index: 0, delta: { content: "SETTLE" }, finish_reason: null }],
                }),
              );
              controller.enqueue(
                sseFrame({
                  choices: [{ index: 0, delta: { content: "-OK" }, finish_reason: null }],
                }),
              );
              controller.enqueue(
                sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
              );
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              // No controller.close(): the response stays open on purpose.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const probePort = probeServer.port;

  const reg = await fetch(`${ORIGIN}/api/providers`, {
    method: "POST",
    headers: { cookie: settleCookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: PROBE_PREFIX,
      type: "llama-cpp",
      baseUrl: `http://${hostAddress}:${probePort}/v1`,
      models: ["probe"],
    }),
  });
  check("the scripted provider registers", reg.ok, await reg.text());

  const w = await openSession(cookie);
  settleSession = w;
  const helloW = await w.waitFor((f) => str(f, "type") === "__bff_hello");
  check(
    "the settle session sees a connected upstream",
    str(helloW, "upstream") === "connected",
    helloW,
  );

  w.send({
    type: "create_agent",
    request_id: "settle-agent",
    personality: "blank",
    model: PROBE_MODEL,
    pin_global: false,
  });
  const madeAgent = await w.waitFor((f) => f.request_id === "settle-agent", 30_000);
  settleAgentId =
    (madeAgent.agent as { id?: string } | undefined)?.id ??
    (str(madeAgent, "agent_id") || undefined);
  check("a throwaway agent is created on the scripted model", Boolean(settleAgentId), madeAgent);

  if (settleAgentId) {
    w.send({
      type: "conversation_create",
      request_id: "settle-conv",
      body: { agent_id: settleAgentId },
    });
    const madeConv = await w.waitFor((f) => f.request_id === "settle-conv");
    const settleConvId: string =
      ((madeConv.conversation as { id?: string } | undefined)?.id as string) ?? "";
    check("a throwaway conversation opens", settleConvId !== "", madeConv);

    if (settleConvId) {
      const scope = { agent_id: settleAgentId, conversation_id: settleConvId };
      w.send({ type: "runtime_start", request_id: "settle-start", ...scope });
      const startedW = await w.waitFor((f) => f.request_id === "settle-start", 60_000);
      check("runtime_start on the scripted model succeeds", startedW.success === true, startedW);

      const { frame: settleFrame } = await driveTurn(
        w,
        scope,
        "Reply with exactly: SETTLE-OK",
        180_000,
      );
      check(
        "the turn settles with turn_finished while the provider still holds the body open",
        str(settleFrame, "type") === "turn_finished",
        settleFrame,
      );

      w.send({
        type: "conversation_messages_list",
        request_id: "settle-hist",
        conversation_id: settleConvId,
        query: { limit: 20 },
      });
      const histW = await w.waitFor((f) => f.request_id === "settle-hist");
      const stored = JSON.stringify(histW.messages ?? []);
      check(
        "the scripted answer is stored in the conversation",
        stored.includes("SETTLE-OK"),
        stored.slice(0, 300),
      );
    }
  }
} finally {
  // Everything the section added comes down on every path — including the one
  // it exists to catch: a turn that never settles rejects inside `try`, and a
  // throwaway agent left behind would haunt the Agent list with a model whose
  // provider is already gone. Agent first, then provider, then the server.
  if (settleSession && settleAgentId) {
    try {
      settleSession.send({
        type: "agent_delete",
        request_id: "settle-del",
        agent_id: settleAgentId,
      });
      const delW = await settleSession.waitFor((f) => f.request_id === "settle-del", 30_000);
      check("the throwaway agent is deleted again", delW.success === true, delW);
    } catch {
      check("the throwaway agent is deleted again", false, "no delete response before timeout");
    }
    settleSession.close();
  } else if (settleSession) {
    settleSession.close();
  }
  const del = await fetch(`${ORIGIN}/api/providers?prefix=${PROBE_PREFIX}`, {
    method: "DELETE",
    headers: { cookie: settleCookie },
  });
  // 200 with `removed: false` also answers when nothing matched — assert the
  // removal itself, or "left as found" proves nothing.
  const delBody = (await del.json().catch(() => null)) as { removed?: boolean } | null;
  check(
    "the scripted provider is removed again (stack left as found)",
    del.ok && delBody?.removed === true,
    { status: del.status, body: delBody },
  );
  // Force it: the app-server's chat response is still parked open on purpose.
  probeServer?.stop(true);
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
