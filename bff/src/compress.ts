/**
 * gzip for the responses worth it: the build's text assets and JSON.
 *
 * Nothing compressed what the BFF served, so the 700 KB script bundle crossed a
 * phone's connection at full size on every cold open. Written against
 * `Bun.gzipSync` rather than `hono/compress`, which needs `CompressionStream` —
 * absent from the Bun this image pins.
 *
 * - **What**: text the browser parses (script, style, markup, JSON, SVG,
 *   manifest). Never a download, an image or anything already encoded, and
 *   never a stream — the body is read whole, so only a response that declares
 *   its length, or is small text built in memory, is touched.
 * - **Cost**: the hashed `/assets/*` files never change, so each is compressed
 *   once and kept; the bundle is ~15 ms the first time and free after. Anything
 *   else is compressed per response, which is why there is an upper bound.
 */

const COMPRESSIBLE =
  /^(?:text\/(?:html|css|plain|javascript)|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)\b/i;

/** Below this, gzip's own framing eats the gain. */
const MIN_BYTES = 1024;
/** Above this, compressing on the event loop costs more than it saves; assets are exempt. */
const MAX_UNCACHED_BYTES = 512 * 1024;

export interface CompressOptions {
  /** Paths whose bytes never change, compressed once and kept (`/assets/…`). */
  immutable: (path: string) => boolean;
  /** Paths left alone whatever they return. */
  skip: (path: string) => boolean;
}

function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") return false;
    return !params.some((param) => /^\s*q=0(?:\.0*)?\s*$/.test(param));
  });
}

export class ResponseCompressor {
  private readonly cache = new Map<string, Uint8Array>();

  constructor(private readonly options: CompressOptions) {}

  /** The response to send: `response` itself, or its gzipped equivalent. */
  async apply(request: Request, path: string, response: Response): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") return response;
    if (response.status !== 200 || !response.body) return response;
    if (this.options.skip(path)) return response;
    if (response.headers.has("content-encoding")) return response;
    if (request.headers.has("range")) return response;
    if (!COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return response;

    // Caches must key on the encoding whether or not this response used it.
    const headers = new Headers(response.headers);
    headers.append("vary", "accept-encoding");
    const plain = (): Response => new Response(response.body, { status: response.status, headers });
    if (!acceptsGzip(request.headers.get("accept-encoding"))) return plain();

    const immutable = this.options.immutable(path);
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (!immutable && Number.isFinite(declared) && declared > MAX_UNCACHED_BYTES) return plain();
    if (Number.isFinite(declared) && declared < MIN_BYTES) return plain();

    let compressed = immutable ? this.cache.get(path) : undefined;
    if (!compressed) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      headers.delete("content-length");
      if (bytes.length < MIN_BYTES || (!immutable && bytes.length > MAX_UNCACHED_BYTES)) {
        return new Response(bytes, { status: response.status, headers });
      }
      compressed = Bun.gzipSync(bytes);
      if (immutable) this.cache.set(path, compressed);
    }

    headers.set("content-encoding", "gzip");
    headers.set("content-length", String(compressed.length));
    return new Response(compressed, { status: response.status, headers });
  }
}
