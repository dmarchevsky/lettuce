/**
 * Settings → MCP servers: the editor's draft and what it sends.
 *
 * Secrets are write-only (`bff/src/mcp/credentials.ts`). GET answers names and
 * flags — `bearer`, `headerNames`, `envNames` — never a value, and PUT says per
 * secret: a blank keeps what is saved, a value replaces it, and a secret left
 * out is removed. A saved secret shows as a row whose value is blank.
 *
 * http/sse tokens and headers are kept by the BFF and never reach an agent;
 * a stdio server's env sits in the shared MCP file, which agent shells can
 * read. The editor says so next to each.
 */

export type Transport = "stdio" | "http" | "sse";

/** One server as GET /api/mcp describes it. */
export interface McpServerView {
  name: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  url?: string;
  bearer?: boolean;
  headerNames?: string[];
  envNames?: string[];
}

/** One server as PUT /api/mcp takes it. */
export interface McpServerInput {
  name: string;
  was?: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  bearer?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** A header or env row. `saved`: loaded from the server, so a blank value keeps it. */
export interface SecretRow {
  id: string;
  name: string;
  value: string;
  saved: boolean;
}

export interface McpDraft {
  name: string;
  /** The name when loaded — null for a new server. Lets a rename keep its secrets. */
  was: string | null;
  transport: Transport;
  command: string;
  argsText: string;
  url: string;
  /** The URL when loaded: saved secrets are tied to its origin. */
  savedUrl: string | null;
  bearer: string;
  bearerSaved: boolean;
  removeBearer: boolean;
  headers: SecretRow[];
  env: SecretRow[];
}

let rowCounter = 0;
export function rowId(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

export function blankRow(): SecretRow {
  return { id: rowId(), name: "", value: "", saved: false };
}

const savedRows = (names: readonly string[] | undefined): SecretRow[] =>
  (names ?? []).map((name) => ({ id: rowId(), name, value: "", saved: true }));

export function isRemote(transport: Transport | undefined): boolean {
  return transport === "http" || transport === "sse";
}

export function draftOf(server: McpServerView | null): McpDraft {
  return {
    name: server?.name ?? "",
    was: server?.name ?? null,
    transport: server?.transport ?? "stdio",
    command: server?.command ?? "",
    argsText: (server?.args ?? []).join(" "),
    url: server?.url ?? "",
    savedUrl: server?.url ?? null,
    bearer: "",
    bearerSaved: server?.bearer === true,
    removeBearer: false,
    headers: savedRows(server?.headerNames),
    env: savedRows(server?.envNames),
  };
}

/** `scheme://host:port`, as the BFF compares it; null when there is none. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Rows as the wire map. A saved row whose value is blank — whitespace counts —
 * keeps what is saved; an empty new row is ignored. A half-filled row never
 * gets here: `draftProblem` holds Save until it is completed or removed.
 */
function rowsToWire(rows: readonly SecretRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.value.trim() !== "") out[name] = row.value;
    else if (row.saved) out[name] = "";
  }
  return out;
}

/** The first row that has one half and not the other, as a sentence; null when none. */
function halfFilled(rows: readonly SecretRow[], what: string): string | null {
  for (const row of rows) {
    if (row.saved) continue;
    const hasName = row.name.trim() !== "";
    const hasValue = row.value.trim() !== "";
    if (hasName && !hasValue)
      return `${row.name.trim()} needs a value — type one, or remove the row.`;
    if (!hasName && hasValue) return `A ${what} has a value but no name.`;
  }
  return null;
}

/** True when the draft would keep a saved http/sse secret without retyping it. */
function keepsRemoteSecret(draft: McpDraft): boolean {
  if (draft.bearerSaved && !draft.removeBearer && draft.bearer.trim() === "") return true;
  return draft.headers.some((row) => row.saved && row.value.trim() === "");
}

/**
 * Why Save must wait, or null: a half-filled row (silently dropping it would
 * save a server that then fails to authenticate), or a saved token or header
 * kept while the URL now points at another host — the BFF refuses that so a
 * token entered for one server is never sent to another, so the editor asks
 * for it to be re-entered or removed first.
 */
export function draftProblem(draft: McpDraft): string | null {
  const rows = isRemote(draft.transport)
    ? halfFilled(draft.headers, "header")
    : halfFilled(draft.env, "variable");
  if (rows) return rows;
  if (!isRemote(draft.transport) || draft.savedUrl === null) return null;
  if (originOf(draft.url) === originOf(draft.savedUrl)) return null;
  if (!keepsRemoteSecret(draft)) return null;
  return "The URL now points at a different host — re-enter the saved token and headers, or remove them.";
}

/** The edited server, ready for PUT. */
export function wireOf(draft: McpDraft): McpServerInput {
  const out: McpServerInput = { name: draft.name.trim(), transport: draft.transport };
  if (draft.was !== null) out.was = draft.was;
  if (draft.transport === "stdio") {
    out.command = draft.command.trim();
    const args = draft.argsText.trim();
    if (args) out.args = args.split(/\s+/);
    const env = rowsToWire(draft.env);
    if (Object.keys(env).length > 0) out.env = env;
    return out;
  }
  out.url = draft.url.trim();
  const typed = draft.bearer.trim();
  if (typed) out.bearer = typed;
  else if (draft.bearerSaved && !draft.removeBearer) out.bearer = "";
  const headers = rowsToWire(draft.headers);
  if (Object.keys(headers).length > 0) out.headers = headers;
  return out;
}

/** A server the editor did not touch, sent back as "keep everything". */
export function keepAll(server: McpServerView): McpServerInput {
  return wireOf(draftOf(server));
}

/** The small labels under a server in the list. */
export function secretTags(server: McpServerView): string[] {
  if (isRemote(server.transport)) {
    return [...(server.bearer ? ["Bearer token"] : []), ...(server.headerNames ?? [])];
  }
  return (server.envNames ?? []).map((name) => `env: ${name}`);
}
