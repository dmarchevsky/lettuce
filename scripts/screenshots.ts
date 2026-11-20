/**
 * Generates the README's screenshots from synthetic data: desktop chat, phone
 * chat and the desktop Settings pane.
 *
 * Why a mock upstream rather than the real stack: a README image is public, and
 * every screenshot taken off a live install carries that install's truth — the
 * operator's real email in the About panel, their agent names, their
 * conversation titles, and whatever the auth mode happens to say. Those are
 * not things you can review out of a PNG after it has been published. Here the
 * only data the app can render is the fixture below, so the output is safe by
 * construction rather than by inspection.
 *
 * The mock answers the browser client's own contract (see
 * `web/src/lib/session-client.ts`): the client resolves a request purely by
 * `request_id`, so a server that echoes the id back with a canned payload
 * drives the real UI without the BFF, the app-server, Docker, or a model.
 *
 * Usage: bun run screenshots [--shot <names>] [--fixture <file.json>] [--list] [outputDir]
 * Requires: `bun run build` first (serves web/dist), and a Chromium build.
 *
 * `--shot` picks which images to render (comma-separated substring; `--list`
 * prints the names), because diagnosing one fixture crash used to mean rendering
 * all three every time. An app-server route this mock does not model is a hard
 * failure, not an empty object: see `unmodeledRoutes`.
 *
 * ## Injecting fixture data (--fixture)
 *
 * Proving a surface at scale — what does the Memory pane do with 178 files in 73
 * folders — used to mean forking this file and editing its fixture by hand, which
 * is a fork that has to be redone every time the built-in fixture moves. --fixture
 * <file.json> is the supported way instead: the file's entries are merged over
 * what the built-in fixture would have answered, and nothing on disk changes.
 *
 * ```json
 * {
 *   "ws":   { "list_memory": { "entries": [ … ], "memfs_enabled": true } },
 *   "http": { "/api/pi/runs": { "runs": [ … ], "other": 0 } }
 * }
 * ```
 *
 * `ws` is keyed by app-server command `type`, `http` by pathname. A key with a
 * trailing `/` matches a prefix (`"/api/codex/": …`). The value merges ONE level
 * deep into the built-in response — so `{"prompt": "x"}` on `/api/status` keeps
 * every other field — and a value that is an array, a scalar or a route the
 * built-in fixture does not model replaces it whole (which also means the
 * unmodelled-route failure does not fire for a route the caller supplied).
 * Everything else about the run is unchanged: same build, same hermetic mock, no
 * live stack — so a generated PNG is still public-safe by construction.
 *
 * The shots marked *(opt-in)* render only when named with `--shot`, so a plain
 * `bun run screenshots` still writes exactly the README's images.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { openPane, parseArgs } from "./harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB_DIST = join(ROOT, "web", "dist");
const {
  positional,
  shots: SHOT_FILTER,
  list: LIST,
  fixture: FIXTURE_FILE,
} = parseArgs(process.argv.slice(2), "");
const OUT_DIR = positional === "" ? join(ROOT, "docs", "images") : positional;

const SHOTS = [
  { name: "desktop-chat", label: "desktop chat: the transcript and the composer" },
  { name: "mobile-chat", label: "phone chat at 390px" },
  { name: "desktop-settings", label: "desktop Settings, opened on the providers section" },
  {
    name: "agent-memory",
    label: "the Memory pane over whatever --fixture injected (opt-in: not a README image)",
    optIn: true,
  },
];

/**
 * Which shots this run renders. A filter that matches nothing is an error, not a
 * green run that rendered nothing: `--shot chat` and `--shot chats` look the same
 * to type and only one of them is a picture. With no filter, opt-in shots stay
 * unrendered — the README's set is exactly the three above it.
 */
const chosen = SHOTS.filter((shot) =>
  SHOT_FILTER.length === 0 ? !shot.optIn : SHOT_FILTER.some((needle) => shot.name.includes(needle)),
);

/**
 * App-server routes the client asked for and this mock does not model.
 *
 * The old behaviour was to answer `{}` to anything unmapped, which is how the
 * generator died on main with nobody noticing: the Runs chip read a field off an
 * empty object, the React tree threw, and the run still wrote its PNGs and exited
 * as if it had worked. A fixture that rots silently is worse than no fixture, so
 * an unmapped route is now a 500 that names itself, the render fails, and what is
 * missing is stated rather than inferred from a blank panel.
 */
const unmodeledRoutes = new Set<string>();

if (SHOT_FILTER.length > 0 && chosen.length === 0) {
  console.error(
    `✗ --shot ${SHOT_FILTER.join(",")} selected nothing. The shots are:\n` +
      SHOTS.map((shot) => `   - ${shot.name}`).join("\n"),
  );
  process.exit(1);
}
const render = new Set(chosen.map((shot) => shot.name));

// ── Injected fixture ───────────────────────────────────────────────────────

/**
 * What --fixture may supply: see the header for the merge rule.
 *
 * A payload is an object (merged one level deep over the built-in response) or an
 * array (replaces it whole) — those are the only two things a route's body can be,
 * and anything else is a typo worth refusing at boot rather than rendering.
 */
type FixturePayload = Record<string, unknown> | unknown[];
interface FixtureOverrides {
  ws?: Record<string, FixturePayload>;
  http?: Record<string, FixturePayload>;
}

const isPayload = (value: unknown): value is FixturePayload =>
  typeof value === "object" && value !== null;

function readFixture(file: string): FixtureOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `--fixture ${file} is not readable JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--fixture ${file} must hold an object with "ws" and/or "http" keys.`);
  }
  const routes = (value: unknown, key: string): Record<string, FixturePayload> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`--fixture ${file}: "${key}" must be an object of route → payload.`);
    const out: Record<string, FixturePayload> = {};
    for (const [route, payload] of Object.entries(value)) {
      if (!isPayload(payload))
        throw new Error(`--fixture ${file}: ${key}["${route}"] must be an object or an array.`);
      out[route] = payload;
    }
    return out;
  };
  const { ws, http } = parsed as { ws?: unknown; http?: unknown };
  return { ws: routes(ws, "ws"), http: routes(http, "http") };
}

const FIXTURE: FixtureOverrides = FIXTURE_FILE ? readFixture(FIXTURE_FILE) : {};

/** One level deep: the override's own keys win; a non-object override replaces. */
function mergeOnto(base: Record<string, unknown>, override: FixturePayload): FixturePayload {
  return isPayload(override) && !Array.isArray(override) && !Array.isArray(base)
    ? { ...base, ...override }
    : override;
}

/** `"/api/codex/"` covers any pathname under it; any other key is exact. */
function httpOverrideFor(pathname: string): FixturePayload | null {
  let found: FixturePayload | null = null;
  for (const [route, value] of Object.entries(FIXTURE.http ?? {})) {
    if (route.endsWith("/") ? pathname.startsWith(route) : pathname === route) found = value;
  }
  return found;
}

function wsOverrideFor(type: string): FixturePayload | null {
  return FIXTURE.ws?.[type] ?? null;
}

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/**
 * The upstream release this tree pins, read out of `VERSION` (`v<x.y.z>-letta_<v>`)
 * so the fixture cannot drift from the stack it is meant to look like.
 */
const LETTA_CODE_VERSION =
  readFileSync(join(ROOT, "VERSION"), "utf8")
    .match(/-letta_(.+)$/)?.[1]
    ?.trim() ?? "0.0.0";

const AGENT_ASSISTANT = "agent-01";
const AGENT_RESEARCH = "agent-02";
const CONVERSATION_TRIP = "conv-01";

// ── Fixture ────────────────────────────────────────────────────────────────
// Everything below is invented. No real addresses, hostnames, paths, or
// project names — keep it that way, because this file's output is published.

const APP_SERVER_INFO = {
  backend: "local",
  letta_code_version: LETTA_CODE_VERSION,
  protocol_version: 2,
  capabilities: {
    agent_management: true,
    conversation_management: true,
    memory_management: true,
    runtime_start: true,
    launch_subagent: true,
    runtime_workspace_sandbox: false,
    runtime_external_tools_update: true,
    structured_outputs: true,
    split_channels: false,
  },
};

const AGENTS = [
  { id: AGENT_ASSISTANT, name: "Assistant" },
  { id: AGENT_RESEARCH, name: "Research" },
];

const CONVERSATIONS: Record<string, unknown[]> = {
  [AGENT_ASSISTANT]: [
    {
      id: CONVERSATION_TRIP,
      summary: "Lisbon trip planning",
      archived: false,
      updated_at: "2026-09-28T15:20:00Z",
    },
    {
      id: "conv-02",
      summary: "Weekly review",
      archived: false,
      updated_at: "2026-09-27T09:05:00Z",
    },
    {
      id: "conv-03",
      summary: "Reading list",
      archived: false,
      updated_at: "2026-09-25T18:40:00Z",
    },
  ],
  [AGENT_RESEARCH]: [
    {
      id: "conv-04",
      summary: "Transit options",
      archived: false,
      updated_at: "2026-09-26T11:15:00Z",
    },
  ],
};

/**
 * Newest first, matching how `conversation_messages_list` paginates —
 * `transcriptFromHistory` reverses the array before applying it.
 */
const MESSAGES: Record<string, unknown[]> = {
  [CONVERSATION_TRIP]: [
    {
      id: "msg-05",
      message_type: "assistant_message",
      date: "2026-09-28T15:20:00Z",
      content:
        "Here's a workable three-day plan for the first week of October:\n\n" +
        "- **Day 1** — Alfama and the miradouro loop, dinner in Graça\n" +
        "- **Day 2** — Belém in the morning, LX Factory after lunch\n" +
        "- **Day 3** — Day trip to Sintra; book the palace tickets ahead\n\n" +
        "Weather that week should be 22-24°C with maybe one rainy day, so I put " +
        "the indoor stops on day 2. I saved the full itinerary to " +
        "`lisbon-itinerary.md` in your workspace.",
    },
    {
      id: "msg-04",
      message_type: "assistant_message",
      date: "2026-09-28T15:19:30Z",
      content:
        "Flights from your home airport are cheapest midweek, so I aimed for " +
        "Tuesday to Friday. Two things worth knowing before you book.",
    },
    {
      id: "msg-03",
      message_type: "tool_return_message",
      date: "2026-09-28T15:19:10Z",
      tool_call_id: "call-01",
      status: "success",
      tool_return: "6 results: October averages 23C, 8 rainy days, sea 19C.",
    },
    {
      id: "msg-02",
      message_type: "tool_call_message",
      date: "2026-09-28T15:19:05Z",
      tool_call: {
        name: "web_search",
        tool_call_id: "call-01",
        arguments: '{"query":"Lisbon weather first week of October"}',
      },
    },
    {
      id: "msg-01",
      message_type: "user_message",
      date: "2026-09-28T15:18:40Z",
      content:
        "Plan three days in Lisbon for the first week of October. I like walking, " +
        "food markets, and one day trip. Keep it relaxed.",
    },
  ],
};

const CRON_TASKS = [
  {
    id: "cron-01",
    conversation_id: CONVERSATION_TRIP,
    name: "Morning briefing",
    description: "Daily 07:00",
    cron: "0 7 * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "Summarise overnight email and today's calendar.",
    status: "active",
    last_fired_at: "2026-09-28T07:00:00Z",
    fire_count: 42,
    scheduled_for: "2026-09-29T07:00:00Z",
    last_run_outcome: "success",
    last_run_error: null,
  },
  {
    id: "cron-02",
    conversation_id: "conv-02",
    name: "Weekly review",
    description: "Fridays 18:00",
    cron: "0 18 * * 5",
    timezone: "UTC",
    recurring: true,
    prompt: "Draft a review of what got done this week.",
    status: "active",
    last_fired_at: "2026-09-26T18:00:00Z",
    fire_count: 11,
    scheduled_for: "2026-10-03T18:00:00Z",
    last_run_outcome: "success",
    last_run_error: null,
  },
  {
    id: "cron-03",
    conversation_id: "conv-03",
    name: "Inbox tidy",
    description: "Mondays 21:00 (paused)",
    cron: "0 21 * * 1",
    timezone: "UTC",
    recurring: true,
    prompt: "Archive read newsletters and flag anything unanswered.",
    status: "paused",
    last_fired_at: "2026-09-15T21:00:00Z",
    fire_count: 4,
    scheduled_for: null,
    last_run_outcome: null,
    last_run_error: null,
  },
];

const MODELS = [
  {
    id: "llama/qwen3-32b",
    handle: "llama/qwen3-32b",
    label: "Qwen3 32B (local)",
    description: "Served by llama.cpp on this machine",
  },
  {
    id: "llama/llama-3.1-8b",
    handle: "llama/llama-3.1-8b",
    label: "Llama 3.1 8B (local)",
    description: "Fast local model for short turns",
  },
  {
    id: "ollama/gemma3-12b",
    handle: "ollama/gemma3-12b",
    label: "Gemma 3 12B (Ollama)",
    description: "Served by Ollama on this machine",
  },
];

/**
 * Settings → Providers & models shows a configured endpoint, not the empty
 * state: the shape is `Provider` from `web/src/lib/provider-registry.ts`, and
 * the README's Settings shot should read as a working install.
 */
const PROVIDERS = [
  {
    // The provider's name is its handle prefix (`llama` → `llama/qwen3-32b`), so
    // these model ids are the bare half of the handles in MODELS: claimed by the
    // row instead of landing under "Other models".
    prefix: "llama",
    name: "llama",
    type: "llama-cpp",
    api: "openai-completions",
    scope: "local",
    baseUrl: "http://host.docker.internal:8080/v1",
    models: ["qwen3-32b", "llama-3.1-8b"],
    hasKey: false,
    headerNames: [],
  },
  {
    prefix: "ollama",
    name: "ollama",
    type: "ollama",
    api: "ollama",
    scope: "local",
    baseUrl: "http://host.docker.internal:11434",
    models: ["gemma3-12b"],
    hasKey: false,
    headerNames: [],
  },
];

// ── Protocol mock ──────────────────────────────────────────────────────────

/** The reply for one inbound app-server command, keyed by its request id. */
function respondTo(command: Record<string, unknown>): FixturePayload {
  const built = builtinResponseTo(command);
  const override = wsOverrideFor(String(command.type));
  return override === null || !isPayload(built)
    ? built
    : mergeOnto(built as Record<string, unknown>, override);
}

function builtinResponseTo(command: Record<string, unknown>): Record<string, unknown> {
  const requestId = command.request_id;
  const type = command.type;
  const base = { request_id: requestId, success: true };

  switch (type) {
    case "agent_list":
      return { ...base, type: "agent_list_response", agents: AGENTS };
    case "conversation_list": {
      const agentId = String(command.agent_id ?? AGENT_ASSISTANT);
      return {
        ...base,
        type: "conversation_list_response",
        conversations: CONVERSATIONS[agentId] ?? [],
      };
    }
    case "conversation_messages_list": {
      const conversationId = String(command.conversation_id ?? CONVERSATION_TRIP);
      return {
        ...base,
        type: "conversation_messages_list_response",
        messages: MESSAGES[conversationId] ?? [],
      };
    }
    case "conversation_retrieve":
      // What the composer's model button and the model picker mark as current.
      return {
        ...base,
        type: "conversation_retrieve_response",
        conversation: { id: CONVERSATION_TRIP, model: "llama/qwen3-32b" },
      };
    case "list_models":
      return {
        ...base,
        type: "list_models_response",
        entries: MODELS,
        available_handles: MODELS.map((model) => model.handle),
      };
    case "cron_list":
      return { ...base, type: "cron_list_response", tasks: CRON_TASKS };
    case "app_server_info":
      return { ...base, type: "app_server_info_response", ...APP_SERVER_INFO };
    default:
      // Anything the UI asks for that this mock does not model: answer rather
      // than hang, so a missing case shows up as an empty panel instead of a
      // 30-second timeout in the screenshot run.
      return { ...base, type: `${String(type)}_response` };
  }
}

// ── HTTP + WS server ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function serveStatic(pathname: string): Response | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = join(WEB_DIST, relative);
  // Refuse anything that escapes the build directory.
  if (!file.startsWith(WEB_DIST) || !existsSync(file)) return null;
  const body = Bun.file(file);
  return new Response(body, {
    headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
  });
}

/** A URL this server cannot parse names no route, and that is not an error. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

async function handleHttp(request: Request): Promise<Response> {
  const built = await builtinHttp(request);
  const pathname = pathnameOf(request.url);
  const override = httpOverrideFor(pathname);
  if (override === null) return built;
  // A route the caller supplied IS modelled, even if the built-in fixture never
  // heard of it — otherwise the run would fail for the gap it just filled.
  unmodeledRoutes.delete(pathname);
  if (built.status !== 200) return json(override);
  const body = (await built
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return json(mergeOnto(body, override));
}

async function builtinHttp(request: Request): Promise<Response> {
  const pathname = pathnameOf(request.url);

  if (pathname === "/api/status") {
    // access + signin drive the About panel's "Sign-in" row and Settings →
    // Access. "cf-access" reads as a real deployment; "none" would print
    // "not authenticated".
    return json({
      authenticated: true,
      access: "cloudflared",
      signin: "cf-access",
      setup_required: false,
      user: { email: "you@example.com" },
      upstream: {
        state: "connected",
        info: APP_SERVER_INFO,
        generation: 1,
      },
      sessions: 1,
      latest_seq: 12,
    });
  }

  if (pathname === "/api/providers") {
    // A configured provider, so Settings opens on a working install rather than
    // on "no providers yet". `types` stays empty: it only fills the Add form's
    // type menu, which no shot opens.
    return json({ types: [], providers: PROVIDERS, connections: {} });
  }
  if (pathname === "/api/agents/flags") {
    // Faces, so the rail and the header are not two hash-coloured letters: a
    // chosen glyph and tint are what the real pref store holds.
    return json({
      pinned: [],
      archived: [],
      avatars: {
        // Bold silhouettes on a tint they contrast with: at the rail's ~13px a
        // pale glyph on a pale tint reads as a letter, which is the whole thing
        // these faces exist to avoid.
        [AGENT_ASSISTANT]: { glyph: "🥬", tint: "#db4b4b" },
        [AGENT_RESEARCH]: { glyph: "📚", tint: "#e0af68" },
      },
    });
  }
  if (pathname === "/api/turn-errors") return json({ errors: [] });
  if (pathname === "/api/turn-usage") {
    // The real shape is `TurnUsage` (web/src/lib/usage.ts), and `readTurnUsage`
    // refuses anything without numeric promptTokens/completionTokens — so the
    // header gauge reads a filled context instead of "— / 128k".
    return json({
      current: {
        promptTokens: 14_200,
        cachedTokens: 4_200,
        lastPromptTokens: 18_400,
        lastCachedTokens: 4_200,
        cacheReported: true,
        completionTokens: 480,
        reasoningTokens: 0,
        steps: 2,
        contextTokens: 18_400,
      },
    });
  }
  if (pathname === "/api/mcp") return json({ servers: [] });
  if (pathname === "/api/context-size") {
    // The Context sheet's numbers (`ContextAccounting`, web/src/lib/context-size.ts),
    // derived here the way the BFF derives them: a declared 32k window, compaction
    // short of it, and nothing typed by hand — which is what the "automatic" source
    // reads as in the gauge.
    return json({
      context: 32_768,
      source: "declared",
      maxOutput: 4_096,
      compactAt: 28_672,
      window: 30_720,
      typed: { agent: null, conversation: null },
      automatic: null,
    });
  }
  if (pathname === "/api/model-caps") {
    // Declarations the operator would have made for a local endpoint that reports
    // nothing (`ModelCapsStore`). `models` and `endpoints` must both be objects:
    // the reader defaults them, but a missing one is a panel that renders empty.
    return json({
      models: {
        "llama/qwen3-32b": {
          vision: false,
          thinking: true,
          contextWindow: 32_768,
          maxTokens: 4_096,
        },
      },
      endpoints: {},
    });
  }
  if (pathname === "/api/skills") return json({ skills: [], errors: [] });
  if (pathname === "/api/native-tools") {
    return json({ google: [], bridge: { servers: [], tools: 0, failures: {} } });
  }
  if (pathname === "/api/codex/settings") {
    return json({
      settings: {
        enabled: false,
        baseUrl: "http://host.docker.internal:8080/v1",
        model: "gpt-5-codex",
        hasApiKey: false,
        reasoningEffort: null,
        contextWindow: null,
        streamIdleTimeoutSeconds: null,
      },
      suggestedBaseUrl: "http://host.docker.internal:8080/v1",
    });
  }
  if (pathname.startsWith("/api/codex/runs")) {
    // `runs` must be an array: CodexRunsList calls `.some()` on it directly,
    // so an absent field takes down the whole React tree, not just this panel.
    return json({ runs: [] });
  }
  if (pathname.startsWith("/api/pi/runs")) {
    // The same shape rule for the remote-pi list, which the header's Runs chip
    // asks for at boot: `fetchPiRuns` reads `body.runs`, and `other` is the count
    // of runs on agents other than the open one.
    return json({ runs: [], other: 0 });
  }
  if (pathname === "/api/web-tools/settings") return json({ settings: { enabled: false } });
  if (pathname === "/api/web-tools/status") {
    return json({ searxng: "unreachable", ddg: "unreachable", enabled: false });
  }
  if (pathname === "/api/google") {
    return json({
      settings: {
        enabled: false,
        clientId: "",
        hasClientSecret: false,
        permissions: { gmail: null, calendar: null, tasks: null },
        grant: null,
        effective: { gmail: null, calendar: null, tasks: null },
        serving: false,
        needsReconnect: false,
      },
      sidecarUp: false,
      redirectUri: "https://letta.example.com/api/google/oauth/callback",
      writable: true,
    });
  }
  if (pathname.startsWith("/api/agents/step-limit/")) {
    // The Agent tab reads its per-agent model-call limit (`lib/agent-step-limit.ts`);
    // `null` is "none set", which is what a fresh install has. Only asked when a
    // shot opens the Agent tab — the Memory shot is the first that does.
    return json({ limit: null });
  }
  if (pathname.startsWith("/api/agents/tool-access/")) {
    return json({ codex: false, google: "off" });
  }
  if (pathname === "/push/vapid-key") return json({ key: "" });
  if (pathname.startsWith("/api/") || pathname.startsWith("/push/")) {
    // Anything else this run does not model. Naming the route is the point: a
    // caller's `.json()` succeeds against a stub and its panel renders empty, so
    // the only honest signal a fixture can give is a failed render that says which
    // shape to add — see `unmodeledRoutes`.
    unmodeledRoutes.add(pathname);
    return json({ error: `screenshots fixture has no route for ${pathname}` }, 500);
  }

  return (
    serveStatic(pathname) ??
    serveStatic("/index.html") ??
    new Response("Not found", { status: 404 })
  );
}

/**
 * Bind the first free port in a high range.
 *
 * `port: 0` (let the OS choose) is the obvious answer and does not work here:
 * Bun reports EADDRINUSE for it in some environments, which turns a
 * screenshot run into a confusing port-conflict error. Scanning a range above
 * the ports this project uses (8080/8090/5173) keeps the harness from ever
 * colliding with a real stack on the same machine.
 */
function serveOnFreePort(
  makeServer: (port: number) => ReturnType<typeof Bun.serve>,
  from: number,
  attempts: number,
): { server: ReturnType<typeof Bun.serve>; port: number } {
  let lastError: unknown = null;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = from + offset;
    try {
      return { server: makeServer(port), port };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `No free port in ${from}-${from + attempts - 1}: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

const makeServer = (port: number) =>
  Bun.serve<Record<string, never>>({
    port,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/ws") {
        const ok = bunServer.upgrade(request, { data: {} });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return handleHttp(request);
    },
    websocket: {
      open(ws) {
        ws.send(
          JSON.stringify({
            type: "__bff_hello",
            session_id: "screenshot-session",
            user: { email: "you@example.com" },
            upstream: "connected",
            app_server_info: APP_SERVER_INFO,
            latest_seq: 12,
            active: [],
          }),
        );
      },
      message(ws, raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const command = parsed as Record<string, unknown>;

        if (command.type === "__bff_resume") {
          ws.send(
            JSON.stringify({
              type: "__bff_resume_result",
              from_seq: command.from_seq ?? null,
              latest_seq: 12,
              replayed: 0,
              resync_required: false,
            }),
          );
          return;
        }
        if (command.type === "__bff_watching") return;

        ws.send(JSON.stringify(respondTo(command)));
      },
    },
  });

const { server } = serveOnFreePort(makeServer, 8200, 40);

// ── Capture ────────────────────────────────────────────────────────────────

/** Prefer a system Chromium; fall back to Playwright's own download. */
function chromiumExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path));
}

/** Page errors seen since a page opened, so a crash after load is attributable. */
const pageErrorsByPage = new WeakMap<Page, string[]>();
const pageNoiseByPage = new WeakMap<Page, string[]>();

/** Start recording uncaught page errors for `page` from now on. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  pageErrorsByPage.set(page, errors);
  const noise: string[] = [];
  pageNoiseByPage.set(page, noise);
  page.on("pageerror", (error) => errors.push(`${error.message}\n${error.stack ?? ""}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      noise.push(`${msg.type()}: ${msg.text()}`);
  });
  return errors;
}

/** Everything the page can say about why it never rendered what was expected. */
function pageDiagnosis(page: Page): string {
  const errors = (pageErrorsByPage.get(page) ?? []).join(" | ") || "(none)";
  const noise = (pageNoiseByPage.get(page) ?? []).slice(0, 8).join(" | ") || "(none)";
  return `page errors: ${errors}\nconsole: ${noise}`;
}

async function open(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  trackPageErrors(page);
  await page.goto(`${server.url.origin}/`, { waitUntil: "networkidle" });
  // The transcript arrives over the socket after the shell paints; wait for it
  // rather than a fixed sleep so a slow machine cannot capture a half-built view.
  // `.entry` is one transcript row (MessageList.tsx). Waiting on it proves the
  // socket round trip completed, not just that the shell painted.
  try {
    await page.waitForSelector(".messages .entry", { timeout: 15_000 });
  } catch (error) {
    // A transcript that never arrives is a fixture that stopped matching the
    // client, and a bare timeout says nothing about which half moved.
    const text = await page.evaluate(() => document.body.textContent?.slice(0, 600) ?? "");
    throw new Error(
      `${String(error)}\n${pageDiagnosis(page)}\nvisible text: ${text.replace(/\n+/g, " / ")}`,
    );
  }
  await page.waitForTimeout(400);
  return page;
}

/**
 * Capture one screenshot, refusing to write a blank frame.
 *
 * A React error inside a tab renders nothing at all, and a blank PNG looks
 * exactly like a successful capture until someone opens the README. Asserting
 * on content and surfacing page errors here means a broken fixture fails the
 * run instead of shipping an empty image.
 */
async function shot(page: Page, name: string, contentSelector: string): Promise<void> {
  const pageErrors = pageErrorsByPage.get(page) ?? [];

  const visible = await page
    .locator(contentSelector)
    .first()
    .isVisible()
    .catch(() => false);
  if (!visible) {
    throw new Error(
      `Nothing matched ${contentSelector} for "${name}" — refusing to write a blank ` +
        `screenshot. Page errors: ${pageErrors.join(" | ") || "(none)"}`,
    );
  }
  if (pageErrors.length > 0) {
    throw new Error(`Page errors while capturing "${name}": ${pageErrors.join(" | ")}`);
  }

  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  console.log(`  wrote ${path}`);
}

if (LIST) {
  for (const shot of SHOTS) console.log(`${shot.name}\t${shot.label}`);
  process.exit(0);
}

if (!existsSync(join(WEB_DIST, "index.html"))) {
  console.error(`No build at ${WEB_DIST}. Run \`bun run build\` first.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const executablePath = chromiumExecutable();
console.log(`chromium: ${executablePath ?? "(playwright default)"}`);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox"],
});

try {
  if (render.has("desktop-chat")) {
    const page = await open(browser, DESKTOP);
    await shot(page, "desktop-chat", ".messages .entry");
    await page.close();
  }
  if (render.has("mobile-chat")) {
    const page = await open(browser, PHONE);
    await shot(page, "mobile-chat", ".messages .entry");
    await page.close();
  }
  if (render.has("desktop-settings")) {
    // `?settings=<section>` opens Settings on that section on load
    // (web/src/lib/settings-link.ts), so this needs no clicking.
    const page = await browser.newPage({ viewport: DESKTOP });
    trackPageErrors(page);
    await page.goto(`${server.url.origin}/?settings=providers`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-pane", { timeout: 15_000 });
    await page.waitForTimeout(600);
    await shot(page, "desktop-settings", ".settings-pane");
    await page.close();
  }
  if (render.has("agent-memory")) {
    // The Memory pane is a section of the Agent tab, and its size is whatever
    // --fixture injected — which is the whole point of this shot: it is how a
    // surface gets proved at scale (a 178-file tree) without forking this file.
    const page = await open(browser, DESKTOP);
    await openPane(page, "Agent");
    await page.locator('.section-tabs button:text-is("Memory")').click();
    await page.waitForSelector("ul.memory-tree li", { timeout: 15_000 });
    // Folders start folded, so "expand all" is what makes the render a test of
    // the whole tree rather than of its first screen.
    const expand = page.locator('button.link:text-is("Expand all")');
    if ((await expand.count()) > 0) await expand.first().click();
    await page.waitForTimeout(600);
    // The counts the pane prints for itself, quoted so a review can tell 178
    // files from 3 without opening the PNG.
    const counts = (await page.locator(".pane .muted.small").allInnerTexts()).filter((text) =>
      /folder/.test(text),
    );
    console.log(`  memory counts: ${counts.join(" | ") || "(none rendered)"}`);
    await shot(page, "agent-memory", "ul.memory-tree");
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}

console.log(`\nScreenshots in ${OUT_DIR}`);
if (unmodeledRoutes.size > 0) {
  // Named after the PNGs are written, so a run that rendered something still
  // tells you what it had to stub to do it. These are the routes a future render
  // will read a shape off and throw on.
  console.error(
    `\n✗ the fixture modelled none of these routes the client asked for:\n` +
      [...unmodeledRoutes].map((route) => `   - ${route}`).join("\n"),
  );
  process.exit(1);
}
