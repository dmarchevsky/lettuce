import { describe, expect, test } from "bun:test";
import type { McpServer } from "../mcp/settings.ts";
import {
  McpCatalog,
  publicSchema,
  qualifiedName,
  searchCatalog,
  toCatalogTools,
} from "../mcp-bridge/catalog.ts";
import type { ListedTool, McpClientPort } from "../mcp-bridge/client.ts";
import { bridgeHandlers, resolveTool, toolsForAgent } from "../mcp-bridge/tools.ts";
import fullFixture from "./fixtures/workspace-mcp-2.1.0.full.json";
import readonlyFixture from "./fixtures/workspace-mcp-2.1.0.readonly.json";
import {
  availableGoogleTools,
  CURATED_GOOGLE_TOOLS,
  googleHandlers,
  googleToolsHiddenAt,
} from "./tools.ts";

const GOOGLE_URL = "http://google-mcp:8000/mcp";
const google: McpServer = { name: "google", transport: "http", url: GOOGLE_URL };
const full = fullFixture as ListedTool[];
const readonly = readonlyFixture as ListedTool[];

function fakeClient(listing: ListedTool[]) {
  const calls: [string, string, Record<string, unknown>][] = [];
  const client: McpClientPort = {
    async listTools() {
      return listing;
    },
    async callTool(server, tool, args) {
      calls.push([server.name, tool, args]);
      return { text: `ran ${tool}`, isError: false };
    },
  };
  return { client, calls };
}

async function catalogOf(listing: ListedTool[], servers: McpServer[] = [google]) {
  const { client, calls } = fakeClient(listing);
  const catalog = new McpCatalog({ servers: async () => servers, client });
  await catalog.refresh();
  return { catalog, client, calls };
}

// ── The fixture is the contract with workspace-mcp ──────────────────────────
// Recorded from the pinned image (WORKSPACE_MCP_VERSION) — refresh it on every
// bump; these tests are what then say whether the curated mappings still fit.
describe("curated Google tools against workspace-mcp 2.1.0", () => {
  const byName = new Map(full.map((t) => [t.name, t]));

  test("every tool a curated tool needs exists", () => {
    for (const curated of CURATED_GOOGLE_TOOLS) {
      for (const need of curated.needs)
        expect(byName.has(need), `${curated.spec.name} → ${need}`).toBe(true);
    }
  });

  test("every argument a curated tool sets is one the underlying tool accepts", () => {
    const samples: Record<string, Record<string, unknown>[]> = {
      gmail_search: [{ query: "is:unread", max_results: 5 }],
      gmail_read: [{ message_id: "m1" }, { thread_id: "t1" }],
      gmail_send: [
        { to: "a@b.c", subject: "s", body: "b", cc: "c@d.e", bcc: "f@g.h", thread_id: "t1" },
      ],
      gmail_draft: [{ subject: "s", body: "b", to: "a@b.c", thread_id: "t1" }],
      calendar_events: [
        {
          time_min: "2026-09-29T00:00:00Z",
          time_max: "2026-09-30T00:00:00Z",
          query: "x",
          max_results: 3,
        },
      ],
      calendar_freebusy: [{ time_min: "2026-09-29T00:00:00Z", time_max: "2026-09-30T00:00:00Z" }],
      calendar_event: [
        {
          action: "create",
          summary: "s",
          start_time: "a",
          end_time: "b",
          description: "d",
          location: "l",
          attendees: ["x@y.z"],
        },
        { action: "delete", event_id: "e1" },
      ],
      tasks_list: [{}, { lists: true }],
      tasks_update: [
        { action: "create", title: "t", notes: "n", due: "2026-10-01T00:00:00Z" },
        { action: "complete", task_id: "k" },
      ],
      contacts_list: [{}, { query: "alice", max_results: 5 }],
      contacts_get: [{ contact_id: "c1" }],
      contacts_update: [
        {
          action: "create",
          given_name: "A",
          family_name: "B",
          email: "a@b.c",
          phone: "+15551234",
          organization: "Acme",
          job_title: "CEO",
          notes: "n",
        },
        { action: "update", contact_id: "c1", phone: "+15559999" },
        { action: "delete", contact_id: "c1" },
      ],
    };
    for (const curated of CURATED_GOOGLE_TOOLS) {
      for (const args of samples[curated.spec.name] ?? []) {
        const call = curated.build(args);
        if (typeof call === "string") throw new Error(`${curated.spec.name}: ${call}`);
        const schema = byName.get(call.tool)?.inputSchema as {
          properties: Record<string, unknown>;
          required?: string[];
        };
        for (const key of Object.keys(call.arguments)) {
          expect(
            Object.hasOwn(schema.properties, key),
            `${curated.spec.name} → ${call.tool}.${key}`,
          ).toBe(true);
        }
        for (const required of schema.required ?? []) {
          expect(Object.hasOwn(call.arguments, required), `${call.tool} needs ${required}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("approval follows the server's own read/write marking", () => {
    for (const curated of CURATED_GOOGLE_TOOLS) {
      const readOnly = curated.needs.every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === true,
      );
      expect(curated.spec.approval, curated.spec.name).toBe(readOnly ? "auto" : "ask");
    }
  });
});

describe("availableGoogleTools", () => {
  test("full access offers every curated tool", async () => {
    const { catalog } = await catalogOf(full);
    const { specs, server } = availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL);
    expect(specs.map((s) => s.name)).toEqual(CURATED_GOOGLE_TOOLS.map((c) => c.spec.name));
    expect(server?.name).toBe("google");
  });

  test("read-only levels never show a write tool", async () => {
    const { catalog } = await catalogOf(readonly);
    const names = availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL).specs.map(
      (s) => s.name,
    );
    expect(names).toEqual([
      "gmail_search",
      "gmail_read",
      "calendar_events",
      "calendar_freebusy",
      "tasks_list",
      "contacts_list",
      "contacts_get",
    ]);
  });

  test("no Google server, no Google tools", async () => {
    const { catalog } = await catalogOf(full, [
      { name: "other", transport: "http", url: "http://other:1/mcp" },
    ]);
    expect(availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL)).toEqual({
      specs: [],
      server: null,
    });
  });
});

describe("googleHandlers", () => {
  test("a curated call becomes the underlying tool call", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    const answer = await handlers.get("tasks_update")?.({ action: "complete", task_id: "k1" });
    expect(answer).toEqual({ text: "ran manage_task", isError: false });
    expect(calls).toEqual([
      [
        "google",
        "manage_task",
        { action: "update", task_list_id: "@default", task_id: "k1", status: "completed" },
      ],
    ]);
  });

  test("a tool the grant no longer allows answers with why", async () => {
    const { catalog, client } = await catalogOf(readonly);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    const answer = await handlers.get("gmail_send")?.({ to: "a@b.c", subject: "s", body: "b" });
    expect(answer?.isError).toBe(true);
    expect(answer?.text).toContain("Settings → Google");
  });

  test("bad arguments are explained before anything is called", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    expect((await handlers.get("calendar_event")?.({ action: "update" }))?.text).toContain(
      "event_id",
    );
    expect((await handlers.get("gmail_read")?.({}))?.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("a lost Google sign-in", () => {
  const AUTH_FAILURE =
    "Error calling tool 'get_events': invalid_grant: Token has been expired or revoked.";
  function failingClient(listing: ListedTool[]) {
    const client: McpClientPort = {
      async listTools() {
        return listing;
      },
      async callTool() {
        return { text: AUTH_FAILURE, isError: true };
      },
    };
    return client;
  }
  const port = () => {
    const lost: string[] = [];
    return {
      lost,
      publicOrigin: "https://letta.example",
      markLost: async (why: string) => {
        lost.push(why);
        return { email: "me@example.com" };
      },
    };
  };

  test("a curated tool tells the agent to send the user to reconnect", async () => {
    const client = failingClient(full);
    const catalog = new McpCatalog({ servers: async () => [google], client });
    await catalog.refresh();
    const lostAccess = port();
    const answer = await googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
      lostAccess,
    }).get("calendar_events")?.({});
    expect(answer?.isError).toBe(true);
    expect(answer?.text).toContain("https://letta.example/api/google/reconnect");
    expect(lostAccess.lost).toHaveLength(1);
  });

  test("so does mcp_call on the Google server, but not on another server", async () => {
    const other: McpServer = { name: "other", transport: "http", url: "http://other/mcp" };
    const client = failingClient(full);
    const catalog = new McpCatalog({ servers: async () => [google, other], client });
    await catalog.refresh();
    const lostAccess = port();
    const handlers = bridgeHandlers(catalog, client, { url: GOOGLE_URL, lostAccess });
    const onGoogle = await handlers.get("mcp_call")?.({
      tool: "mcp__google__get_events",
      arguments: {},
    });
    expect(onGoogle?.text).toContain("/api/google/reconnect");
    const onOther = await handlers.get("mcp_call")?.({
      tool: "mcp__other__get_events",
      arguments: {},
    });
    expect(onOther?.text).toContain("invalid_grant");
    expect(lostAccess.lost).toHaveLength(1);
  });
});

describe("the MCP bridge", () => {
  test("names follow upstream's mcp__<server>__<tool>, and the account parameter is hidden", async () => {
    const { catalog } = await catalogOf(full);
    const search = catalog.snapshot().tools.find((t) => t.tool === "search_gmail_messages");
    expect(search?.qualified).toBe("mcp__google__search_gmail_messages");
    expect(search?.readOnly).toBe(true);
    expect(Object.keys((search?.inputSchema.properties as object) ?? {})).not.toContain(
      "user_google_email",
    );
    expect(qualifiedName("my server", "x")).toBe("mcp__my_server__x");
    expect(
      publicSchema({
        type: "object",
        properties: { user_google_email: {}, a: {} },
        required: ["user_google_email", "a"],
      }),
    ).toEqual({
      type: "object",
      properties: { a: {} },
      required: ["a"],
    });
  });

  test("search ranks by what the tool does", async () => {
    const { catalog } = await catalogOf(full);
    const hits = searchCatalog(catalog.snapshot().tools, "gmail labels");
    expect(hits[0]?.tool).toMatch(/label/);
    expect(searchCatalog(catalog.snapshot().tools, "free busy calendar")[0]?.tool).toBe(
      "query_freebusy",
    );
  });

  test("mcp_call runs only read-only tools; writes go through mcp_call_write", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = bridgeHandlers(catalog, client);
    const refused = await handlers.get("mcp_call")?.({
      tool: "mcp__google__send_gmail_message",
      arguments: {},
    });
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("mcp_call_write");
    expect(calls).toEqual([]);
    expect(
      await handlers.get("mcp_call")?.({ tool: "list_gmail_labels", arguments: "{}" }),
    ).toEqual({
      text: "ran list_gmail_labels",
      isError: false,
    });
    expect(
      await handlers.get("mcp_call_write")?.({
        tool: "mcp__google__send_gmail_message",
        arguments: { to: "a@b.c" },
      }),
    ).toEqual({
      text: "ran send_gmail_message",
      isError: false,
    });
    expect(calls.map((c) => c[1])).toEqual(["list_gmail_labels", "send_gmail_message"]);
  });

  test("an unannotated tool counts as a write", async () => {
    const { catalog } = await catalogOf(full);
    expect(
      catalog.snapshot().tools.find((t) => t.tool === "get_gmail_attachment_content")?.readOnly,
    ).toBe(false);
  });

  test("describe and search speak in the names the model will call", async () => {
    const { catalog, client } = await catalogOf(full);
    const handlers = bridgeHandlers(catalog, client);
    const search = await handlers.get("mcp_search")?.({ query: "send email" });
    expect(search?.text).toContain("mcp__google__send_gmail_message");
    expect(search?.text).toContain("[writes]");
    const describe = await handlers.get("mcp_describe")?.({ tool: "mcp__google__get_events" });
    expect(describe?.text).toContain("read-only: run with mcp_call");
    expect(describe?.text).not.toContain("user_google_email");
    expect(resolveTool(catalog.snapshot().tools, "nope")).toContain("mcp_search");
  });

  test("no servers: the bridge says so instead of guessing", async () => {
    const { catalog, client } = await catalogOf(full, []);
    const answer = await bridgeHandlers(catalog, client).get("mcp_search")?.({ query: "x" });
    expect(answer).toEqual({ text: "No MCP servers are available right now.", isError: true });
  });

  test("stdio servers are not bridged", async () => {
    const { catalog } = await catalogOf(full, [
      { name: "local", transport: "stdio", command: "x" },
    ]);
    expect(catalog.snapshot().tools).toEqual([]);
  });

  test("a server that fails to list is reported and skipped", async () => {
    const client: McpClientPort = {
      async listTools() {
        throw new Error("connect ECONNREFUSED");
      },
      async callTool() {
        return { text: "", isError: false };
      },
    };
    const catalog = new McpCatalog({ servers: async () => [google], client });
    await catalog.refresh();
    expect(catalog.snapshot().tools).toEqual([]);
    expect(catalog.snapshot().failures.get("google")).toContain("ECONNREFUSED");
    expect(toCatalogTools(google, [])).toEqual([]);
  });
});

describe("per-agent Google access", () => {
  const accessFor = (agentId: string | null) =>
    agentId === "agent-off" ? "off" : agentId === "agent-read" ? "read" : "full";

  test("read-only hides exactly the curated writes; off hides them all", () => {
    expect(googleToolsHiddenAt("full")).toEqual([]);
    const writes = CURATED_GOOGLE_TOOLS.filter((c) => c.spec.approval === "ask").map(
      (c) => c.spec.name,
    );
    expect(googleToolsHiddenAt("read")).toEqual(writes);
    expect(googleToolsHiddenAt("read")).toContain("gmail_send");
    expect(googleToolsHiddenAt("off")).toEqual(CURATED_GOOGLE_TOOLS.map((c) => c.spec.name));
  });

  test("a curated call from a blocked agent is refused before Google is called", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
      accessFor,
    });
    const send = { to: "a@b.c", subject: "s", body: "b" };
    const refused = await handlers.get("gmail_send")?.(send, { agentId: "agent-read" });
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("read-only");
    expect(
      (await handlers.get("gmail_search")?.({ query: "x" }, { agentId: "agent-off" }))?.isError,
    ).toBe(true);
    expect(calls).toEqual([]);
    expect(
      (await handlers.get("gmail_search")?.({ query: "x" }, { agentId: "agent-read" }))?.isError,
    ).toBe(false);
  });

  test("the bridge shows an agent only the Google tools it may use", async () => {
    const other: McpServer = { name: "notes", transport: "http", url: "http://notes/mcp" };
    const { catalog, client, calls } = await catalogOf(full, [google, other]);
    const tools = await catalog.current();
    const googleCount = tools.filter((t) => t.server.url === GOOGLE_URL).length;
    expect(toolsForAgent(tools, GOOGLE_URL, "full")).toHaveLength(tools.length);
    expect(toolsForAgent(tools, GOOGLE_URL, "off")).toHaveLength(tools.length - googleCount);
    expect(
      toolsForAgent(tools, GOOGLE_URL, "read").every((t) => t.readOnly || t.server === other),
    ).toBe(true);

    const handlers = bridgeHandlers(catalog, client, {
      url: GOOGLE_URL,
      lostAccess: { publicOrigin: "https://x", markLost: async () => null },
      accessFor,
    });
    const offCall = await handlers.get("mcp_call")?.(
      { tool: "mcp__google__list_gmail_labels" },
      { agentId: "agent-off" },
    );
    expect(offCall?.isError).toBe(true);
    const readWrite = await handlers.get("mcp_call_write")?.(
      { tool: "mcp__google__send_gmail_message", arguments: {} },
      { agentId: "agent-read" },
    );
    expect(readWrite?.isError).toBe(true);
    expect(calls).toEqual([]);
    const readRead = await handlers.get("mcp_call")?.(
      { tool: "mcp__google__list_gmail_labels" },
      { agentId: "agent-read" },
    );
    expect(readRead).toEqual({ text: "ran list_gmail_labels", isError: false });
  });
});
