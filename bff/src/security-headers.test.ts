import { describe, expect, test } from "bun:test";
import { contentSecurityPolicy, hardenedResponse, securityHeaders } from "./security-headers.ts";

describe("contentSecurityPolicy", () => {
  const https = contentSecurityPolicy({ publicOrigin: "https://letta.example.com" });
  const http = contentSecurityPolicy({ publicOrigin: "http://localhost:8090" });

  test("allows no inline or eval script", () => {
    // Scoped to script-src specifically: styles are allowed inline (see the
    // policy's own comment), so a blanket assertion would be wrong.
    const scriptSrc = https.match(/script-src [^;]+/)![0];
    expect(scriptSrc).toBe("script-src 'self'");
    expect(https).not.toContain("unsafe-eval");
  });

  test("pins the websocket to the declared origin's scheme and host", () => {
    expect(https).toContain("connect-src 'self' wss://letta.example.com");
    expect(http).toContain("connect-src 'self' ws://localhost:8090");
  });

  test("does not open connect-src to arbitrary hosts", () => {
    expect(https).not.toMatch(/connect-src [^;]*\swss?:\s/);
    expect(https).not.toMatch(/connect-src [^;]*(^|;)\s\*/);
  });

  test("permits data: images, which the favicon and file viewer need", () => {
    expect(https).toMatch(/img-src 'self' data:/);
  });

  test("refuses framing and closes the base/object sinks", () => {
    expect(https).toContain("frame-ancestors 'none'");
    expect(https).toContain("object-src 'none'");
    expect(https).toContain("base-uri 'self'");
  });
});

describe("securityHeaders", () => {
  test("carries the hardening set", () => {
    const headers = securityHeaders({ publicOrigin: "https://letta.example.com" });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
  });

  test("pins https with HSTS", () => {
    const headers = securityHeaders({ publicOrigin: "https://letta.example.com" });
    expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  test("sends no HSTS over plain http", () => {
    // Pinning a host whose TLS may not work yet would lock the operator out of
    // the deployment for a year, so the header is tied to the declared scheme.
    const headers = securityHeaders({ publicOrigin: "http://localhost:8090" });
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  test("recognises https regardless of case or stray space", () => {
    const headers = securityHeaders({ publicOrigin: " HTTPS://Letta.Example.COM " });
    expect(headers["strict-transport-security"]).toBeDefined();
  });
});

describe("hardenedResponse", () => {
  const hardened = securityHeaders({ publicOrigin: "https://letta.example.com" });

  test("carries the hardening set, because Hono does not", () => {
    // The one reason this helper exists: headers a middleware set with
    // `c.header()` are dropped when a handler returns its own Response, so a
    // response built here has to bring them itself. Without this it is agent-
    // authored bytes with no CSP and no `nosniff`.
    const response = hardenedResponse(hardened, "body", { "content-type": "text/plain" });
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.status).toBe(200);
  });

  test("the caller's own header wins, and the status is theirs", () => {
    const response = hardenedResponse(
      hardened,
      null,
      { location: "/", "x-frame-options": "ALLOW" },
      302,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("x-frame-options")).toBe("ALLOW");
  });
});
