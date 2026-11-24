/**
 * Every tool of every bridgeable server in the shared MCP list, as the native
 * `mcp_*` tools and the curated Google tools see them.
 *
 * Listed from the servers themselves (`tools/list`) and cached: refreshed on
 * upstream connect, on every save of the shared list, a few times after a
 * Google change (the sidecar needs seconds to restart with new permissions),
 * and when older than the TTL.
 */

import type { McpServer } from "../mcp/settings.ts";
import { isBridgeable, type ListedTool, type McpClientPort } from "./client.ts";

export interface CatalogTool {
  /** `mcp__<server>__<tool>` — upstream's naming for MCP tools. */
  qualified: string;
  server: McpServer;
  tool: string;
  description: string;
  /** The schema the model sees: parameters the BFF supplies are removed. */
  inputSchema: Record<string, unknown>;
  /** The server marks it read-only (MCP `readOnlyHint`). Unmarked counts as a write. */
  readOnly: boolean;
}

/**
 * Parameters the model must not fill in. workspace-mcp's `user_google_email`
 * defaults to the connected account in its single-user mode; showing it only
 * invites the model to guess an address.
 */
const HIDDEN_PARAMETERS = new Set(["user_google_email"]);

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Path-safe and identifier-safe: every character outside `[A-Za-z0-9_-]` becomes
 * `_`, so a `..` or a separator cannot survive it. Used for the qualified tool
 * names and for the file names the bridge gives a returned picture, whose two
 * segments both come from a server that names itself.
 */
export function serverSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export function qualifiedName(server: string, tool: string): string {
  return `mcp__${serverSlug(server)}__${tool}`;
}

export function publicSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = schema && typeof schema === "object" ? schema : { type: "object", properties: {} };
  const properties = { ...((source.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const name of HIDDEN_PARAMETERS) delete properties[name];
  const required = Array.isArray(source.required)
    ? source.required.filter((name) => typeof name === "string" && !HIDDEN_PARAMETERS.has(name))
    : undefined;
  return { ...source, properties, ...(required ? { required } : {}) };
}

export function toCatalogTools(server: McpServer, listed: readonly ListedTool[]): CatalogTool[] {
  return listed
    .filter((tool) => typeof tool.name === "string" && tool.name)
    .map((tool) => ({
      qualified: qualifiedName(server.name, tool.name),
      server,
      tool: tool.name,
      description: (tool.description ?? "").trim(),
      inputSchema: publicSchema(tool.inputSchema),
      readOnly: tool.annotations?.readOnlyHint === true,
    }));
}

/** Lower-cased words, plurals folded ("calendars" matches "calendar"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Keyword ranking over name and description; name matches weigh more. */
export function searchCatalog(
  tools: readonly CatalogTool[],
  query: string,
  options: { server?: string; limit?: number } = {},
): CatalogTool[] {
  const terms = words(query);
  const scoped = options.server
    ? tools.filter((t) => t.server.name.toLowerCase() === options.server?.toLowerCase())
    : tools;
  if (terms.length === 0) return scoped.slice(0, options.limit ?? 8);
  const scored = scoped
    .map((tool) => {
      const name = words(tool.tool.replace(/_/g, " "));
      const description = new Set(words(tool.description));
      let score = 0;
      for (const term of terms) {
        if (name.some((w) => w === term)) score += 3;
        // Compound names: "busy" in "freebusy", "label" in "labels".
        else if (name.some((w) => w.includes(term) || term.startsWith(w))) score += 2;
        if (description.has(term)) score += 1;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.qualified.localeCompare(b.tool.qualified));
  return scored.slice(0, options.limit ?? 8).map((entry) => entry.tool);
}

export class McpCatalog {
  private tools: CatalogTool[] = [];
  private fetchedAt = 0;
  private failures = new Map<string, string>();
  private inflight: Promise<CatalogTool[]> | null = null;

  constructor(
    private readonly deps: {
      servers: () => Promise<McpServer[]>;
      client: McpClientPort;
      log?: (message: string) => void;
      now?: () => number;
      ttlMs?: number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Re-list every bridgeable server. A server that fails keeps no tools and is reported. */
  refresh(): Promise<CatalogTool[]> {
    this.inflight ??= (async () => {
      try {
        const servers = (await this.deps.servers()).filter(isBridgeable);
        const failures = new Map<string, string>();
        const lists = await Promise.all(
          servers.map(async (server) => {
            try {
              return toCatalogTools(server, await this.deps.client.listTools(server));
            } catch (error) {
              failures.set(server.name, error instanceof Error ? error.message : String(error));
              return [];
            }
          }),
        );
        this.tools = lists.flat();
        this.failures = failures;
        this.fetchedAt = this.now();
        for (const [name, reason] of failures)
          this.deps.log?.(`MCP bridge: ${name} did not list tools (${reason})`);
        return this.tools;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** The cached tools, refreshed first when older than the TTL. */
  async current(): Promise<CatalogTool[]> {
    if (this.fetchedAt === 0 || this.now() - this.fetchedAt > (this.deps.ttlMs ?? DEFAULT_TTL_MS)) {
      await this.refresh();
    }
    return this.tools;
  }

  /** What the last refresh saw, without refreshing. */
  snapshot(): { tools: readonly CatalogTool[]; failures: ReadonlyMap<string, string> } {
    return { tools: this.tools, failures: this.failures };
  }
}
