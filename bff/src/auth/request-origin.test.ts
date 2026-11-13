import { describe, expect, test } from "bun:test";
import { checkRequestOrigin, startedElsewhere } from "./request-origin.ts";

const PUBLIC = "http://192.0.2.10:8090";

function check(
  method: string,
  headers: Record<string, string>,
  access: "lan" | "cloudflared" = "lan",
) {
  return checkRequestOrigin(
    { method, headers: new Headers({ host: "192.0.2.10:8090", ...headers }) },
    access,
    access === "lan" ? PUBLIC : "https://x.example.com",
  ).ok;
}

describe("checkRequestOrigin", () => {
  test("reads are never refused: only a method that changes something is checked", () => {
    expect(check("GET", { origin: "https://evil.example" })).toBe(true);
    expect(check("HEAD", { origin: "https://evil.example" })).toBe(true);
  });

  test("the app's own page may post", () => {
    expect(check("POST", { origin: PUBLIC, "sec-fetch-site": "same-origin" })).toBe(true);
  });

  test("an agent app on a sibling port is same-site, carries the cookie, and is refused", () => {
    // The case `SameSite=Lax` does not cover: ports are not part of a site.
    expect(check("POST", { origin: "http://192.0.2.10:3005" })).toBe(false);
    expect(check("DELETE", { origin: "http://192.0.2.10:3005" })).toBe(false);
    expect(check("PUT", { origin: "http://localhost:3005", host: "localhost:8090" })).toBe(false);
  });

  test("another site is refused, behind a tunnel too", () => {
    expect(check("POST", { origin: "https://evil.example" })).toBe(false);
    expect(check("POST", { origin: "https://evil.example" }, "cloudflared")).toBe(false);
    expect(check("POST", { origin: "https://x.example.com" }, "cloudflared")).toBe(true);
  });

  test("an opaque origin is a browser, and is not us", () => {
    expect(check("POST", { origin: "null" })).toBe(false);
  });

  test("with no Origin, the browser's own account of the request decides", () => {
    expect(check("POST", { "sec-fetch-site": "same-site" })).toBe(false);
    expect(check("POST", { "sec-fetch-site": "cross-site" })).toBe(false);
    expect(check("POST", { "sec-fetch-site": "same-origin" })).toBe(true);
    expect(check("POST", { "sec-fetch-site": "none" })).toBe(true);
  });

  test("neither header means not a browser — smoke, deploy-check, curl", () => {
    expect(check("POST", {})).toBe(true);
  });
});

describe("startedElsewhere", () => {
  test("only a foreign Sec-Fetch-Site counts", () => {
    expect(startedElsewhere(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(startedElsewhere(new Headers({ "sec-fetch-site": "Same-Site" }))).toBe(true);
    expect(startedElsewhere(new Headers({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(startedElsewhere(new Headers())).toBe(false);
  });
});
