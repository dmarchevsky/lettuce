import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInternalTools, isLoopback } from "./http.ts";
import { type ModsIo, RETIRED_MOD_SOURCE, syncMods } from "./install.ts";
import { renderToolsMod } from "./mod.ts";
import { capText, MAX_TOOL_TEXT, type ToolHandler, type ToolSpec } from "./types.ts";

const handlers = (): ReadonlyMap<string, ToolHandler> =>
  new Map<string, ToolHandler>([
    ["web_search", async (args) => ({ text: `searched ${String(args.query)}`, isError: false })],
    ["fetch_webpage", async () => ({ text: "page", isError: false })],
    [
      "boom",
      async () => {
        throw new Error("kaput");
      },
    ],
  ]);

const post = (path: string, body: unknown = { query: "q" }) =>
  new Request(`http://127.0.0.1:8080${path}`, { method: "POST", body: JSON.stringify(body) });

// RFC 5737 documentation addresses: the assertion is only "not loopback", and a real
// LAN or bridge range in a public tree is what check-prod-info exists to keep out.
const NON_LOOPBACK = "192.0.2.1";
const NON_LOOPBACK_MAPPED = "::ffff:192.0.2.5";

describe("the internal route", () => {
  test("loopback means loopback", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"])
      expect(isLoopback(address)).toBe(true);
    for (const address of [NON_LOOPBACK, "192.0.2.24", NON_LOOPBACK_MAPPED, "", null, undefined])
      expect(isLoopback(address)).toBe(false);
  });

  test("a browser (non-loopback) gets a 404; other paths are not ours", async () => {
    expect(
      (await handleInternalTools(post("/internal/tools/web_search"), NON_LOOPBACK, handlers))
        ?.status,
    ).toBe(404);
    expect(await handleInternalTools(post("/api/status"), "127.0.0.1", handlers)).toBeNull();
    expect(
      (await handleInternalTools(post("/internal/tools/nope"), "127.0.0.1", handlers))?.status,
    ).toBe(404);
  });

  test("a mod's call is dispatched by name and answered as JSON", async () => {
    const response = await handleInternalTools(
      post("/internal/tools/web_search"),
      "127.0.0.1",
      handlers,
    );
    expect(await response?.json()).toEqual({ text: "searched q", isError: false });
  });

  test("the first web-tools mod's paths still answer", async () => {
    const response = await handleInternalTools(
      post("/internal/web-tools/search"),
      "127.0.0.1",
      handlers,
    );
    expect(await response?.json()).toEqual({ text: "searched q", isError: false });
    const fetchResponse = await handleInternalTools(
      post("/internal/web-tools/fetch"),
      "::1",
      handlers,
    );
    expect(await fetchResponse?.json()).toEqual({ text: "page", isError: false });
  });

  test("a throwing handler becomes a tool error, not a 500", async () => {
    const response = await handleInternalTools(post("/internal/tools/boom"), "127.0.0.1", handlers);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ text: "The boom tool failed: kaput", isError: true });
  });
});

describe("renderToolsMod", () => {
  const dir = mkdtempSync(join(tmpdir(), "tools-mod-"));
  const specs: ToolSpec[] = [
    {
      name: "read_it",
      description: "Reads.",
      parameters: { type: "object", properties: {} },
      approval: "auto",
    },
    {
      name: "change_it",
      description: "Changes.",
      parameters: { type: "object", properties: {} },
      approval: "ask",
    },
  ];

  async function registered(source: string) {
    const file = join(dir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, source);
    const mod = (await import(file)) as { default: (letta: unknown) => unknown };
    const tools: Record<string, unknown>[] = [];
    mod.default({
      capabilities: { tools: true },
      tools: {
        register(tool: Record<string, unknown>) {
          tools.push(tool);
          return () => {};
        },
      },
    });
    return tools;
  }

  test("auto tools never prompt; ask tools follow the permission mode", async () => {
    const tools = await registered(renderToolsMod({ title: "t v1", tools: specs, port: 8080 }));
    expect(
      tools.map((t) => [t.name, t.requiresApproval, t.approvalPolicy, t.parallelSafe]),
    ).toEqual([
      ["read_it", false, undefined, true],
      ["change_it", true, "ask", false],
    ]);
  });

  test("no tools renders a mod that registers nothing", async () => {
    expect(await registered(renderToolsMod({ title: "t v1", tools: [], port: 8080 }))).toEqual([]);
  });

  test("a tool call goes to /internal/tools/<name> on the configured port", async () => {
    const source = renderToolsMod({ title: "t v1", tools: specs, port: 9090 });
    expect(source).toContain('"http://127.0.0.1:9090/internal/tools"');
    expect(source.split("\n")[0]).toBe(
      "// t v1 — rendered by the lettuce BFF (bff/src/internal-tools/mod.ts).",
    );
  });
});

describe("syncMods", () => {
  function memory(agentExists = true) {
    const files = new Map<string, string>();
    const events: string[] = [];
    const io: ModsIo = {
      async read(path) {
        return files.get(path) ?? null;
      },
      async write(path, content) {
        files.set(path, content);
        events.push(`write ${path}`);
      },
      async reloadMods() {
        events.push("reload");
        return agentExists;
      },
    };
    return { io, events };
  }

  test("writes only what changed, and reloads once for the batch", async () => {
    const { io, events } = memory();
    const mods = [
      { path: "/m/a.mjs", source: "a" },
      { path: "/m/b.mjs", source: "b" },
    ];
    expect(await syncMods(io, mods)).toBe("reloaded");
    expect(events).toEqual(["write /m/a.mjs", "write /m/b.mjs", "reload"]);
    expect(await syncMods(io, mods)).toBe("unchanged");
    expect(
      await syncMods(io, [
        { path: "/m/a.mjs", source: "a" },
        { path: "/m/b.mjs", source: "b2" },
      ]),
    ).toBe("reloaded");
    expect(events.slice(3)).toEqual(["write /m/b.mjs", "reload"]);
  });

  test("with no agent yet the reload is reported pending", async () => {
    const { io } = memory(false);
    expect(await syncMods(io, [{ path: "/m/a.mjs", source: "a" }])).toBe("reload-pending");
  });

  test("a retired mod is stubbed so it registers nothing, once", async () => {
    const { io, events } = memory();
    const retired = "/m/old-name.mjs";
    // An install's mods directory still holding the pre-rename file.
    await io.write(retired, "export default function activate(letta) { /* tools */ }\n");
    events.length = 0;

    expect(await syncMods(io, [{ path: "/m/new-name.mjs", source: "x" }], [retired])).toBe(
      "reloaded",
    );
    expect(events).toEqual([`write ${retired}`, "write /m/new-name.mjs", "reload"]);
    expect(await io.read(retired)).toBe(RETIRED_MOD_SOURCE);

    // Already stubbed: nothing rewritten, so no spurious reload.
    expect(await syncMods(io, [{ path: "/m/new-name.mjs", source: "x" }], [retired])).toBe(
      "unchanged",
    );
    // A retired path that was never written (a fresh install) is skipped too.
    expect(
      await syncMods(io, [{ path: "/m/new-name.mjs", source: "x" }], ["/m/never-existed.mjs"]),
    ).toBe("unchanged");
  });
});

test("capText keeps text under the tool-return cap and says it cut", () => {
  expect(capText("short")).toBe("short");
  const cut = capText("x".repeat(MAX_TOOL_TEXT + 10), "ask for less");
  expect(cut.length).toBeLessThan(MAX_TOOL_TEXT + 100);
  expect(cut).toContain("ask for less");
});

describe("per-agent tools", () => {
  const specs: ToolSpec[] = [
    { name: "gmail_search", description: "d", parameters: { type: "object" }, approval: "auto" },
    { name: "gmail_send", description: "d", parameters: { type: "object" }, approval: "ask" },
  ];

  interface Registered {
    name: string;
    isEnabled: (ctx: unknown) => boolean;
    run: (ctx: unknown) => Promise<unknown>;
  }

  async function activate(source: string): Promise<Registered[]> {
    const file = join(mkdtempSync(join(tmpdir(), "tools-mod-")), "mod.mjs");
    writeFileSync(file, source);
    const mod = (await import(file)) as { default: (letta: unknown) => unknown };
    const registered: Registered[] = [];
    mod.default({
      capabilities: { tools: true },
      tools: {
        register(tool: Registered) {
          registered.push(tool);
          return () => {};
        },
      },
    });
    return registered;
  }

  test("a hidden tool is disabled for that agent only", async () => {
    const tools = await activate(
      renderToolsMod({ title: "t", tools: specs, port: 1, hidden: { "agent-b": ["gmail_send"] } }),
    );
    const enabled = (name: string, ctx: unknown) =>
      tools.find((t) => t.name === name)?.isEnabled(ctx);
    expect(enabled("gmail_send", { agent: { id: "agent-b" } })).toBe(false);
    expect(enabled("gmail_search", { agent: { id: "agent-b" } })).toBe(true);
    expect(enabled("gmail_send", { agent: { id: "agent-a" } })).toBe(true);
    // No agent in the context (not a listener turn): nothing is hidden.
    expect(enabled("gmail_send", {})).toBe(true);
  });

  test("the calling agent reaches the handler", async () => {
    const seen: (string | null | undefined)[] = [];
    const recording = () =>
      new Map<string, ToolHandler>([
        [
          "gmail_search",
          async (_args, context) => {
            seen.push(context?.agentId);
            return { text: "ok", isError: false };
          },
        ],
      ]);
    const request = (headers: Record<string, string>) =>
      new Request("http://127.0.0.1:8080/internal/tools/gmail_search", {
        method: "POST",
        headers,
        body: "{}",
      });
    await handleInternalTools(request({ "x-letta-agent-id": "agent-b" }), "127.0.0.1", recording);
    await handleInternalTools(request({}), "127.0.0.1", recording);
    await handleInternalTools(request({ "x-letta-agent-id": "a b" }), "127.0.0.1", recording);
    expect(seen).toEqual(["agent-b", null, null]);
  });
});
