import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

/**
 * The session gate is one `app.use("/api/*", …)` in `index.ts`, so it is only as
 * good as the router's agreement with itself about which paths that pattern
 * covers. Hono before 4.13.5 disagreed: a path holding an encoded line break
 * skipped the middleware. This pins the property the gate depends on, against
 * whatever version of the router is installed.
 */
describe("a middleware on /api/* covers every path under it", () => {
  const app = new Hono();
  app.use("/api/*", async (c) => c.text("Unauthorized", 401));
  app.get("/api/secret", (c) => c.text("agent data"));
  app.get("/api/files/:name", (c) => c.text("agent data"));
  app.all("/api/*", (c) => c.text("agent data"));

  for (const path of [
    "/api/secret",
    "/api/secret%0a",
    "/api/%0asecret",
    "/api/files/a%0ab",
    "/api/files/a%0d%0ab",
    "/api/secret%00",
    "/api//secret",
    "/api/./secret",
    "/api/x/../secret",
    "/API/secret",
  ]) {
    test(path, async () => {
      const response = await app.request(path);
      expect(await response.text()).not.toContain("agent data");
    });
  }
});
