import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolAccessStore, agentsWhere, parseToolAccess } from "./tool-access.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "tool-access-")), "agent-tool-access.json");

describe("AgentToolAccessStore", () => {
  test("an unknown agent gets everything", () => {
    const store = new AgentToolAccessStore(fileIn(), () => {});
    expect(store.get("agent-a")).toEqual({ codex: true, claude: true, google: "full", pi: true });
    expect(store.all()).toEqual({});
  });

  test("keeps only non-default entries, and survives a restart", async () => {
    const file = fileIn();
    const store = new AgentToolAccessStore(file, () => {});
    expect(store.set("agent-a", { codex: false, claude: true, google: "read", pi: true })).toBe(
      true,
    );
    expect(store.set("agent-b", { codex: true, claude: false, google: "off", pi: true })).toBe(
      true,
    );
    expect(store.set("agent-b", { codex: true, claude: false, google: "off", pi: true })).toBe(
      false,
    );
    expect(store.set("agent-b", { codex: true, claude: true, google: "full", pi: true })).toBe(
      true,
    );
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "agent-a": { codex: false, claude: true, google: "read", pi: true },
    });
    expect(new AgentToolAccessStore(file, () => {}).get("agent-a")).toEqual({
      codex: false,
      claude: true,
      google: "read",
      pi: true,
    });
  });

  test("a damaged file or entry falls back to the default", () => {
    const file = fileIn();
    writeFileSync(
      file,
      JSON.stringify({
        "agent-a": { codex: "no", google: "off" },
        "bad id": {},
        "agent-b": {
          codex: false,
          google: "off",
        },
      }),
    );
    const store = new AgentToolAccessStore(file, () => {});
    // `agent-b` predates the `claude` and `pi` fields: it loads with both at their default.
    expect(store.all()).toEqual({
      "agent-b": { codex: false, claude: true, google: "off", pi: true },
    });
    writeFileSync(file, "{not json");
    expect(new AgentToolAccessStore(file, () => {}).all()).toEqual({});
  });

  test("rejects what is not an agent id or not an access", () => {
    const store = new AgentToolAccessStore(fileIn(), () => {});
    expect(() =>
      store.set("a/b", { codex: true, claude: true, google: "full", pi: true }),
    ).toThrow();
    expect(parseToolAccess({ codex: true, google: "write" })).toBeNull();
    expect(parseToolAccess({ codex: true, claude: "yes", google: "full" })).toBeNull();
    expect(parseToolAccess(null)).toBeNull();
  });

  test("agentsWhere is sorted, so a rendered mod is stable", () => {
    expect(
      agentsWhere(
        {
          "agent-z": { codex: false, claude: true, google: "full", pi: true },
          "agent-a": { codex: false, claude: false, google: "off", pi: true },
          "agent-m": { codex: true, claude: false, google: "off", pi: true },
        },
        (a) => !a.codex,
      ),
    ).toEqual(["agent-a", "agent-z"]);
    expect(
      agentsWhere(
        {
          "agent-z": { codex: false, claude: true, google: "full", pi: true },
          "agent-a": { codex: false, claude: false, google: "off", pi: true },
          "agent-m": { codex: true, claude: false, google: "off", pi: true },
        },
        (a) => !a.claude,
      ),
    ).toEqual(["agent-a", "agent-m"]);
  });
});
