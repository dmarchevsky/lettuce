import { describe, expect, test } from "bun:test";
import { ResponseCompressor } from "./compress.ts";

const compressor = () =>
  new ResponseCompressor({
    immutable: (path) => path.startsWith("/assets/"),
    skip: (path) => path === "/api/files/download",
  });

const get = (encoding: string | null = "gzip, deflate, br") =>
  new Request("http://x/", { headers: encoding === null ? {} : { "accept-encoding": encoding } });

const body = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => `conversation-${i}`) });
const json = () => new Response(body, { headers: { "content-type": "application/json" } });

describe("ResponseCompressor", () => {
  test("JSON comes back gzipped, smaller, and decodes to the same bytes", async () => {
    const response = await compressor().apply(get(), "/api/list", json());
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toContain("accept-encoding");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(bytes.length).toBeLessThan(body.length / 2);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(body);
  });

  test("a client that does not take gzip gets the plain bytes, still marked Vary", async () => {
    for (const encoding of [null, "br", "gzip;q=0"]) {
      const response = await compressor().apply(get(encoding), "/api/list", json());
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("vary")).toContain("accept-encoding");
      expect(await response.text()).toBe(body);
    }
  });

  test("downloads, binaries, small bodies, errors and encoded responses are left alone", async () => {
    const c = compressor();
    const untouched = async (path: string, response: Response) =>
      (await c.apply(get(), path, response)).headers.get("content-encoding");

    expect(await untouched("/api/files/download", json())).toBeNull();
    expect(
      await untouched("/a.png", new Response(body, { headers: { "content-type": "image/png" } })),
    ).toBeNull();
    expect(
      await untouched(
        "/api/x",
        new Response(body, { headers: { "content-type": "application/octet-stream" } }),
      ),
    ).toBeNull();
    expect(
      await untouched(
        "/api/x",
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ),
    ).toBeNull();
    expect(
      await untouched(
        "/api/x",
        new Response(body, { status: 404, headers: { "content-type": "application/json" } }),
      ),
    ).toBeNull();
    expect(
      await untouched(
        "/api/x",
        new Response(body, {
          headers: { "content-type": "application/json", "content-encoding": "br" },
        }),
      ),
    ).toBe("br");
  });

  test("a large response outside /assets is not compressed on the event loop", async () => {
    const big = "x".repeat(600 * 1024);
    const response = await compressor().apply(
      get(),
      "/api/big",
      new Response(big, { headers: { "content-type": "application/json" } }),
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await response.text()).length).toBe(big.length);
  });

  test("a hashed asset is compressed once and served from memory after", async () => {
    const c = compressor();
    const script = `const a = "${"lettuce ".repeat(100_000)}";`;
    const asset = () =>
      new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    const first = await c.apply(get(), "/assets/index-abc.js", asset());
    // The second response's body is never read: it is answered from the cache.
    const unread = asset();
    const second = await c.apply(get(), "/assets/index-abc.js", unread);
    expect(unread.bodyUsed).toBe(false);
    expect(second.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
  });
});
