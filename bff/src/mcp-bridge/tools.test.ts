import { describe, expect, test } from "bun:test";
import type { McpServer } from "../mcp/settings.ts";
import { McpCatalog } from "./catalog.ts";
import type { CallOptions, CallResult, ListedTool, McpClientPort } from "./client.ts";
import { BRIDGE_TOOL_SPECS, bridgeHandlers, picturePath } from "./tools.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const SERVER: McpServer = {
  name: "shots",
  transport: "http",
  url: "http://host.docker.internal:8765/mcp",
};
const TOOLS: ListedTool[] = [
  { name: "screenshot", description: "Picture of the page", annotations: { readOnlyHint: true } },
  { name: "navigate", description: "Go somewhere", annotations: { readOnlyHint: false } },
];

/** The bridge over one fake server whose every answer the test supplies. */
function harness(answer: CallResult) {
  const asked: CallOptions[] = [];
  const client: McpClientPort = {
    async listTools() {
      return TOOLS;
    },
    async callTool(_server, _tool, _args, options) {
      asked.push(options ?? {});
      return answer;
    },
  };
  const handlers = bridgeHandlers(
    new McpCatalog({ servers: async () => [SERVER], client }),
    client,
  );
  return {
    asked,
    call: (tool: string, toolArgs?: Record<string, unknown>) =>
      handlers.get("mcp_call")?.({ tool, arguments: toolArgs }) ??
      Promise.reject(new Error("no mcp_call handler")),
    write: (tool: string) =>
      handlers.get("mcp_call_write")?.({ tool }) ?? Promise.reject(new Error("no handler")),
  };
}

const picture = (text = "the page", extra: Record<string, unknown> = {}): CallResult => ({
  text,
  isError: false,
  images: [{ base64: PNG, mimeType: "image/png" }],
  ...extra,
});

describe("mcp_call with a picture", () => {
  test("asks the client for the pictures it can hand on", async () => {
    const bridge = harness(picture());
    await bridge.call("screenshot");
    expect(bridge.asked[0]).toEqual({ signal: undefined, images: true });
  });

  test("hands the bytes over as a workspace file and names it in the text", async () => {
    const answer = await harness(picture()).call("screenshot", { tab: "t1" });
    expect(answer.images).toEqual([
      {
        b64: PNG,
        path: expect.stringMatching(/^mcp\/shots-screenshot-\d{8}-\d{6}-[0-9a-f]{8}-1\.png$/),
      },
    ]);
    // The MOD writes the file where this path says, so the text and the path may
    // never disagree — that sentence is what the agent quotes as `![...](path)`.
    expect(answer.text).toContain("the page");
    expect(answer.text).toContain(`Saved to ${answer.images?.[0]?.path}.`);
    expect(answer.isError).toBe(false);
  });

  test("names the file even when the server said a great deal", async () => {
    // capText could cut the answer down to where it stopped naming the picture it
    // had just handed over, and then the agent quotes a path with no sentence.
    const answer = await harness(picture("x".repeat(30_000))).call("screenshot");
    expect(answer.text.length).toBeGreaterThan(30_000);
    expect(answer.images).toHaveLength(1);
    expect(answer.text.endsWith(`Saved to ${answer.images?.[0]?.path}.`)).toBe(true);
  });

  test("says where the picture went even when the server said nothing else", async () => {
    const answer = await harness(picture("")).call("screenshot");
    expect(answer.text.startsWith("The tool returned a picture.\nSaved to mcp/")).toBe(true);
  });

  test("gives its words and no picture when the tool reported failure", async () => {
    const answer = await harness({
      text: "the tab crashed",
      isError: true,
      images: [{ base64: PNG, mimeType: "image/png" }],
    }).call("screenshot");
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe("the tab crashed");
    expect(answer.images).toBeUndefined();
  });

  test("leaves a text-only answer exactly as it was", async () => {
    const answer = await harness({ text: "ok", isError: false }).call("screenshot");
    expect(answer).toEqual({ text: "ok", isError: false });
  });

  test("still refuses a tool that can change things", async () => {
    const answer = await harness({ text: "went", isError: false }).call("navigate");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("mcp_call_write");
  });

  test("says so when a tool does not exist", async () => {
    const answer = await harness({ text: "x", isError: false }).call("nope");
    expect(answer.text).toContain("No MCP tool named");
  });

  test("a write tool's picture travels too", async () => {
    const answer = await harness(picture("posted")).write("navigate");
    expect(answer.images).toHaveLength(1);
  });

  test("promises the picture in the description the agent reads", () => {
    for (const name of ["mcp_call", "mcp_call_write"]) {
      const spec = BRIDGE_TOOL_SPECS.find((one) => one.name === name);
      expect(spec?.description).toContain("saved into your workspace");
    }
  });
});

describe("picturePath", () => {
  test("is one path under the mcp directory, numbered", () => {
    expect(picturePath("shots", "screenshot", "image/png", 0, "STAMP", "deadbeef")).toBe(
      "mcp/shots-screenshot-STAMP-deadbeef-1.png",
    );
    expect(picturePath("shots", "screenshot", "image/jpeg", 2, "STAMP", "deadbeef")).toBe(
      "mcp/shots-screenshot-STAMP-deadbeef-3.jpg",
    );
    expect(picturePath("shots", "screenshot", "image/webp", 0, "STAMP", "deadbeef")).toContain(
      ".webp",
    );
  });

  test("does not repeat itself within the second the stamp is too coarse for", () => {
    expect(picturePath("shots", "screenshot", "image/png", 0, "STAMP")).not.toBe(
      picturePath("shots", "screenshot", "image/png", 0, "STAMP"),
    );
  });

  test("survives a server that names itself a path", () => {
    const path = picturePath("../../etc/passwd", "../bin sh", "image/gif", 0, "STAMP", "deadbeef");
    expect(path.split("/")).toHaveLength(2); // nothing but the directory
    expect(path.startsWith("mcp/")).toBe(true);
    expect(path).not.toContain("..");
    expect(path.endsWith(".gif")).toBe(true);
  });

  test("survives a server that names itself a novel", () => {
    // The MOD has to be able to write what the answer names: a name longer than a
    // filesystem component means a picture that was saved nowhere.
    const path = picturePath("a".repeat(400), "b".repeat(400), "image/png", 0, "STAMP", "deadbeef");
    const file = path.split("/")[1] ?? "";
    expect(file.length).toBeLessThan(120);
    expect(file).toContain(`${"a".repeat(40)}-${"b".repeat(40)}-`);
  });
});
