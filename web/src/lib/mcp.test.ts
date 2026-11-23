import { describe, expect, test } from "bun:test";
import {
  blankRow,
  draftOf,
  draftProblem,
  keepAll,
  type McpServerView,
  secretTags,
  wireOf,
} from "./mcp.ts";

const HA: McpServerView = {
  name: "home-assistant",
  transport: "http",
  url: "http://ha.example:8123/api/mcp",
  bearer: true,
  headerNames: ["X-Workspace"],
};
const GH: McpServerView = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
};

describe("keepAll", () => {
  test("an untouched http server keeps its token and headers with blanks", () => {
    expect(keepAll(HA)).toEqual({
      name: "home-assistant",
      was: "home-assistant",
      transport: "http",
      url: "http://ha.example:8123/api/mcp",
      bearer: "",
      headers: { "X-Workspace": "" },
    });
  });

  test("an untouched stdio server keeps its env, and sends no header fields", () => {
    expect(keepAll(GH)).toEqual({
      name: "github",
      was: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    });
  });

  test("a server with nothing saved sends no secret fields at all", () => {
    expect(keepAll({ name: "g", transport: "http", url: "http://g/mcp" })).toEqual({
      name: "g",
      was: "g",
      transport: "http",
      url: "http://g/mcp",
    });
  });
});

describe("wireOf", () => {
  test("adding Home Assistant: the typed token goes as the bearer", () => {
    const draft = { ...draftOf(null), name: "home-assistant", transport: "http" as const };
    draft.url = "http://ha.example:8123/api/mcp";
    draft.bearer = " eyJ-token ";
    expect(wireOf(draft)).toEqual({
      name: "home-assistant",
      transport: "http",
      url: "http://ha.example:8123/api/mcp",
      bearer: "eyJ-token",
    });
  });

  test("replace, remove and add", () => {
    const draft = draftOf(HA);
    draft.removeBearer = true;
    draft.headers = [
      { ...(draft.headers[0] as (typeof draft.headers)[0]), value: "ws-2" },
      { ...blankRow(), name: "X-Client", value: "lettuce" },
      blankRow(), // an empty new row is ignored
    ];
    const wire = wireOf(draft);
    expect(wire.bearer).toBeUndefined();
    expect(wire.headers).toEqual({ "X-Workspace": "ws-2", "X-Client": "lettuce" });
  });

  test("removing a saved row removes the secret", () => {
    const draft = draftOf(HA);
    draft.headers = [];
    expect(wireOf(draft).headers).toBeUndefined();
    expect(wireOf(draft).bearer).toBe("");
  });

  test("a rename carries the old name as `was`", () => {
    const draft = draftOf(HA);
    draft.name = "ha";
    expect(wireOf(draft)).toMatchObject({ name: "ha", was: "home-assistant" });
  });
});

describe("draftProblem", () => {
  test("a half-filled row holds Save instead of being dropped", () => {
    const draft = draftOf(HA);
    draft.headers = [...draft.headers, { ...blankRow(), name: "X-API-Key" }];
    expect(draftProblem(draft)).toContain("X-API-Key needs a value");
    const env = draftOf(GH);
    env.env = [...env.env, { ...blankRow(), value: "orphan" }];
    expect(draftProblem(env)).toContain("no name");
  });

  test("whitespace in a saved row's value keeps the saved secret", () => {
    const draft = draftOf(HA);
    draft.headers = [{ ...(draft.headers[0] as (typeof draft.headers)[0]), value: "  " }];
    expect(wireOf(draft).headers).toEqual({ "X-Workspace": "" });
  });

  test("a moved URL with a kept secret must be re-entered or removed", () => {
    const draft = draftOf(HA);
    draft.url = "http://other.example:8123/api/mcp";
    expect(draftProblem(draft)).toContain("different host");
    draft.bearer = "fresh";
    draft.headers = [];
    expect(draftProblem(draft)).toBeNull();
  });

  test("same host, different path is fine", () => {
    const draft = draftOf(HA);
    draft.url = "http://ha.example:8123/mcp_server/sse";
    expect(draftProblem(draft)).toBeNull();
  });

  test("a new server has nothing to keep", () => {
    expect(draftProblem({ ...draftOf(null), transport: "http", url: "http://x" })).toBeNull();
  });
});

describe("secretTags", () => {
  test("what is saved, by name", () => {
    expect(secretTags(HA)).toEqual(["Bearer token", "X-Workspace"]);
    expect(secretTags(GH)).toEqual(["env: GITHUB_PERSONAL_ACCESS_TOKEN"]);
  });
});
