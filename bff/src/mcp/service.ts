import {
  type CredentialsMap,
  credentialedServerNames,
  type McpCredentialsPort,
  migrateFileHeaders,
  resolveMcpUpdate,
} from "./credentials.ts";
import {
  MCP_SETTINGS_PATH,
  type McpServer,
  readMcpServers,
  renderMcpSettings,
  validateMcpServers,
} from "./settings.ts";
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from "./skill.ts";

/**
 * Everything the MCP store touches. The list and the skill go through the
 * app-server — they live on its letta-home bind mount — and the credentials
 * stay in the BFF's own `bff-data` volume, where agents cannot read them
 * (`credentials.ts`).
 */
export interface McpIo {
  /** The http/sse servers' secrets. Never through the app-server. */
  credentials: McpCredentialsPort;
  /** File content, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** `skill_enable`: symlink a skill directory into the global skills dir. */
  enableSkill(path: string): Promise<void>;
  /** `skill_disable`: unlink it again. "Not found" is success. */
  disableSkill(name: string): Promise<void>;
}

/** The configured servers. A missing file reads as an empty list. */
export async function loadMcpServers(io: McpIo): Promise<McpServer[]> {
  const raw = await io.read(MCP_SETTINGS_PATH);
  return raw === null ? [] : readMcpServers(raw);
}

/**
 * One mutation of the shared list at a time.
 *
 * The list is read-modified-written from several places that can land together —
 * a Settings → MCP save, a Google connect or disconnect, the boot passes — and
 * two interleaved read-modify-writes silently drop one of them, because each
 * writes back the whole file it read. `modsChain` in index.ts does the same for
 * the mods for the same reason.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function queued<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationChain.catch(() => undefined).then(task);
  // The chain survives a failed mutation: a write that could not run must not
  // wedge every later one behind a rejected promise.
  mutationChain = run.catch(() => undefined);
  return run;
}

/** Write the list, then bring the skill in line with it. Serialized: see `queued`. */
export function saveMcpServers(io: McpIo, servers: McpServer[]): Promise<void> {
  return queued(async () => {
    await io.write(MCP_SETTINGS_PATH, renderMcpSettings(servers));
    await syncMcpSkill(io, servers, await io.credentials.load());
  });
}

/**
 * Save the list as the editor sent it — secrets as keep / replace / remove
 * (`resolveMcpUpdate`) — and answer what is now stored. The read happens inside
 * the queue, so "keep" always means what is saved now, not what a concurrent
 * Google sync left behind a moment ago.
 *
 * Credentials are written before the list, and put back as they were if the
 * list write then fails: a rename, a removal or a host change moves or drops
 * the entry the still-listed old server depends on, so a half-applied save
 * would otherwise cost a working server its token.
 *
 * Throws `InvalidMcpServersError` for a list it refuses.
 */
export function saveMcpServersFromEditor(
  io: McpIo,
  input: unknown,
): Promise<{ servers: McpServer[]; credentials: CredentialsMap }> {
  return queued(async () => {
    const current = await loadMcpServers(io);
    const previous = await io.credentials.load();
    const resolved = resolveMcpUpdate(input, current, previous);
    const servers = validateMcpServers(resolved.entries);
    await io.credentials.save(resolved.credentials);
    try {
      await io.write(MCP_SETTINGS_PATH, renderMcpSettings(servers));
    } catch (error) {
      await io.credentials.save(previous).catch(() => {});
      throw error;
    }
    await syncMcpSkill(io, servers, resolved.credentials);
    return { servers, credentials: resolved.credentials };
  });
}

/**
 * Change the list as its only writer: the read happens inside the queue too, so
 * a mutation can never be computed from a list that is already out of date.
 *
 * `mutate` returns the list it was given to mean "nothing to do", which skips
 * the write; the answer says whether anything was written.
 */
export function updateMcpServers(
  io: McpIo,
  mutate: (servers: McpServer[]) => McpServer[],
): Promise<boolean> {
  return queued(async () => {
    const current = await loadMcpServers(io);
    const next = mutate(current);
    if (next === current) return false;
    await io.write(MCP_SETTINGS_PATH, renderMcpSettings(next));
    await syncMcpSkill(io, next, await io.credentials.load());
    return true;
  });
}

/**
 * Run on every upstream connect: create the settings file (empty) on a fresh
 * install, move any secret header written into it by hand over to the
 * credentials file (`migrateFileHeaders` — agents must not read a token; a
 * `${VAR}` reference stays), and re-render
 * the skill either way, so a deploy always leaves the current wrapper and
 * wording in place. Web search is not seeded here any more: it is a native
 * tool now (see `web-tools/`).
 *
 * Returns the servers now configured. `log` hears about a migration — names
 * and counts only, never a value.
 */
export function ensureMcpServers(
  io: McpIo,
  log: (line: string) => void = () => {},
): Promise<McpServer[]> {
  return queued(async () => {
    const raw = await io.read(MCP_SETTINGS_PATH);
    if (raw === null) {
      await io.write(MCP_SETTINGS_PATH, renderMcpSettings([]));
      await syncMcpSkill(io, [], {});
      return [];
    }
    const servers = readMcpServers(raw);
    const credentials = await io.credentials.load();
    const migrated = migrateFileHeaders(servers, credentials);
    if (migrated.moved.length === 0) {
      await syncMcpSkill(io, servers, credentials);
      return servers;
    }
    await io.credentials.save(migrated.credentials);
    await io.write(MCP_SETTINGS_PATH, renderMcpSettings(migrated.servers));
    for (const { name, count } of migrated.moved) {
      log(`MCP: moved ${count} header(s) of "${name}" out of the shared file to the BFF`);
    }
    await syncMcpSkill(io, migrated.servers, migrated.credentials);
    return migrated.servers;
  });
}

async function syncMcpSkill(
  io: McpIo,
  servers: McpServer[],
  credentials: CredentialsMap,
): Promise<void> {
  if (servers.length === 0) {
    await io.disableSkill(MCP_SKILL_NAME);
    return;
  }
  const parent = MCP_SKILL_DIR.slice(0, MCP_SKILL_DIR.lastIndexOf("/"));
  for (const file of renderMcpSkill(servers, credentialedServerNames(servers, credentials))) {
    await io.write(`${parent}/${file.path}`, file.content);
  }
  await io.enableSkill(MCP_SKILL_DIR);
}
