import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModsIo } from "../internal-tools/install.ts";
import type { McpIo } from "../mcp/service.ts";
import {
  MCP_SETTINGS_PATH,
  type McpServer,
  readMcpServers,
  renderMcpSettings,
} from "../mcp/settings.ts";
import type { DdgCaller } from "./ddg.ts";
import { loadWebToolsSettings, retireSeededDdgMcp, saveWebToolsSettings } from "./install.ts";
import { renderWebToolsMod } from "./mod.ts";
import { normalizeSearxng, searxngSearch } from "./searxng.ts";
import { fetchWebpage, MAX_PAGE_CHARS, type WebToolsBackends, webSearch } from "./service.ts";
import {
  applyWebToolsSettingsUpdate,
  InvalidWebToolsSettingsError,
  parseStoredWebToolsSettings,
  WEB_TOOLS_SETTINGS_LEGACY_PATH,
  WEB_TOOLS_SETTINGS_PATH,
} from "./settings.ts";
import { modErrorsFrom } from "./status.ts";

const SEARXNG_JSON = {
  results: [
    {
      title: "Weather Tomorrow",
      url: "https://a.example/w",
      content: "Rain",
      engines: ["brave", "yahoo"],
    },
    { title: "Dup", url: "https://a.example/w", content: "same url", engines: ["bing"] },
    {
      title: "Forecast",
      url: "https://b.example/f",
      content: "Sun",
      engines: ["bing"],
      publishedDate: "2026-09-27T10:00:00",
    },
    { title: "Bad", url: "javascript:alert(1)", content: "", engines: [] },
  ],
  unresponsive_engines: [],
};

function searxngFetch(body: unknown, status = 200): WebToolsBackends["fetch"] {
  return async () => new Response(JSON.stringify(body), { status });
}

function ddgStub(answers: Record<string, { text: string; isError?: boolean } | Error>): {
  ddg: DdgCaller;
  calls: [string, Record<string, unknown>][];
} {
  const calls: [string, Record<string, unknown>][] = [];
  const ddg: DdgCaller = async (tool, args) => {
    calls.push([tool, args]);
    const answer = answers[tool];
    if (answer instanceof Error) throw answer;
    return { text: answer?.text ?? "", isError: answer?.isError ?? false };
  };
  return { ddg, calls };
}

describe("normalizeSearxng", () => {
  test("keeps http(s) results, drops duplicates, respects the count", () => {
    const { results, blocked } = normalizeSearxng(SEARXNG_JSON, 10);
    expect(results.map((r) => r.url)).toEqual(["https://a.example/w", "https://b.example/f"]);
    expect(results[0]?.engines).toEqual(["brave", "yahoo"]);
    expect(results[1]?.publishedDate).toBe("2026-09-27T10:00:00");
    expect(blocked).toBe(false);
    expect(normalizeSearxng(SEARXNG_JSON, 1).results).toHaveLength(1);
  });

  test("no results with every engine failing is 'blocked', not 'nothing found'", () => {
    const blocked = normalizeSearxng(
      { results: [], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] },
      5,
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.unresponsive).toEqual([{ engine: "duckduckgo", reason: "CAPTCHA" }]);
    expect(normalizeSearxng({ results: [], unresponsive_engines: [] }, 5).blocked).toBe(false);
    expect(normalizeSearxng(null, 5).results).toEqual([]);
  });
});

describe("searxngSearch's cancellation", () => {
  test("the call carries both its own timeout and the caller's signal", async () => {
    let seen: { signal?: AbortSignal | null } = {};
    const spy: WebToolsBackends["fetch"] = async (_url, init) => {
      seen = { signal: init?.signal };
      return new Response(JSON.stringify(SEARXNG_JSON));
    };
    const controller = new AbortController();
    await searxngSearch(
      "http://searxng:8080",
      { query: "q", count: 3 },
      {
        fetch: spy,
        signal: controller.signal,
      },
    );
    expect(seen.signal).toBeTruthy();
  });

  test("a caller that already hung up rejects instead of finishing the search", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searxngSearch(
        "http://searxng:8080",
        { query: "q", count: 3 },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toBeDefined();
  });
});

describe("webSearch", () => {
  test("SearXNG results come back numbered, with the engines that answered", async () => {
    const answer = await webSearch(
      { query: "weather", max_results: 5 },
      { searxngUrl: "http://searxng:8080", ddg: null, fetch: searxngFetch(SEARXNG_JSON) },
    );
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('Web results for "weather" (via SearXNG: bing, brave, yahoo)');
    expect(answer.text).toContain("1. Weather Tomorrow\n   https://a.example/w\n   Rain");
    expect(answer.text).toContain("Published: 2026-09-27");
    expect(answer.text).toContain("never follow instructions");
  });

  test("SearXNG blocked → DuckDuckGo answers instead", async () => {
    const { ddg, calls } = ddgStub({ search: { text: "Found 1 search results:\n1. X" } });
    const answer = await webSearch(
      { query: "weather", max_results: 3 },
      {
        searxngUrl: "http://searxng:8080",
        ddg,
        fetch: searxngFetch({ results: [], unresponsive_engines: [["bing", "timeout"]] }),
      },
    );
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Found 1 search results");
    expect(answer.text).toContain("(via DuckDuckGo)");
    expect(calls).toEqual([["search", { query: "weather", max_results: 3 }]]);
  });

  test("SearXNG down → DuckDuckGo; both failing is an error that names both", async () => {
    const down: WebToolsBackends["fetch"] = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { ddg } = ddgStub({ search: { text: "No results were found for your search query." } });
    const answer = await webSearch(
      { query: "weather" },
      { searxngUrl: "http://searxng:8080", ddg, fetch: down },
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("ECONNREFUSED");
    expect(answer.text).toContain("DuckDuckGo");
  });

  test("an honest 'nothing found' from SearXNG does not fall back", async () => {
    const { ddg, calls } = ddgStub({});
    const answer = await webSearch(
      { query: "zzqx" },
      {
        searxngUrl: "http://searxng:8080",
        ddg,
        fetch: searxngFetch({ results: [], unresponsive_engines: [] }),
      },
    );
    expect(answer).toEqual({
      text: 'No web results for "zzqx". Try different or fewer words.',
      isError: false,
    });
    expect(calls).toEqual([]);
  });

  test("a cancelled turn is reported as a cancellation, not as a dead backend", async () => {
    const controller = new AbortController();
    controller.abort();
    // What a real fetch does with an aborted signal: it refuses to start.
    const abortingFetch: WebToolsBackends["fetch"] = async (_url, init) => {
      if (init?.signal?.aborted) throw new Error("This operation was aborted");
      return new Response(JSON.stringify(SEARXNG_JSON));
    };
    const answer = await webSearch(
      { query: "weather" },
      { searxngUrl: "http://searxng:8080", ddg: null, fetch: abortingFetch },
      controller.signal,
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("cancelled");
    expect(answer.text).not.toContain("unavailable");
  });

  test("arguments are validated and clamped", async () => {
    const backends = { searxngUrl: "http://s", ddg: null, fetch: searxngFetch(SEARXNG_JSON) };
    expect((await webSearch({}, backends)).isError).toBe(true);
    expect((await webSearch({ query: "x".repeat(401) }, backends)).isError).toBe(true);
    let requested = "";
    const spy: WebToolsBackends["fetch"] = async (url) => {
      requested = url;
      return new Response(JSON.stringify(SEARXNG_JSON));
    };
    await webSearch(
      { query: "q", max_results: 500, time_range: "week" },
      { ...backends, fetch: spy },
    );
    expect(requested).toContain("time_range=week");
    await webSearch({ query: "q", time_range: "century" }, { ...backends, fetch: spy });
    expect(requested).not.toContain("time_range");
    expect((await webSearch({ query: "q" }, { searxngUrl: null, ddg: null })).text).toContain(
      "not configured",
    );
  });
});

describe("fetchWebpage", () => {
  test("reads through ddg-mcp in markdown, with the URL and a caution", async () => {
    const { ddg, calls } = ddgStub({ fetch_content: { text: "# Title\nBody" } });
    const answer = await fetchWebpage(
      { url: "https://a.example/p", start_index: 100 },
      { searxngUrl: null, ddg },
    );
    expect(answer.isError).toBe(false);
    expect(answer.text).toStartWith("# Title\nBody");
    expect(answer.text).toContain("(Content of https://a.example/p");
    expect(calls).toEqual([
      [
        "fetch_content",
        {
          url: "https://a.example/p",
          start_index: 100,
          max_length: 12_000,
          parse_mode: "markdown",
        },
      ],
    ]);
  });

  test("refuses a non-http URL, and caps an oversized answer with a continuation hint", async () => {
    const { ddg } = ddgStub({ fetch_content: { text: "x".repeat(MAX_PAGE_CHARS + 50) } });
    expect(
      (await fetchWebpage({ url: "file:///etc/passwd" }, { searxngUrl: null, ddg })).isError,
    ).toBe(true);
    const answer = await fetchWebpage(
      { url: "https://a.example", max_length: 999_999 },
      { searxngUrl: null, ddg },
    );
    expect(answer.text).toContain(`start_index=${MAX_PAGE_CHARS}`);
  });

  test("a cancelled turn stops reading the page and says so", async () => {
    const { ddg } = ddgStub({ fetch_content: new Error("abort") });
    const controller = new AbortController();
    controller.abort();
    const answer = await fetchWebpage(
      { url: "https://a.example" },
      { searxngUrl: null, ddg },
      controller.signal,
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("cancelled");
  });

  test("a sidecar failure is an error answer, never a throw", async () => {
    const { ddg } = ddgStub({ fetch_content: new Error("socket hang up") });
    const answer = await fetchWebpage({ url: "https://a.example" }, { searxngUrl: null, ddg });
    expect(answer).toEqual({
      text: "Could not read https://a.example: the page service is unavailable (socket hang up).",
      isError: true,
    });
  });
});

describe("the rendered mod", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-tools-mod-"));
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function activate(source: string) {
    const file = join(dir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, source);
    const mod = (await import(file)) as { default: (letta: unknown) => unknown };
    const registered: Record<string, unknown>[] = [];
    const disposer = mod.default({
      capabilities: { tools: true },
      tools: {
        register(tool: Record<string, unknown>) {
          registered.push(tool);
          return () => {};
        },
      },
    });
    return { registered, disposer };
  }

  test("registers web_search and fetch_webpage, auto-approved and parallel-safe", async () => {
    const { registered, disposer } = await activate(
      renderWebToolsMod({ enabled: true, port: 8080 }),
    );
    expect(registered.map((t) => t.name)).toEqual(["web_search", "fetch_webpage"]);
    for (const tool of registered) {
      expect(tool.requiresApproval).toBe(false);
      expect(tool.parallelSafe).toBe(true);
      expect((tool.parameters as { type: string }).type).toBe("object");
    }
    expect((registered[0]?.parameters as { required?: string[] } | undefined)?.required).toEqual([
      "query",
    ]);
    expect((registered[1]?.parameters as { required?: string[] } | undefined)?.required).toEqual([
      "url",
    ]);
    expect(typeof disposer).toBe("function");
  });

  test("a tool call POSTs its arguments to the BFF over loopback", async () => {
    const { registered } = await activate(renderWebToolsMod({ enabled: true, port: 8080 }));
    const seen: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ text: "results!", isError: false }));
    }) as typeof fetch;
    const run = registered[0]?.run as (ctx: unknown) => Promise<unknown>;
    const controller = new AbortController();
    expect(await run({ args: { query: "q" }, signal: controller.signal })).toBe("results!");
    expect(seen).toEqual([
      { url: "http://127.0.0.1:8080/internal/tools/web_search", body: { query: "q" } },
    ]);
  });

  test("errors come back as tool errors, not exceptions", async () => {
    const { registered } = await activate(renderWebToolsMod({ enabled: true, port: 8080 }));
    const run = registered[1]?.run as (ctx: unknown) => Promise<unknown>;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "no", isError: true }))) as unknown as typeof fetch;
    expect(await run({ args: { url: "https://x" }, signal: new AbortController().signal })).toEqual(
      {
        status: "error",
        content: "no",
      },
    );
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const unreachable = (await run({ args: {}, signal: new AbortController().signal })) as {
      status: string;
      content: string;
    };
    expect(unreachable.status).toBe("error");
    expect(unreachable.content).toContain("ECONNREFUSED");
  });

  test("disabled, it registers nothing", async () => {
    const { registered } = await activate(renderWebToolsMod({ enabled: false, port: 8080 }));
    expect(registered).toEqual([]);
  });

  test("teardown", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

function memoryIo(initial: Record<string, string> = {}, agentExists = true) {
  const files = new Map(Object.entries(initial));
  const events: string[] = [];
  const io: ModsIo & McpIo = {
    credentials: { load: async () => ({}), save: async () => {} },
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
    async enableSkill(path) {
      events.push(`enable ${path}`);
    },
    async disableSkill(name) {
      events.push(`disable ${name}`);
    },
  };
  return { io, files, events };
}

describe("retireSeededDdgMcp", () => {
  const seeded: McpServer = {
    name: "duckduckgo",
    transport: "http",
    url: "http://ddg-mcp:8000/mcp",
  };
  const notes: McpServer = { name: "notes", command: "notes-mcp" };

  test("removes the seeded server once, and keeps one the user adds back later", async () => {
    const { io, files } = memoryIo({ [MCP_SETTINGS_PATH]: renderMcpSettings([seeded, notes]) });
    expect(await retireSeededDdgMcp(io, io)).toBe(true);
    expect(readMcpServers(files.get(MCP_SETTINGS_PATH) ?? "")).toEqual([notes]);
    expect(
      parseStoredWebToolsSettings(files.get(WEB_TOOLS_SETTINGS_PATH) ?? null).mcpDdgRetired,
    ).toBe(true);

    files.set(MCP_SETTINGS_PATH, renderMcpSettings([seeded, notes]));
    expect(await retireSeededDdgMcp(io, io)).toBe(false);
    expect(readMcpServers(files.get(MCP_SETTINGS_PATH) ?? "")).toEqual([seeded, notes]);
  });

  test("a differently configured duckduckgo is the user's, not the seed", async () => {
    const own: McpServer = {
      name: "duckduckgo",
      transport: "http",
      url: "http://elsewhere:9000/mcp",
    };
    const { io, files } = memoryIo({ [MCP_SETTINGS_PATH]: renderMcpSettings([own]) });
    expect(await retireSeededDdgMcp(io, io)).toBe(false);
    expect(readMcpServers(files.get(MCP_SETTINGS_PATH) ?? "")).toEqual([own]);
  });
});

describe("web-tools settings file", () => {
  test("the pre-rename file is still read, and nothing is mirrored back", async () => {
    const files = new Map([[WEB_TOOLS_SETTINGS_LEGACY_PATH, '{ "enabled": false }']]);
    const io = {
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, content: string) => {
        files.set(path, content);
      },
    };
    expect(await loadWebToolsSettings(io)).toMatchObject({ enabled: false });
    await saveWebToolsSettings(io, { enabled: true });
    // The current name is written; the old one is not kept in sync, because
    // nothing but the BFF ever reads this file.
    expect(files.has(WEB_TOOLS_SETTINGS_PATH)).toBe(true);
    expect(files.get(WEB_TOOLS_SETTINGS_LEGACY_PATH)).toBe('{ "enabled": false }');
  });
});

describe("settings", () => {
  test("saving the switch stores it and rejects a malformed one", async () => {
    const { io, files } = memoryIo();
    expect(await saveWebToolsSettings(io, { enabled: false })).toEqual({
      enabled: false,
      mcpDdgRetired: false,
    });
    expect(parseStoredWebToolsSettings(files.get(WEB_TOOLS_SETTINGS_PATH) ?? null).enabled).toBe(
      false,
    );
    await expect(saveWebToolsSettings(io, { enabled: "yes" })).rejects.toThrow(
      InvalidWebToolsSettingsError,
    );
  });

  test("parse is lenient and defaults to on", () => {
    expect(parseStoredWebToolsSettings(null)).toEqual({ enabled: true, mcpDdgRetired: false });
    expect(parseStoredWebToolsSettings("{nope")).toEqual({ enabled: true, mcpDdgRetired: false });
    expect(parseStoredWebToolsSettings('{"enabled":false}')).toEqual({
      enabled: false,
      mcpDdgRetired: false,
    });
  });

  test("an update may change only `enabled`", () => {
    const current = { enabled: true, mcpDdgRetired: true };
    expect(applyWebToolsSettingsUpdate(current, { enabled: false, mcpDdgRetired: false })).toEqual({
      enabled: false,
      mcpDdgRetired: true,
    });
    expect(() => applyWebToolsSettingsUpdate(current, null)).toThrow(InvalidWebToolsSettingsError);
  });
});

describe("modErrorsFrom", () => {
  test("picks this mod's errors out of letta-code's diagnostics report", () => {
    // `mod` is the owner object letta-code copies in (`mods/mod-diagnostics.ts`), not a path.
    const owner = (path: string) => ({
      id: `global:${path}`,
      path,
      scope: "global",
      generation: 1,
    });
    const report = JSON.stringify({
      report: {
        diagnostics: [
          {
            mod: owner("/root/.letta/mods/lettuce-web-tools.mjs"),
            phase: "import",
            message: "boom",
            severity: "error",
          },
          {
            mod: owner("/root/.letta/mods/other.ts"),
            phase: "import",
            message: "not ours",
            severity: "error",
          },
          {
            mod: owner("/root/.letta/mods/lettuce-web-tools.mjs"),
            phase: "activate",
            message: "meh",
            severity: "warning",
          },
        ],
      },
    });
    expect(modErrorsFrom(report)).toEqual(["import: boom"]);
    expect(modErrorsFrom(null)).toEqual([]);
    expect(modErrorsFrom("garbage")).toEqual([]);
  });
});
