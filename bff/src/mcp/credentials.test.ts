import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CredentialsMap,
  credentialedServerNames,
  McpCredentialsStore,
  McpCredentialsUnreadableError,
  migrateFileHeaders,
  originOf,
  parseStoredCredentials,
  publicMcpServers,
  resolveMcpUpdate,
  withCredentials,
} from "./credentials.ts";
import { InvalidMcpServersError, type McpServer } from "./settings.ts";

const HA_URL = "http://ha.example:8123/api/mcp";
const HA: McpServer = { name: "home-assistant", transport: "http", url: HA_URL };
const GH: McpServer = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
};
const SAVED: CredentialsMap = {
  "home-assistant": {
    origin: "http://ha.example:8123",
    bearer: "ha-token",
    headers: { "X-Workspace": "ws-1" },
  },
};

function refuses(run: () => unknown, message: string) {
  expect(run).toThrow(InvalidMcpServersError);
  expect(run).toThrow(message);
}

describe("originOf", () => {
  test("scheme, host and port; nothing for what a token must not go to", () => {
    expect(originOf("http://ha.example:8123/api/mcp")).toBe("http://ha.example:8123");
    expect(originOf("https://mcp.example.com/mcp")).toBe("https://mcp.example.com");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("publicMcpServers", () => {
  const view = publicMcpServers([HA, GH], SAVED);

  // The property this whole feature exists for.
  test("never carries a secret value", () => {
    const json = JSON.stringify(view);
    for (const secret of ["ha-token", "ws-1", "ghp_secret"]) expect(json).not.toContain(secret);
  });

  test("names and flags instead", () => {
    expect(view[0]).toEqual({
      name: "home-assistant",
      transport: "http",
      url: HA_URL,
      bearer: true,
      headerNames: ["X-Workspace"],
    });
    expect(view[1]?.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  });

  test("credentials for another origin are not reported (and not sent)", () => {
    const moved = { ...HA, url: "http://elsewhere.example:8123/api/mcp" };
    expect(publicMcpServers([moved], SAVED)[0]).toMatchObject({ bearer: false, headerNames: [] });
  });
});

describe("withCredentials", () => {
  test("attaches the bearer token and custom headers to the server object", () => {
    const [server] = withCredentials([HA], SAVED);
    expect(server?.headers).toEqual({
      "X-Workspace": "ws-1",
      Authorization: "Bearer ha-token",
    });
  });

  test("a URL that now points elsewhere gets nothing", () => {
    const moved = { ...HA, url: "http://evil.example/api/mcp" };
    expect(withCredentials([moved], SAVED)[0]?.headers).toBeUndefined();
  });

  test("stdio servers and servers with nothing saved pass through untouched", () => {
    const other: McpServer = { name: "other", transport: "http", url: "http://o.example/mcp" };
    expect(withCredentials([GH, other], SAVED)).toEqual([GH, other]);
  });

  test("credentialedServerNames lists exactly the servers that get a secret", () => {
    expect([...credentialedServerNames([HA, GH], SAVED)]).toEqual(["home-assistant"]);
  });
});

describe("resolveMcpUpdate", () => {
  const haInput = (extra: Record<string, unknown> = {}) => ({
    name: "home-assistant",
    transport: "http",
    url: HA_URL,
    ...extra,
  });

  test("a new token is stored, tied to the URL's origin, and kept out of the entry", () => {
    const { entries, credentials } = resolveMcpUpdate([haInput({ bearer: " tok " })], [], {});
    expect(credentials).toEqual({
      "home-assistant": { origin: "http://ha.example:8123", bearer: "tok" },
    });
    expect(JSON.stringify(entries)).not.toContain("tok");
  });

  test("a blank keeps the saved token and header", () => {
    const { credentials } = resolveMcpUpdate(
      [haInput({ bearer: "", headers: { "X-Workspace": "" } })],
      [HA],
      SAVED,
    );
    expect(credentials).toEqual(SAVED);
  });

  test("a value replaces; a secret left out is removed", () => {
    const { credentials } = resolveMcpUpdate([haInput({ bearer: "new-token" })], [HA], SAVED);
    expect(credentials).toEqual({
      "home-assistant": { origin: "http://ha.example:8123", bearer: "new-token" },
    });
  });

  test("leaving every secret out removes the server's credentials entirely", () => {
    expect(resolveMcpUpdate([haInput()], [HA], SAVED).credentials).toEqual({});
  });

  test("a rename keeps its secrets through `was`", () => {
    const { credentials } = resolveMcpUpdate(
      [{ ...haInput({ bearer: "" }), name: "ha", was: "home-assistant" }],
      [HA],
      SAVED,
    );
    expect(credentials).toEqual({ ha: { origin: "http://ha.example:8123", bearer: "ha-token" } });
  });

  test("keeping a secret after the URL moved to another host is refused", () => {
    refuses(
      () =>
        resolveMcpUpdate(
          [haInput({ url: "http://other.example:8123/api/mcp", bearer: "" })],
          [HA],
          SAVED,
        ),
      "points at a different host",
    );
  });

  test("re-entering it after the move is fine", () => {
    const { credentials } = resolveMcpUpdate(
      [haInput({ url: "https://other.example/api/mcp", bearer: "fresh" })],
      [HA],
      SAVED,
    );
    expect(credentials["home-assistant"]).toEqual({
      origin: "https://other.example",
      bearer: "fresh",
    });
  });

  test("a blank with nothing saved is refused", () => {
    refuses(() => resolveMcpUpdate([haInput({ bearer: "" })], [HA], {}), "no saved value");
    refuses(
      () => resolveMcpUpdate([haInput({ headers: { "X-Other": "" } })], [HA], SAVED),
      "no saved value",
    );
  });

  test("an Authorization header next to a bearer token is refused", () => {
    refuses(
      () => resolveMcpUpdate([haInput({ bearer: "t", headers: { authorization: "x" } })], [], {}),
      "keep one",
    );
  });

  test("bad header names, duplicates and line breaks are refused", () => {
    refuses(
      () => resolveMcpUpdate([haInput({ headers: { "X Bad": "v" } })], [], {}),
      "not a header name",
    );
    refuses(
      () => resolveMcpUpdate([haInput({ headers: { "X-A": "1", "x-a": "2" } })], [], {}),
      "listed twice",
    );
    refuses(
      () => resolveMcpUpdate([haInput({ bearer: "a\r\nX-Injected: 1" })], [], {}),
      "line break",
    );
  });

  test("a secret needs an http(s) URL to go to", () => {
    refuses(
      () => resolveMcpUpdate([haInput({ url: "not a url", bearer: "t" })], [], {}),
      "http(s) URL",
    );
  });

  test("secrets on the wrong transport are refused", () => {
    refuses(
      () => resolveMcpUpdate([{ name: "g", command: "x", bearer: "t" }], [], {}),
      "only for http and sse",
    );
    refuses(() => resolveMcpUpdate([haInput({ env: { A: "1" } })], [], {}), "only for stdio");
  });

  test("stdio env: blank keeps the value in the shared file, a value replaces, left out is gone", () => {
    const input = {
      name: "github",
      transport: "stdio",
      command: "npx",
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "", EXTRA: "1" },
    };
    const { entries } = resolveMcpUpdate([input], [GH], {});
    expect((entries[0] as McpServer).env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret",
      EXTRA: "1",
    });
    const { entries: none } = resolveMcpUpdate([{ ...input, env: {} }], [GH], {});
    expect((none[0] as McpServer).env).toBeUndefined();
  });

  test("a kept env entry passes whatever its name; only typed names are checked", () => {
    const odd: McpServer = {
      name: "x",
      transport: "stdio",
      command: "foo",
      env: { "my-var": "1" },
    };
    const { entries } = resolveMcpUpdate(
      [{ name: "x", transport: "stdio", command: "foo", env: { "my-var": "" } }],
      [odd],
      {},
    );
    expect((entries[0] as McpServer).env).toEqual({ "my-var": "1" });
  });

  test("a multi-line env value (a PEM key) is accepted", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    const { entries } = resolveMcpUpdate(
      [{ name: "g", transport: "stdio", command: "x", env: { KEY: pem } }],
      [],
      {},
    );
    expect((entries[0] as McpServer).env).toEqual({ KEY: pem });
  });

  test("a ${VAR} reference in the shared file is kept or removed like a saved header", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: upstream's literal `${VAR}` header syntax
    const withRef: McpServer = { ...HA, headers: { "X-Token": "${HA_TOKEN}" } };
    expect(publicMcpServers([withRef], {})[0]?.headerNames).toEqual(["X-Token"]);
    const kept = resolveMcpUpdate([haInput({ headers: { "X-Token": "" } })], [withRef], {});
    expect((kept.entries[0] as McpServer).headers).toEqual(withRef.headers);
    expect(kept.credentials).toEqual({});
    const removed = resolveMcpUpdate([haInput()], [withRef], {});
    expect((removed.entries[0] as McpServer).headers).toBeUndefined();
  });

  test("an env name a shell cannot hold is refused", () => {
    refuses(
      () => resolveMcpUpdate([{ name: "g", command: "x", env: { "1BAD": "v" } }], [], {}),
      "not a variable name",
    );
  });

  test("credentials of servers no longer listed are dropped", () => {
    expect(resolveMcpUpdate([], [HA], SAVED).credentials).toEqual({});
  });

  // The editor builds its entries from what GET returned; those flags must
  // never be written into the shared file as if they were fields.
  test("the GET view's flags are not mistaken for secrets", () => {
    refuses(() => resolveMcpUpdate([haInput({ bearer: true })], [HA], SAVED), "must be text");
  });
});

describe("migrateFileHeaders", () => {
  test("hand-written headers leave the shared file; Bearer becomes the token", () => {
    const handWritten: McpServer = {
      ...HA,
      headers: { Authorization: "Bearer abc", "X-Key": "k" },
    };
    const { servers, credentials, moved } = migrateFileHeaders([handWritten, GH], {});
    expect(servers).toEqual([HA, GH]);
    expect(credentials).toEqual({
      "home-assistant": {
        origin: "http://ha.example:8123",
        bearer: "abc",
        headers: { "X-Key": "k" },
      },
    });
    expect(moved).toEqual([{ name: "home-assistant", count: 2 }]);
  });

  // A reference, not a secret: `letta mcp` expands it from the app-server env,
  // so moving it would break subagents and gain nothing.
  test("an upstream ${VAR} reference stays in the shared file", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: upstream's literal `${VAR}` header syntax
    const reference = { Authorization: "Bearer ${HA_TOKEN}" };
    const placeholder: McpServer = { ...HA, headers: { ...reference, "X-Key": "k" } };
    const { servers, credentials, moved } = migrateFileHeaders([placeholder], {});
    expect(servers[0]?.headers).toEqual(reference);
    expect(credentials["home-assistant"]).toEqual({
      origin: "http://ha.example:8123",
      headers: { "X-Key": "k" },
    });
    expect(moved).toEqual([{ name: "home-assistant", count: 1 }]);
  });

  // resolveMcpUpdate refuses a token next to an Authorization header; the
  // migration must never produce that pair, or every later save is refused.
  test("a moved Authorization replaces the saved token, never sits beside it", () => {
    const basic: McpServer = { ...HA, headers: { Authorization: "Basic abc" } };
    const { credentials } = migrateFileHeaders([basic], SAVED);
    expect(credentials["home-assistant"]).toEqual({
      origin: "http://ha.example:8123",
      headers: { "X-Workspace": "ws-1", Authorization: "Basic abc" },
    });
    const view = publicMcpServers([HA], credentials)[0];
    const keep = {
      ...HA,
      bearer: view?.bearer ? "" : undefined,
      headers: Object.fromEntries((view?.headerNames ?? []).map((n) => [n, ""])),
    };
    expect(() => resolveMcpUpdate([keep], [HA], credentials)).not.toThrow();
  });

  test("nothing to move is a no-op", () => {
    const { servers, moved } = migrateFileHeaders([HA, GH], SAVED);
    expect(servers).toEqual([HA, GH]);
    expect(moved).toEqual([]);
  });
});

describe("McpCredentialsStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-creds-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips through a 0600 file; a missing file reads as empty", async () => {
    const store = new McpCredentialsStore(join(dir, "mcp", "credentials.json"));
    expect(await store.load()).toEqual({});
    await store.save(SAVED);
    expect(await store.load()).toEqual(SAVED);
    expect(statSync(join(dir, "mcp", "credentials.json")).mode & 0o777).toBe(0o600);
  });

  // A save writes the whole map back: a file read as "empty" by mistake would
  // wipe every token on the next save, so only a missing file is empty.
  test("an unreadable or damaged file throws instead of reading as empty", async () => {
    expect(() => parseStoredCredentials("{not json")).toThrow(McpCredentialsUnreadableError);
    expect(() => parseStoredCredentials("[]")).toThrow(McpCredentialsUnreadableError);
    const store = new McpCredentialsStore(dir); // a directory: EISDIR
    await expect(store.load()).rejects.toThrow(McpCredentialsUnreadableError);
  });

  test("a malformed entry in a good file is dropped", () => {
    expect(
      parseStoredCredentials(JSON.stringify({ servers: { a: { bearer: "no origin" } } })),
    ).toEqual({});
  });
});
