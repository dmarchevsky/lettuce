import { describe, expect, test } from "bun:test";
import {
  applyClaudeSettingsUpdate,
  DEFAULT_CLAUDE_SETTINGS,
  InvalidClaudeSettingsError,
  parseStoredClaudeSettings,
  renderStoredClaudeSettings,
  toPublicClaudeSettings,
} from "./settings.ts";

describe("parseStoredClaudeSettings", () => {
  test("absent, broken or non-object files fall back to defaults", () => {
    expect(parseStoredClaudeSettings(null)).toEqual(DEFAULT_CLAUDE_SETTINGS);
    expect(parseStoredClaudeSettings("{broken")).toEqual(DEFAULT_CLAUDE_SETTINGS);
    expect(parseStoredClaudeSettings("[1]")).toEqual(DEFAULT_CLAUDE_SETTINGS);
  });

  test("fills gaps in a hand-edited file", () => {
    const parsed = parseStoredClaudeSettings(JSON.stringify({ enabled: true, model: " m " }));
    expect(parsed).toEqual({
      enabled: true,
      mode: "endpoint",
      baseUrl: "",
      model: "m",
      authToken: null,
      oauthToken: null,
      subscriptionModel: "",
    });
  });

  test("a file saved before modes existed is endpoint mode, every field kept", () => {
    const old = { enabled: true, baseUrl: "http://p:4000", model: "m", authToken: "sk-x" };
    expect(parseStoredClaudeSettings(JSON.stringify(old))).toEqual({
      ...old,
      mode: "endpoint",
      oauthToken: null,
      subscriptionModel: "",
    });
    expect(parseStoredClaudeSettings(JSON.stringify({ ...old, mode: "bogus" })).mode).toBe(
      "endpoint",
    );
  });
});

describe("applyClaudeSettingsUpdate", () => {
  const READY = { baseUrl: "http://proxy:4000", model: "claude-sonnet-4-5" };

  test("enabling requires an endpoint and a model", () => {
    expect(() => applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { enabled: true })).toThrow(
      InvalidClaudeSettingsError,
    );
    const next = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { ...READY, enabled: true });
    expect(next.enabled).toBe(true);
  });

  test("the token is write-only: absent keeps it, empty clears it", () => {
    const withToken = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      ...READY,
      authToken: "sk-secret",
    });
    expect(withToken.authToken).toBe("sk-secret");
    expect(applyClaudeSettingsUpdate(withToken, { model: "m2" }).authToken).toBe("sk-secret");
    expect(applyClaudeSettingsUpdate(withToken, { authToken: "" }).authToken).toBeNull();
  });

  test("the endpoint must be an http(s) URL, trailing slashes are trimmed", () => {
    expect(() =>
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { baseUrl: "proxy:4000" }),
    ).toThrow(InvalidClaudeSettingsError);
    expect(
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { baseUrl: "http://h:1/v1/" }).baseUrl,
    ).toBe("http://h:1/v1");
  });

  test("a round trip through the stored file keeps every field", () => {
    const saved = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      ...READY,
      enabled: true,
      authToken: "sk-secret",
    });
    expect(parseStoredClaudeSettings(renderStoredClaudeSettings(saved))).toEqual(saved);
  });

  test("the public view never carries the token", () => {
    const publicSettings = toPublicClaudeSettings({
      ...DEFAULT_CLAUDE_SETTINGS,
      authToken: "sk-secret",
    });
    expect(publicSettings).not.toHaveProperty("authToken");
    expect(publicSettings.hasAuthToken).toBe(true);
  });
});

describe("subscription mode", () => {
  const OAUTH = "sk-ant-oat01-secret";

  test("enabling needs only the OAuth token, not an endpoint or a model", () => {
    expect(() =>
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { mode: "subscription", enabled: true }),
    ).toThrow(InvalidClaudeSettingsError);
    const next = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      mode: "subscription",
      enabled: true,
      oauthToken: OAUTH,
    });
    expect(next).toMatchObject({ enabled: true, mode: "subscription", oauthToken: OAUTH });
  });

  test("an unknown mode is rejected", () => {
    expect(() => applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { mode: "magic" })).toThrow(
      InvalidClaudeSettingsError,
    );
  });

  test("a save that leaves mode out keeps the stored mode", () => {
    const sub = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      mode: "subscription",
      oauthToken: OAUTH,
    });
    expect(applyClaudeSettingsUpdate(sub, { subscriptionModel: "opus" }).mode).toBe("subscription");
  });

  test("the OAuth token is write-only and survives a switch to endpoint and back", () => {
    const sub = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      mode: "subscription",
      oauthToken: OAUTH,
    });
    const endpoint = applyClaudeSettingsUpdate(sub, {
      mode: "endpoint",
      baseUrl: "http://p:4000",
      model: "m",
      authToken: "sk-proxy",
    });
    expect(endpoint.oauthToken).toBe(OAUTH);
    const back = applyClaudeSettingsUpdate(endpoint, { mode: "subscription" });
    expect(back).toMatchObject({
      oauthToken: OAUTH,
      authToken: "sk-proxy",
      baseUrl: "http://p:4000",
    });
    expect(applyClaudeSettingsUpdate(back, { oauthToken: "" }).oauthToken).toBeNull();
  });

  test("endpoint mode still requires an endpoint and a model even with an OAuth token", () => {
    expect(() =>
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { enabled: true, oauthToken: OAUTH }),
    ).toThrow("Set an endpoint URL and a model before enabling Claude Code workers");
  });

  test("a round trip through the stored file keeps every field", () => {
    const saved = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      mode: "subscription",
      enabled: true,
      oauthToken: OAUTH,
      subscriptionModel: "opus",
    });
    expect(parseStoredClaudeSettings(renderStoredClaudeSettings(saved))).toEqual(saved);
  });

  test("the public view carries neither token", () => {
    const publicSettings = toPublicClaudeSettings({
      ...DEFAULT_CLAUDE_SETTINGS,
      authToken: "sk-proxy",
      oauthToken: OAUTH,
    });
    expect(publicSettings).not.toHaveProperty("authToken");
    expect(publicSettings).not.toHaveProperty("oauthToken");
    expect(publicSettings).toMatchObject({ hasAuthToken: true, hasOauthToken: true });
    expect(JSON.stringify(publicSettings)).not.toContain(OAUTH);
  });

  test("each mode keeps its own model", () => {
    const endpoint = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      baseUrl: "http://p:4000",
      model: "qwen3-coder",
      enabled: true,
    });
    const sub = applyClaudeSettingsUpdate(endpoint, {
      mode: "subscription",
      oauthToken: OAUTH,
      subscriptionModel: "opus",
    });
    expect(sub).toMatchObject({ model: "qwen3-coder", subscriptionModel: "opus" });
    const cleared = applyClaudeSettingsUpdate(sub, { subscriptionModel: "" });
    expect(cleared).toMatchObject({ model: "qwen3-coder", subscriptionModel: "" });
    expect(applyClaudeSettingsUpdate(cleared, { mode: "endpoint" }).enabled).toBe(true);
  });

  test("subscriptionModel must be text", () => {
    expect(() =>
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { subscriptionModel: 3 }),
    ).toThrow(InvalidClaudeSettingsError);
  });
});
