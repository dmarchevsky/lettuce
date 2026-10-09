import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
