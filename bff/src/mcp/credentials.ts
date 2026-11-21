/**
 * What an http or sse MCP server needs to let us in — a bearer token, custom
 * headers — kept where agents cannot read it.
 *
 * The shared server list (`settings.ts`) lives on letta-home, which every agent
 * shell mounts read-write as uid 0, so a token written there is a token any
 * agent can `cat` (and a prompt-injected one can send away). The BFF is the MCP
 * client for http and sse servers (`mcp-bridge/client.ts`), so it is the only
 * party that needs the secret: the secrets live on the BFF's own `bff-data`
 * volume, 0600, and are laid over the list at connect time
 * (`withCredentials`). The image-generation key is the precedent
 * (`images/service.ts`).
 *
 * The price, stated in the `mcp-servers` skill and the editor: `letta mcp` (the
 * skill's wrapper, which subagents use) cannot reach a server whose secret is
 * here, because it reads only the shared file.
 *
 * A stdio server's `env` cannot be kept here — the process runs in the
 * app-server and `letta mcp` hands it the env from the shared file — so env
 * values stay in that file. They get the same write-only treatment in the API
 * (`publicMcpServers`, `resolveMcpUpdate`); only where they are stored differs.
 *
 * The browser never receives a secret value: GET answers names and flags, and
 * PUT says, per secret, "keep" (a blank), "replace" (a value) or "remove"
 * (left out).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InvalidMcpServersError, type McpServer, type McpTransport } from "./settings.ts";

/** One server's secrets, tied to the origin they were entered for. */
export interface ServerCredentials {
  /** `scheme://host:port` of the URL the secrets were saved with. */
  origin: string;
  /** Sent as `Authorization: Bearer <bearer>`. */
  bearer?: string;
  headers?: Record<string, string>;
}

/** Keyed by server name — the list's own key. */
export type CredentialsMap = Record<string, ServerCredentials>;

/** Where `McpIo` keeps credentials; `McpCredentialsStore` on `bff-data` in production. */
export interface McpCredentialsPort {
  load(): Promise<CredentialsMap>;
  save(credentials: CredentialsMap): Promise<void>;
}

/** What the browser sees of a server: everything but secret values. */
export interface PublicMcpServer {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** http/sse: a bearer token is saved. */
  bearer?: boolean;
  /** http/sse: names of saved custom headers. */
  headerNames?: string[];
  /** stdio: names of env variables in the shared file. */
  envNames?: string[];
}

/** `scheme://host:port`, or null for a URL a secret must not be sent to. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isRemote(server: { transport?: McpTransport }): boolean {
  return server.transport === "http" || server.transport === "sse";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The credentials file can be read, but not trusted as empty. Every save writes
 * the whole map back, so a file we failed to read must never pass for "no
 * tokens": the next save would overwrite every saved token with nothing.
 */
export class McpCredentialsUnreadableError extends Error {}

/**
 * Parse the stored file. A missing file is empty; a file that is not the JSON
 * object we write is refused (`McpCredentialsUnreadableError`). Within a good
 * file, a malformed entry is dropped rather than failing the rest.
 */
export function parseStoredCredentials(text: string | null): CredentialsMap {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new McpCredentialsUnreadableError(
      `The MCP credentials file is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new McpCredentialsUnreadableError("The MCP credentials file is not a JSON object");
  }
  const servers = parsed.servers;
  if (servers === undefined) return {};
  if (!isRecord(servers)) {
    throw new McpCredentialsUnreadableError("The MCP credentials file has no server map");
  }
  const out: CredentialsMap = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw) || typeof raw.origin !== "string") continue;
    const entry: ServerCredentials = { origin: raw.origin };
    if (typeof raw.bearer === "string" && raw.bearer) entry.bearer = raw.bearer;
    if (isRecord(raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [header, value] of Object.entries(raw.headers)) {
        if (typeof value === "string" && value) headers[header] = value;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    if (entry.bearer || entry.headers) out[name] = entry;
  }
  return out;
}

export function renderStoredCredentials(credentials: CredentialsMap): string {
  return `${JSON.stringify({ servers: credentials }, null, 2)}\n`;
}

/**
 * The credentials file on `bff-data`, written 0600 through a temp file and a
 * rename. No queue of its own: every read-modify-write of it already runs in
 * `service.ts`'s mutation chain, together with the list it belongs to.
 */
export class McpCredentialsStore implements McpCredentialsPort {
  constructor(private readonly file: string) {}

  /** Only a missing file reads as empty; any other failure throws (see `McpCredentialsUnreadableError`). */
  async load(): Promise<CredentialsMap> {
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new McpCredentialsUnreadableError(
          `Cannot read the MCP credentials file: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      text = null;
    }
    return parseStoredCredentials(text);
  }

  async save(credentials: CredentialsMap): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, renderStoredCredentials(credentials), { mode: 0o600 });
    await rename(temp, this.file);
  }
}

/**
 * The credentials that apply to `server` as it is now — none when the server
 * is not remote or its URL no longer points at the origin they were saved for.
 * The origin check is what keeps a token entered for one host from ever being
 * sent to another, a hand-edited shared file included.
 */
export function credentialsFor(
  server: McpServer,
  credentials: CredentialsMap,
): ServerCredentials | null {
  if (!isRemote(server)) return null;
  const saved = credentials[server.name];
  if (!saved) return null;
  return saved.origin === originOf(server.url) ? saved : null;
}

/** The headers a saved entry sends: custom ones, then the bearer token. */
export function headersOf(saved: ServerCredentials): Record<string, string> {
  return {
    ...(saved.headers ?? {}),
    ...(saved.bearer ? { Authorization: `Bearer ${saved.bearer}` } : {}),
  };
}

/**
 * The list as the BFF's MCP client must see it: each remote server with its
 * saved headers attached. The one place secrets meet a server object — the
 * bridge's catalog reads its servers through this, and every connection
 * (`mcp_call`, the Google tools) takes its server from the catalog.
 */
export function withCredentials(
  servers: readonly McpServer[],
  credentials: CredentialsMap,
): McpServer[] {
  return servers.map((server) => {
    const saved = credentialsFor(server, credentials);
    if (!saved) return server;
    return { ...server, headers: { ...(server.headers ?? {}), ...headersOf(saved) } };
  });
}

/** The names of the servers whose secrets only the BFF holds — the skill marks them. */
export function credentialedServerNames(
  servers: readonly McpServer[],
  credentials: CredentialsMap,
): Set<string> {
  return new Set(
    servers.filter((server) => credentialsFor(server, credentials)).map((server) => server.name),
  );
}

/**
 * Upstream's `${VAR}` header syntax: `letta mcp` expands it from the
 * app-server's environment (`resolveHeaderEnvironment`). A header holding one is
 * a reference, not a secret, so it stays in the shared file where the wrapper
 * can expand it; the editor shows it like a saved header.
 */
const PLACEHOLDER = /\$\{[A-Z_][A-Z0-9_]*\}/;

/** The placeholder headers a server keeps in the shared file. */
function fileHeadersOf(server: McpServer | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [header, value] of Object.entries(server?.headers ?? {})) {
    if (typeof value === "string" && PLACEHOLDER.test(value)) out[header] = value;
  }
  return out;
}

/** The list for the browser: names and flags, never a value. */
export function publicMcpServers(
  servers: readonly McpServer[],
  credentials: CredentialsMap,
): PublicMcpServer[] {
  return servers.map((server) => {
    const view: PublicMcpServer = { name: server.name };
    if (server.transport !== undefined) view.transport = server.transport;
    if (server.command !== undefined) view.command = server.command;
    if (server.args !== undefined) view.args = [...server.args];
    if (server.url !== undefined) view.url = server.url;
    if (isRemote(server)) {
      const saved = credentialsFor(server, credentials);
      view.bearer = Boolean(saved?.bearer);
      view.headerNames = [
        ...new Set([...Object.keys(fileHeadersOf(server)), ...Object.keys(saved?.headers ?? {})]),
      ];
    } else {
      // Only what a keep can carry back: a non-string value is not an env value.
      view.envNames = Object.entries(server.env ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([key]) => key);
    }
    return view;
  });
}

// ── PUT /api/mcp ────────────────────────────────────────────────────────────

/** RFC 9110 `token`: what a header name may be. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What a shell (and so `letta mcp`'s child process) accepts as a variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkHeaderValue(server: string, what: string, value: string): string {
  // A line break in a header value is a request-smuggling vector, and fetch
  // would refuse it at connect time anyway — refuse it where the user can see.
  if (/[\r\n\0]/.test(value)) {
    throw new InvalidMcpServersError(`Server "${server}": ${what} contains a line break`);
  }
  return value;
}

function checkEnvValue(server: string, key: string, value: string): string {
  // A multi-line env value (a PEM key) is fine; a NUL cannot be passed to a process.
  if (value.includes("\0")) {
    throw new InvalidMcpServersError(`Server "${server}": ${key} contains a NUL character`);
  }
  return value;
}

function stringMap(server: string, what: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    throw new InvalidMcpServersError(`Server "${server}" has non-string ${what} values`);
  }
  return value as Record<string, string>;
}

/**
 * Turn the browser's list into what to store: the shared file's entries and
 * the credentials file, both whole.
 *
 * Per secret, one rule: a blank keeps what is saved, a value replaces it, and
 * a secret left out is removed. A blank needs something to keep — looked up
 * under `was` (the name the entry had when the editor loaded it) so a rename
 * keeps its secrets — and, for an http/sse secret, the URL must still point at
 * the origin it was saved for; otherwise the user re-enters it.
 *
 * Credentials for servers no longer in the list are dropped: the result holds
 * exactly the servers it returns.
 */
export function resolveMcpUpdate(
  input: unknown,
  current: readonly McpServer[],
  credentials: CredentialsMap,
): { entries: unknown[]; credentials: CredentialsMap } {
  if (!Array.isArray(input)) throw new InvalidMcpServersError("servers must be an array");
  const byName = new Map(current.map((server) => [server.name, server]));
  const nextCredentials: CredentialsMap = {};
  const entries = input.map((value, index) => {
    if (!isRecord(value)) throw new InvalidMcpServersError(`Server ${index} is not an object`);
    const { was, bearer, headers, env, ...base } = value;
    const name = typeof base.name === "string" ? base.name.trim() : "";
    if (!name) throw new InvalidMcpServersError(`Server ${index} has no name`);
    if (was !== undefined && typeof was !== "string") {
      throw new InvalidMcpServersError(`Server "${name}": was must be a name`);
    }
    const previousName = typeof was === "string" && was.trim() ? was.trim() : name;
    const transport = typeof base.transport === "string" ? base.transport : "stdio";
    const entry: Record<string, unknown> = { ...base };

    if (transport === "http" || transport === "sse") {
      if (env !== undefined) {
        throw new InvalidMcpServersError(`Server "${name}": env is only for stdio servers`);
      }
      const origin = originOf(typeof base.url === "string" ? base.url.trim() : "");
      const saved = credentials[previousName];
      const keepable = saved && saved.origin === origin ? saved : null;
      const keepError = (what: string) =>
        new InvalidMcpServersError(
          saved && saved.origin !== origin
            ? `Server "${name}": the URL now points at a different host — re-enter ${what}, or remove it`
            : `Server "${name}": ${what} has no saved value — type one`,
        );

      let token: string | undefined;
      if (bearer !== undefined) {
        if (typeof bearer !== "string") {
          throw new InvalidMcpServersError(`Server "${name}": the bearer token must be text`);
        }
        if (bearer.trim() === "") {
          if (!keepable?.bearer) throw keepError("the bearer token");
          token = keepable.bearer;
        } else {
          token = checkHeaderValue(name, "the bearer token", bearer.trim());
        }
      }

      const nextHeaders: Record<string, string> = {};
      // Placeholder headers kept in the shared file, for `letta mcp` to expand.
      const fileHeaders = fileHeadersOf(byName.get(previousName));
      const keptFileHeaders: Record<string, string> = {};
      const seen = new Set<string>();
      for (const [rawHeader, headerValue] of Object.entries(stringMap(name, "header", headers))) {
        const header = rawHeader.trim();
        if (!HEADER_NAME.test(header)) {
          throw new InvalidMcpServersError(`Server "${name}": "${header}" is not a header name`);
        }
        const lower = header.toLowerCase();
        if (seen.has(lower)) {
          throw new InvalidMcpServersError(`Server "${name}": header ${header} is listed twice`);
        }
        seen.add(lower);
        if (lower === "authorization" && token !== undefined) {
          throw new InvalidMcpServersError(
            `Server "${name}": an Authorization header and a bearer token both set Authorization — keep one`,
          );
        }
        if (headerValue.trim() === "") {
          const kept = keepable?.headers?.[header];
          const reference = fileHeaders[header];
          if (kept) nextHeaders[header] = kept;
          else if (reference) keptFileHeaders[header] = reference;
          else throw keepError(`header ${header}`);
        } else {
          nextHeaders[header] = checkHeaderValue(name, `header ${header}`, headerValue.trim());
        }
      }

      if (token !== undefined || Object.keys(nextHeaders).length > 0) {
        if (!origin) {
          throw new InvalidMcpServersError(
            `Server "${name}": a token or header needs an http(s) URL to be sent to`,
          );
        }
        nextCredentials[name] = {
          origin,
          ...(token !== undefined ? { bearer: token } : {}),
          ...(Object.keys(nextHeaders).length > 0 ? { headers: nextHeaders } : {}),
        };
      }
      // Secret headers live in the credentials file; only kept placeholder
      // references stay in the shared one.
      if (Object.keys(keptFileHeaders).length > 0) entry.headers = keptFileHeaders;
      else delete entry.headers;
    } else {
      if (bearer !== undefined || headers !== undefined) {
        throw new InvalidMcpServersError(
          `Server "${name}": a bearer token and headers are only for http and sse servers`,
        );
      }
      const previousEnv = byName.get(previousName)?.env ?? {};
      const nextEnv: Record<string, string> = {};
      for (const [rawKey, envValue] of Object.entries(stringMap(name, "env", env))) {
        const key = rawKey.trim();
        if (envValue === "") {
          // A keep carries back what is there, whatever its name: every
          // untouched server rides each save, and one odd hand-written name
          // must not block saving the whole list.
          const kept = previousEnv[key];
          if (typeof kept !== "string") {
            throw new InvalidMcpServersError(
              `Server "${name}": ${key} has no saved value — type one`,
            );
          }
          nextEnv[key] = kept;
          continue;
        }
        if (!ENV_NAME.test(key)) {
          throw new InvalidMcpServersError(`Server "${name}": "${key}" is not a variable name`);
        }
        nextEnv[key] = checkEnvValue(name, key, envValue);
      }
      if (Object.keys(nextEnv).length > 0) entry.env = nextEnv;
      else delete entry.env;
    }
    return entry;
  });
  return { entries, credentials: nextCredentials };
}

/**
 * Headers found in the shared file on a remote server — written by hand before
 * the editor had a place for them — moved into credentials so they stop being
 * readable by agents. `Authorization: Bearer x` becomes the bearer token.
 *
 * A header holding upstream's `${VAR}` placeholder stays where it is: it is a
 * reference to the app-server's environment, not a secret, and only
 * `letta mcp` can expand it.
 */
export function migrateFileHeaders(
  servers: readonly McpServer[],
  credentials: CredentialsMap,
): {
  servers: McpServer[];
  credentials: CredentialsMap;
  moved: { name: string; count: number }[];
} {
  const nextCredentials: CredentialsMap = { ...credentials };
  const moved: { name: string; count: number }[] = [];
  const nextServers = servers.map((server) => {
    if (!isRemote(server) || !server.headers) return server;
    const references = fileHeadersOf(server);
    const secrets = Object.entries(server.headers).filter(
      ([header, value]) => typeof value === "string" && value && !(header in references),
    );
    if (secrets.length === 0) return server;
    const { headers: _moved, ...rest } = server;
    const kept: McpServer =
      Object.keys(references).length > 0 ? { ...rest, headers: references } : rest;
    const origin = originOf(server.url);
    // A server with no usable URL keeps nothing: there is no origin to tie the
    // secret to, and nothing would ever connect to it.
    if (!origin) return kept;
    const previous = nextCredentials[server.name];
    const entry: ServerCredentials =
      previous && previous.origin === origin
        ? { ...previous, headers: { ...(previous.headers ?? {}) } }
        : { origin, headers: {} };
    const custom = entry.headers as Record<string, string>;
    for (const [header, value] of secrets) {
      if (header.toLowerCase() === "authorization") {
        // One Authorization at a time, as `resolveMcpUpdate` insists: whatever
        // the file says replaces both the saved token and any saved header.
        for (const name of Object.keys(custom)) {
          if (name.toLowerCase() === "authorization") delete custom[name];
        }
        delete entry.bearer;
        const bearer = /^Bearer\s+(.+)$/i.exec(value);
        if (bearer?.[1]) entry.bearer = bearer[1].trim();
        else custom[header] = value;
      } else {
        custom[header] = value;
      }
    }
    if (Object.keys(custom).length === 0) delete entry.headers;
    if (entry.bearer || entry.headers) nextCredentials[server.name] = entry;
    moved.push({ name: server.name, count: secrets.length });
    return kept;
  });
  return { servers: nextServers, credentials: nextCredentials, moved };
}
