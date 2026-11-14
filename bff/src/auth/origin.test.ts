import { describe, expect, test } from "bun:test";
import { checkUpgradeOrigin } from "./origin.ts";

describe("checkUpgradeOrigin", () => {
  test("an absent Origin is allowed — that is a non-browser client", () => {
    expect(
      checkUpgradeOrigin(null, "cloudflared", "https://x.example.com", "x.example.com").ok,
    ).toBe(true);
    expect(checkUpgradeOrigin("", "lan", "http://localhost:8090", "localhost:8090").ok).toBe(true);
  });

  test("the declared public origin is always allowed", () => {
    expect(
      checkUpgradeOrigin(
        "https://x.example.com",
        "cloudflared",
        "https://x.example.com",
        "irrelevant",
      ).ok,
    ).toBe(true);
    expect(
      checkUpgradeOrigin("https://x.example.com", "lan", "https://x.example.com", "other").ok,
    ).toBe(true);
  });

  test("cloudflared refuses any other origin", () => {
    // The attack this exists for: another site's page opening a socket with the
    // victim's session cookie.
    expect(
      checkUpgradeOrigin(
        "https://evil.com",
        "cloudflared",
        "https://x.example.com",
        "x.example.com",
      ).ok,
    ).toBe(false);
    // Host rewriting means the Host header is NOT the user-facing origin here,
    // so a same-host check must not be used as the answer.
    expect(
      checkUpgradeOrigin("https://evil.com", "cloudflared", "https://x.example.com", "evil.com").ok,
    ).toBe(false);
  });

  test("local allows same-origin by host and port", () => {
    expect(
      checkUpgradeOrigin("http://192.0.2.5:8090", "lan", "http://localhost:8090", "192.0.2.5:8090")
        .ok,
    ).toBe(true);
    expect(
      checkUpgradeOrigin("http://localhost:8090", "lan", "http://localhost:8090", "localhost:8090")
        .ok,
    ).toBe(true);
  });

  test("local refuses a different host or port", () => {
    expect(
      checkUpgradeOrigin("http://evil.com:8090", "lan", "http://localhost:8090", "localhost:8090")
        .ok,
    ).toBe(false);
    // Non-loopback, so the loopback dev allowance cannot mask the port
    // mismatch this assertion is meant to catch.
    expect(
      checkUpgradeOrigin(
        "http://lan.example.com:9999",
        "lan",
        "http://lan.example.com:8090",
        "lan.example.com:8090",
      ).ok,
    ).toBe(false);
  });

  test("local fills in default ports before comparing", () => {
    expect(
      checkUpgradeOrigin("https://x.example.com", "lan", "http://localhost:8090", "x.example.com")
        .ok,
    ).toBe(true);
  });

  test("an unparseable Origin is refused", () => {
    expect(
      checkUpgradeOrigin("not a url", "lan", "http://localhost:8090", "localhost:8090").ok,
    ).toBe(false);
  });

  test("a missing Host header in local mode is refused rather than trusted", () => {
    expect(
      checkUpgradeOrigin("http://lan.example.com:8090", "lan", "http://elsewhere", null).ok,
    ).toBe(false);
  });
});

describe("checkUpgradeOrigin loopback allowance (local dev proxy)", () => {
  test("a loopback origin is allowed in local mode even against another Host", () => {
    // Vite's dev proxy: Origin is the dev server, Host is the BFF target.
    expect(
      checkUpgradeOrigin("http://localhost:5173", "lan", "http://localhost:8090", "localhost:8080")
        .ok,
    ).toBe(true);
    expect(
      checkUpgradeOrigin("http://127.0.0.1:5173", "lan", "http://localhost:8090", "127.0.0.1:8090")
        .ok,
    ).toBe(true);
  });

  test("a loopback origin is NOT a free pass in cloudflared mode", () => {
    expect(
      checkUpgradeOrigin(
        "http://localhost:5173",
        "cloudflared",
        "https://x.example.com",
        "x.example.com",
      ).ok,
    ).toBe(false);
  });

  test("a remote origin is still refused in local mode", () => {
    expect(
      checkUpgradeOrigin(
        "http://evil.example.com",
        "lan",
        "http://localhost:8090",
        "localhost:8090",
      ).ok,
    ).toBe(false);
  });

  test("a loopback Origin on an agent app's port is not this app", () => {
    // Agent apps are published on 3000-3099 with no sign-in of their own, and a
    // page one of them serves is same-site with the app on this machine.
    expect(
      checkUpgradeOrigin("http://localhost:3005", "lan", "http://localhost:8090", "localhost:8090")
        .ok,
    ).toBe(false);
    expect(
      checkUpgradeOrigin("http://127.0.0.1:3099", "lan", "http://localhost:8090", "localhost:8090")
        .ok,
    ).toBe(false);
    // The Vite dev server still gets through, and so does this server itself
    // when it is the one listening in that range.
    expect(
      checkUpgradeOrigin("http://localhost:5173", "lan", "http://localhost:8090", "localhost:8090")
        .ok,
    ).toBe(true);
    expect(
      checkUpgradeOrigin("http://localhost:3000", "lan", "http://localhost:8090", "localhost:3000")
        .ok,
    ).toBe(true);
  });
});
