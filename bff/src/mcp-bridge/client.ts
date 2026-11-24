/**
 * An MCP client for one server in the shared list, used by the BFF directly
 * (the bridge and the curated Google tools). One session per call, like
 * `letta mcp` itself: calls are seconds apart, and a long-lived session would
 * have to survive sidecar restarts.
 *
 * Only `http` and `sse` servers: a `stdio` server's command is written to run
 * inside the app-server container, not here, so those stay on the skill
 * wrapper (`mcp/skill.ts`).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "../mcp/settings.ts";

/** A tool as `tools/list` describes it — the subset the bridge uses. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/** One picture a server sent, before it is given a workspace path. */
export interface BridgeImage {
  base64: string;
  mimeType: string;
}

export interface CallResult {
  text: string;
  isError: boolean;
  /**
   * The pictures worth carrying to the model, in the order the server sent them.
   * A dropped or unsupported one is named in `text` instead, exactly as every
   * image was before they travelled through the bridge at all.
   */
  images?: BridgeImage[];
}

/** What the bridge needs from a server — injectable for tests. */
export interface McpClientPort {
  listTools(server: McpServer): Promise<ListedTool[]>;
  callTool(
    server: McpServer,
    tool: string,
    args: Record<string, unknown>,
    /** The turn's cancellation, when the caller has one. */
    signal?: AbortSignal,
  ): Promise<CallResult>;
}

export function isBridgeable(server: McpServer): boolean {
  return (server.transport === "http" || server.transport === "sse") && Boolean(server.url);
}

function transportFor(server: McpServer) {
  const url = new URL(server.url ?? "");
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  return server.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

/**
 * The pictures that may travel: the raster types the MOD can name with a media
 * type when it writes them (`internal-tools/mod.ts`), mapped to the extension it
 * reads back. Anything else — SVG above all, which is a document a browser can
 * be talked into fetching, not a picture — stays named, as it was before images
 * travelled through the bridge at all. Checked here, before any byte is written,
 * because the mod guesses the media type from the file extension and falls back
 * to `image/png`: a permissive map upstream would mislabel the file on disk and
 * the model alike.
 */
export const BRIDGE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * What one call may bring back. Text has a 30 000-character cap and images had
 * no bound anywhere — a server whose screenshot tool answers 40 times a turn, or
 * one 200 MB frame, would ride into every later turn's prefill. letta-code's own
 * `inputLimits.images.resize` only bounds pixels, and only at the model call.
 */
export const MAX_IMAGES_PER_CALL = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ImageBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

/**
 * Text blocks joined; `image` blocks carried (see `CallResult.images`);
 * everything else (audio, resources) named, not inlined.
 */
export function textOfResult(result: unknown): CallResult {
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const parts: string[] = [];
  const images: BridgeImage[] = [];
  /** Why an image did not travel, counted — a server that sent fifty must not say so fifty times. */
  const dropped = new Map<string, number>();
  for (const block of Array.isArray(record.content) ? record.content : []) {
    const typed = block as ImageBlock;
    if (typed?.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed?.type === "image") {
      const reason = keepImage(typed, images);
      if (reason) dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
    } else if (typed && typeof typed.type === "string") {
      parts.push(`[${typed.type} content omitted]`);
    }
  }
  for (const [reason, count] of dropped) {
    parts.push(`[image content omitted — ${reason}${count > 1 ? ` (x${count})` : ""}]`);
  }
  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent, null, 2));
  }
  return {
    text: parts.join("\n").trim(),
    isError: record.isError === true,
    ...(images.length > 0 ? { images } : {}),
  };
}

/** Carries the picture and returns nothing; returns the reason it could not otherwise. */
function keepImage(block: ImageBlock, images: BridgeImage[]): string | undefined {
  const mimeType = typeof block.mimeType === "string" ? block.mimeType.trim().toLowerCase() : "";
  if (!BRIDGE_IMAGE_EXTENSIONS[mimeType]) {
    return mimeType
      ? `${mimeType} is not a picture the agent can see`
      : "the server sent no MIME type";
  }
  if (typeof block.data !== "string" || block.data.trim() === "")
    return "the server sent no picture data";
  const bytes = decodedBytes(block.data);
  if (!bytes) return "the server sent no picture data";
  if (bytes > MAX_IMAGE_BYTES) {
    return `${(bytes / 1_048_576).toFixed(1)} MB is over the ${MAX_IMAGE_BYTES / 1_048_576} MB limit`;
  }
  if (images.length >= MAX_IMAGES_PER_CALL) {
    return `one call carries at most ${MAX_IMAGES_PER_CALL} pictures`;
  }
  images.push({ base64: block.data, mimeType });
  return undefined;
}

/** Decoded length of a base64 string, measured rather than decoded — nobody needs the bytes here. */
export function decodedBytes(base64: string): number {
  const body = base64.replace(/\s/g, "");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "lettuce-bff", version: "1" });
  try {
    await client.connect(transportFor(server), { timeout: 15_000 });
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export const mcpClient: McpClientPort = {
  listTools: (server) =>
    withClient(server, async (client) => {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...(page.tools as ListedTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    }),
  callTool: (server, tool, args, signal) =>
    withClient(server, async (client) =>
      textOfResult(
        await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: 120_000,
          ...(signal ? { signal } : {}),
        }),
      ),
    ),
};
