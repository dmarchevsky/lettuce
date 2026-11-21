import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plain .mjs shipped in the app-server image; outside both packages' typecheck.
import * as shim from "./shim-core.mjs";

/** The `turn/start` letta-code sends (tools/impl/codex-app-server.ts). */
const TURN_START = {
  jsonrpc: "2.0",
  id: 3,
  method: "turn/start",
  params: {
    threadId: "t1",
    input: [{ type: "text", text: "hi" }],
    cwd: "/work/agent-1",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/work/agent-1"],
      networkAccess: true,
    },
  },
};

describe("rewriteLine", () => {
  test("replaces only the sandbox policy on turn/start", () => {
    const out = JSON.parse(shim.rewriteLine(JSON.stringify(TURN_START)));
    expect(out.params.sandboxPolicy).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
    expect(out.params.cwd).toBe("/work/agent-1");
    expect(out.params.approvalPolicy).toBe("never");
    expect(out.id).toBe(3);
  });

  test("lines without a sandbox policy pass through byte for byte", () => {
    const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":null}}';
    expect(shim.rewriteLine(init)).toBe(init);
    // thread/start carries `sandbox`, which Codex accepts; it is left alone.
    const start = '{"id":2,"method":"thread/start","params":{"sandbox":"workspace-write"}}';
    expect(shim.rewriteLine(start)).toBe(start);
    expect(shim.rewriteLine("not json")).toBe("not json");
    expect(shim.rewriteLine("null")).toBe("null");
  });
});

describe("settings", () => {
  test("absent or unreadable settings mean disabled", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(shim.readShimSettings(home)).toBeNull();
    expect(shim.isEnabled(null)).toBe(false);
    writeFileSync(join(home, shim.SETTINGS_FILE), "{broken");
    expect(shim.readShimSettings(home)).toBeNull();
  });

  test("the settings file under its pre-rename name still counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "shim-legacy-"));
    writeFileSync(join(dir, shim.SETTINGS_FILE_LEGACY), JSON.stringify({ enabled: true }));
    expect(shim.isEnabled(shim.readShimSettings(dir))).toBe(true);
    // The current name wins once the BFF has written it.
    writeFileSync(join(dir, shim.SETTINGS_FILE), JSON.stringify({ enabled: false }));
    expect(shim.isEnabled(shim.readShimSettings(dir))).toBe(false);
  });

  test("only an explicit true enables", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeFileSync(join(home, shim.SETTINGS_FILE), JSON.stringify({ enabled: true }));
    expect(shim.isEnabled(shim.readShimSettings(home))).toBe(true);
    expect(shim.isEnabled({ enabled: "yes" })).toBe(false);
  });

  test("CODEX_HOME wins over HOME", () => {
    expect(shim.codexHome({ CODEX_HOME: "/root/.letta/codex", HOME: "/root" })).toBe(
      "/root/.letta/codex",
    );
    expect(shim.codexHome({ HOME: "/home/x" })).toBe("/home/x/.codex");
  });

  test("app-server is the subcommand whatever precedes it", () => {
    expect(shim.isAppServerInvocation(["app-server", "--stdio"])).toBe(true);
    // 0.34.44 can prepend Codex CLI overrides when it proxies a worker's model calls.
    expect(
      shim.isAppServerInvocation([
        "-c",
        'model_provider="letta_trace"',
        "-c",
        "model_providers.letta_trace.supports_websockets=false",
        "app-server",
        "--stdio",
      ]),
    ).toBe(true);
    expect(shim.isAppServerInvocation(["--config", "k=v", "app-server"])).toBe(true);
    // The named limit: an option that takes a separate value is read as the subcommand.
    // No upstream or Codex invocation does this today (`-c k=v` is the only such flag upstream emits).
    expect(shim.isAppServerInvocation(["--sandbox", "workspace-write", "app-server"])).toBe(false);
    // The preflight and a plain turn are not the app-server: their stdin is not JSON-RPC.
    expect(shim.isAppServerInvocation(["--version"])).toBe(false);
    expect(shim.isAppServerInvocation(["exec", "-"])).toBe(false);
    expect(shim.isAppServerInvocation([])).toBe(false);
  });
});

/**
 * The entry script as PATH runs it, against a stub real binary — the switch and
 * its one exception, end to end. `CODEX_REAL_BIN` is the shim's own test hook.
 */
const SHIM = new URL("./codex-shim.mjs", import.meta.url).pathname;
const STUB = (() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-shim-bin-"));
  const file = join(dir, "real-codex");
  writeFileSync(file, '#!/bin/sh\necho "real-codex $*"\n');
  chmodSync(file, 0o755);
  return file;
})();

function runShim(args: string[], enabled: boolean | null) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  if (enabled !== null) {
    writeFileSync(join(home, shim.SETTINGS_FILE), JSON.stringify({ enabled }));
  }
  return spawnSync(process.execPath, [SHIM, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home, CODEX_REAL_BIN: STUB },
  });
}

describe("the switch, at the entry script", () => {
  test("--version answers with the worker off, and runs the real CLI", () => {
    for (const flag of ["--version", "-V"]) {
      const out = runShim([flag], false);
      expect([out.status, out.stdout.trim()]).toEqual([0, `real-codex ${flag}`]);
    }
  });

  test("a version flag beside anything else is not a version call", () => {
    const out = runShim(["--version", "app-server"], false);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(shim.DISABLED_MESSAGE);
  });

  test("execution is refused with the worker off, both disabled spellings", () => {
    for (const enabled of [false, null] as const) {
      const out = runShim(["app-server", "--stdio"], enabled);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain(shim.DISABLED_MESSAGE);
      expect(out.stdout).toBe("");
    }
  });

  test("the same calls run once the worker is enabled", () => {
    expect(runShim(["--version"], true).stdout.trim()).toBe("real-codex --version");
    expect(runShim(["app-server", "--stdio"], true).stdout.trim()).toBe(
      "real-codex app-server --stdio",
    );
  });
});
