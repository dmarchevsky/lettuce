/**
 * A throwaway MCP server that answers with a **picture**, so the bridge's image
 * path can be walked in a real container (issue #163: an MCP tool's image used to
 * arrive as `[image content omitted]`).
 *
 * Run it on the host — the BFF reaches it as `http://host.docker.internal:8765/mcp`
 * and one name resolution proves that (`getent hosts host.docker.internal` inside
 * `lettuce-bff-1`):
 *
 *     bun scripts/mcp-image-server.ts            # or: --port 9001 --width 800
 *
 * then add it in Settings → MCP as an `http` server, and ask an agent:
 * "call the screenshot tool for page=lettuce and tell me what colours you see".
 * `count` is there to walk the per-call cap: ask for 10 pictures and only 4 travel,
 * the rest stay named in the answer.
 *
 * Deliberately not a dependency: this speaks a hand-written subset of MCP
 * (initialize, tools/list, tools/call, ping) over streamable HTTP in stateless
 * JSON-response mode — enough for `mcp_call`, and it fails loudly rather than
 * quietly if the protocol ever wants more.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deflateSync } from "node:zlib";

interface Options {
  port: number;
  width: number;
  height: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { port: 8765, width: 240, height: 160 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value)) continue;
    if (argv[i] === "--port") options.port = value;
    if (argv[i] === "--width") options.width = Math.max(16, Math.trunc(value));
    if (argv[i] === "--height") options.height = Math.max(16, Math.trunc(value));
  }
  return options;
}

// ── A PNG with no image library ─────────────────────────────────────────────
// Four solid quadrants, so a person can confirm from the agent's own words that
// it really looked at the bytes: "red top-left, green top-right, blue
// bottom-left, yellow bottom-right" is not something it can guess.

/** CRC-32 the slow way — a table would be a lookup table of `number | undefined` here, and a fixture does not care. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Uncompressed truecolour PNG: every scanline prefixed with filter byte 0. */
function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour; compression, filter and interlace all 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function quadrants(width: number, height: number): string {
  const png = encodePng(width, height, (x, y) => {
    const right = x * 2 >= width;
    const bottom = y * 2 >= height;
    if (!right && !bottom) return [220, 40, 40];
    if (right && !bottom) return [40, 190, 70];
    if (!right && bottom) return [45, 90, 230];
    return [240, 210, 40];
  });
  return png.toString("base64");
}

// ── The server ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "screenshot",
    description:
      "Draw a four-quadrant test chart for a page and return it as an image next to a caption.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "What to caption the picture with." },
        count: { type: "number", description: "How many identical pictures to return (1-10)." },
      },
      required: ["page"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function answer(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function toolCall(params: { arguments?: Record<string, unknown> }, options: Options) {
  const page = String(params.arguments?.page ?? "untitled");
  const count = Math.min(10, Math.max(1, Number(params.arguments?.count ?? 1) || 1));
  const chart = quadrants(options.width, options.height);
  const content: unknown[] = [{ type: "text", text: `Captured a test chart for "${page}".` }];
  for (let i = 0; i < count; i += 1)
    content.push({ type: "image", data: chart, mimeType: "image/png" });
  console.log(
    `screenshot page=${JSON.stringify(page)} count=${count} png=${chart.length} b64 chars`,
  );
  return { content, isError: false };
}

async function handle(body: Record<string, unknown>, options: Options) {
  const { id, method, params } = { id: body.id, method: body.method, params: body.params ?? {} };
  switch (method) {
    case "initialize":
      return answer(id, {
        protocolVersion: (params as { protocolVersion?: string }).protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lettuce-image-fixture", version: "1" },
      });
    case "tools/list":
      return answer(id, { tools: TOOLS });
    case "tools/call":
      return answer(id, toolCall(params as never, options));
    case "ping":
      return answer(id, {});
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } };
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (piece) => (text += piece));
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function reply(response: ServerResponse, status: number, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

const options = parseArgs(process.argv.slice(2));
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    // Stateless: no server-initiated stream to open with a GET.
    return reply(response, 405, { jsonrpc: "2.0", error: { code: -32000, message: "POST only" } });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(request)) as Record<string, unknown>;
  } catch {
    return reply(response, 400);
  }
  if (typeof body.method === "string" && body.method.startsWith("notifications/")) {
    return reply(response, 202); // acknowledged, no answer
  }
  try {
    reply(response, 200, await handle(body, options));
  } catch (error) {
    // A fixture that dies takes the verification with it: answer the JSON-RPC
    // error and stay up.
    console.log("failed:", error instanceof Error ? error.stack : error);
    reply(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

server.listen(options.port, "0.0.0.0", () => {
  console.log(
    `MCP image fixture on http://0.0.0.0:${options.port}/mcp ` +
      `(from a container: http://host.docker.internal:${options.port}/mcp)`,
  );
});
