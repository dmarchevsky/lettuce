/**
 * The screenshots fixture must model every route the web client asks for at boot.
 *
 * `scripts/screenshots.ts` renders the README images against its own mock, and since
 * PR #147 an unmodelled route 500s with its own name and fails the run — but nothing
 * in `bun run verify` or CI *runs* the generator, so the fixture rots between runs.
 * It already silently lacked `/api/context-size` and `/api/model-caps`, which the
 * client had been calling at boot for a while; the next such gap would be discovered
 * by whoever regenerates the images, at their time, not by whoever caused it.
 *
 * Three assertions, all static — no browser, no PNG, no stack:
 * 1. every reviewed boot route has a modelled handler in the fixture;
 * 2. the fixture models no route the client no longer calls anywhere (fixture rot in
 *    the other direction: a stale stub is a fixture that lies about the contract);
 * 3. every `/api/` literal in the shell's own boot modules (`App.tsx` and
 *    `web/src/state/`) is modelled — the drift catcher for a *new* boot endpoint,
 *    which lands as a data hook there more often than not. A new boot call elsewhere
 *    (a component-mounted chip, a Settings section) still needs adding here AND to
 *    the fixture; the reviewed list below is the human-side of that compact.
 *
 * Where the boot list came from: walking every call site that fires when the three
 * surfaces `screenshots.ts` renders boot — the chat shell at desktop and phone, and
 * Settings opened on providers (its `?settings=` deep link) — each entry names its
 * call site. Verified against the running client's own requests during a capture run.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Routes the client requests when those surfaces boot, each with the call site that
 * asks. `ROUTES` below are the fixture's spelling: a trailing `/` means the fixture
 * models the prefix (`startsWith`) and anything under it counts.
 */
const BOOT_ROUTES: { route: string; askedBy: string }[] = [
  { route: "/api/status", askedBy: "App.tsx (and lib/auth-probe.ts when the link drops)" },
  { route: "/api/agents/flags", askedBy: "lib/agent-flags.ts via state/use-agents.ts — the rail" },
  { route: "/api/context-size", askedBy: "lib/context-size.ts via state/use-context-size.ts" },
  {
    route: "/api/model-caps",
    askedBy: "lib/model-caps.ts via ProvidersSection (the Settings shot)",
  },
  { route: "/api/turn-usage", askedBy: "state/use-conversation.ts — the header gauge" },
  { route: "/api/turn-errors", askedBy: "state/use-conversation.ts — the error push" },
  { route: "/api/pi/runs", askedBy: "components/PiRunsChip.tsx — the header Runs chip" },
  {
    route: "/api/codex/runs",
    askedBy: "components/MessageList.tsx — codex threads in the transcript",
  },
  {
    route: "/api/providers",
    askedBy: "lib/provider-registry.ts via ProvidersSection — the Settings shot opens here",
  },
  { route: "/api/codex/settings", askedBy: "components/CodexSection.tsx (Settings)" },
  { route: "/api/mcp", askedBy: "components/McpEditor.tsx (Settings → MCP)" },
  { route: "/api/skills", askedBy: "lib/skills.ts — Skills sections (Settings and the Agent tab)" },
  { route: "/api/native-tools", askedBy: "components/GoogleSection.tsx (Settings)" },
  { route: "/api/web-tools/settings", askedBy: "components/WebToolsSection.tsx (Settings)" },
  { route: "/api/web-tools/status", askedBy: "components/WebToolsSection.tsx (Settings)" },
  { route: "/api/google", askedBy: "lib/google.ts via GoogleSection/SignInSection (Settings)" },
  {
    route: "/api/agents/tool-access/",
    askedBy: "lib/agent-tool-access.ts via AgentToolsSection — per-agent Tools chip",
  },
  { route: "/push/vapid-key", askedBy: "lib/push.ts — notification registration" },
];

/**
 * Every `pathname === "/…"` / `pathname.startsWith("/…")` the fixture's `handleHttp`
 * answers, catch-all excluded — the source is the record; importing screenshots.ts
 * would start its server and render PNGs, which is exactly what `verify` must not do.
 */
function modeledRoutes(): Set<string> {
  const source = readFileSync(join(ROOT, "scripts/screenshots.ts"), "utf8");
  const routes = new Set<string>();
  for (const match of source.matchAll(/pathname(?:\s*===\s*|\.startsWith\(\s*)"([^"]+)"/g)) {
    const route = match[1] as string;
    // The two catch-alls are the "unmodelled" trap itself, not a modelled route; and
    // the `/ws` upgrade path is transport plumbing, not part of the HTTP contract.
    if (route === "/api/" || route === "/push/") continue;
    if (!route.startsWith("/api/") && !route.startsWith("/push/")) continue;
    routes.add(route);
  }
  return routes;
}

function covers(model: string, route: string): boolean {
  return route === model || route.startsWith(model) || model.startsWith(route);
}

/** Every `/api/…` string literal in web/src, query and template holes trimmed. */
function clientRouteLiterals(): Set<string> {
  const literals = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/["'`](\/(?:api|push)\/[^"'`\n]*)/g)) {
          literals.add((match[1] as string).split(/[?$]/)[0] as string);
        }
      }
    }
  };
  walk(join(ROOT, "web", "src"));
  return literals;
}

const modelled = modeledRoutes();

describe("screenshots fixture ↔ web client contract", () => {
  test("the fixture models every boot route the client asks for", () => {
    for (const { route, askedBy } of BOOT_ROUTES) {
      const hit = [...modelled].some((model) => covers(model, route));
      expect(hit, `${route} (${askedBy}) has no handler in scripts/screenshots.ts`).toBe(true);
    }
  });

  test("the fixture models no route the client stopped calling", () => {
    const client = clientRouteLiterals();
    for (const model of modelled) {
      const hit = [...client].some((literal) => covers(model, literal));
      expect(hit, `scripts/screenshots.ts models ${model}, which no web/src literal uses`).toBe(
        true,
      );
    }
  });

  test("a new boot endpoint in App or the state hooks needs a fixture entry", () => {
    // The shell's own boot modules: a fetch added here runs before anyone clicks,
    // so it runs in every screenshots render — the fixture must know it.
    const bootSources = [
      join(ROOT, "web", "src", "App.tsx"),
      ...readdirSync(join(ROOT, "web", "src", "state"))
        .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
        .map((name) => join(ROOT, "web", "src", "state", name)),
    ];
    for (const file of bootSources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/["'`](\/(?:api|push)\/[^"'`\n]*)/g)) {
        const literal = (match[1] as string).split(/[?$]/)[0] as string;
        const hit = [...modelled].some((model) => covers(model, literal));
        expect(
          hit,
          `${file.slice(ROOT.length)} asks for ${literal} at boot and ` +
            "scripts/screenshots.ts does not model it — add the route to the fixture " +
            "and to BOOT_ROUTES here.",
        ).toBe(true);
      }
    }
  });
});
