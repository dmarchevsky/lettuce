import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plain .mjs shipped in the app-server image; outside both packages' typecheck.
import * as shim from "./claude-shim-core.mjs";

describe("settings", () => {
  test("absent or unreadable settings mean disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(shim.readShimSettings(dir)).toBeNull();
    expect(shim.isEnabled(null)).toBe(false);
    writeFileSync(join(dir, shim.SETTINGS_FILE), "{broken");
    expect(shim.readShimSettings(dir)).toBeNull();
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
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    writeFileSync(join(dir, shim.SETTINGS_FILE), JSON.stringify({ enabled: true }));
    expect(shim.isEnabled(shim.readShimSettings(dir))).toBe(true);
    expect(shim.isEnabled({ enabled: "yes" })).toBe(false);
  });

  test("CLAUDE_CONFIG_DIR wins over the default", () => {
    expect(shim.claudeConfigDir({ CLAUDE_CONFIG_DIR: "/root/.letta/claude" })).toBe(
      "/root/.letta/claude",
    );
    expect(shim.claudeConfigDir({})).toBe("/root/.letta/claude");
  });
});

/**
 * The entry script as PATH runs it, against a stub real binary — the switch,
 * its one exception, and what each of them gets in the environment.
 * `CLAUDE_REAL_BIN` is the shim's own test hook; the stub prints its argv and
 * the bearer token it was handed.
 */
const SHIM = new URL("./claude-shim.mjs", import.meta.url).pathname;
const STUB = (() => {
  const dir = mkdtempSync(join(tmpdir(), "claude-shim-bin-"));
  const file = join(dir, "real-claude");
  writeFileSync(file, '#!/bin/sh\necho "real-claude $* token=${ANTHROPIC_AUTH_TOKEN:-unset}"\n');
  chmodSync(file, 0o755);
  return file;
})();

function runShim(args: string[], settings: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  if (settings !== null) writeFileSync(join(dir, shim.SETTINGS_FILE), JSON.stringify(settings));
  return spawnSync(process.execPath, [SHIM, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: dir,
      CLAUDE_REAL_BIN: STUB,
      ANTHROPIC_AUTH_TOKEN: "",
    },
  });
}

describe("the switch, at the entry script", () => {
  test("--version answers with the worker off, on a clean environment", () => {
    for (const flag of ["--version", "-v", "-V"]) {
      const out = runShim([flag], { enabled: false });
      expect([out.status, out.stdout.trim()]).toEqual([0, `real-claude ${flag} token=unset`]);
    }
  });

  test("letta-code's preflight is refused with the worker off", () => {
    for (const settings of [{ enabled: false }, null] as const) {
      const out = runShim(["auth", "status", "--json"], settings);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain(shim.DISABLED_MESSAGE);
    }
  });

  test("a run gets the saved endpoint and token once enabled", () => {
    const out = runShim(["--print"], { enabled: true, authToken: "tok-1", model: "m-1" });
    expect(out.stdout.trim()).toBe("real-claude --print token=tok-1");
  });
});

describe("buildEnv", () => {
  const SETTINGS = {
    enabled: true,
    baseUrl: "http://proxy:4000",
    model: "claude-sonnet-4-5",
    authToken: "sk-real",
  };

  test("injects the saved endpoint settings as the env Claude Code reads", () => {
    const env = shim.buildEnv(SETTINGS, {});
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/root/.letta/claude",
      ANTHROPIC_BASE_URL: "http://proxy:4000",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_AUTH_TOKEN: "sk-real",
    });
  });

  test("an empty settings file still yields a token that passes the preflight", () => {
    const env = shim.buildEnv({}, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(shim.PLACEHOLDER_AUTH_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  test("a file saved before modes existed gets exactly the endpoint env", () => {
    const base = { PATH: "/usr/bin" };
    expect(shim.buildEnv(SETTINGS, base)).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/root/.letta/claude",
      ANTHROPIC_BASE_URL: "http://proxy:4000",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_AUTH_TOKEN: "sk-real",
    });
    const { authToken: _, ...tokenless } = SETTINGS;
    expect(shim.buildEnv(tokenless, base)).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/root/.letta/claude",
      ANTHROPIC_BASE_URL: "http://proxy:4000",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_AUTH_TOKEN: shim.PLACEHOLDER_AUTH_TOKEN,
    });
  });

  test("what the environment already carries wins", () => {
    const env = shim.buildEnv(SETTINGS, {
      CLAUDE_CONFIG_DIR: "/elsewhere",
      ANTHROPIC_BASE_URL: "http://explicit:1",
      ANTHROPIC_MODEL: "explicit-model",
      ANTHROPIC_AUTH_TOKEN: "explicit-token",
    });
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/elsewhere",
      ANTHROPIC_BASE_URL: "http://explicit:1",
      ANTHROPIC_MODEL: "explicit-model",
      ANTHROPIC_AUTH_TOKEN: "explicit-token",
    });
  });
});

describe("buildEnv in subscription mode", () => {
  const SUBSCRIPTION = {
    enabled: true,
    mode: "subscription",
    oauthToken: "sk-ant-oat01-secret",
    // Left over from endpoint mode; must not leak into a subscription run.
    baseUrl: "http://proxy:4000",
    authToken: "sk-proxy",
    model: "qwen3-coder",
    subscriptionModel: "",
  };

  test("injects only the OAuth token, never an endpoint or a bearer token", () => {
    expect(shim.buildEnv(SUBSCRIPTION, { PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/root/.letta/claude",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret",
    });
  });

  test("its own model, when set, is passed on; the endpoint's never is", () => {
    expect(shim.buildEnv({ ...SUBSCRIPTION, subscriptionModel: "opus" }, {}).ANTHROPIC_MODEL).toBe(
      "opus",
    );
    expect(shim.buildEnv(SUBSCRIPTION, {}).ANTHROPIC_MODEL).toBeUndefined();
  });

  test("an inherited endpoint, bearer token or API key is removed, not passed through", () => {
    const env = shim.buildEnv(SUBSCRIPTION, {
      ANTHROPIC_BASE_URL: "http://proxy:4000",
      ANTHROPIC_AUTH_TOKEN: "sk-proxy",
      ANTHROPIC_API_KEY: "sk-ant-api03-x",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-secret");
  });

  test("what the environment already carries wins", () => {
    const env = shim.buildEnv(SUBSCRIPTION, { CLAUDE_CODE_OAUTH_TOKEN: "explicit" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("explicit");
  });
});
