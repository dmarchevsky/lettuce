import {
  MCP_SETTINGS_PATH,
  type McpServer,
  readMcpServers,
  renderMcpSettings,
} from "./settings.ts";
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from "./skill.ts";

/**
 * Everything the MCP store touches, all of it through the app-server — the
 * files live on its letta-home bind mount, not in the BFF's container.
 */
export interface McpIo {
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
    await syncMcpSkill(io, servers);
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
    await syncMcpSkill(io, next);
    return true;
  });
}

/**
 * Run on every upstream connect: create the settings file (empty) on a fresh
 * install, and re-render the skill either way, so a deploy always leaves the
 * current wrapper and wording in place. Web search is not seeded here any
 * more: it is a native tool now (see `web-tools/`).
 *
 * Returns the servers now configured.
 */
export async function ensureMcpServers(io: McpIo): Promise<McpServer[]> {
  const raw = await io.read(MCP_SETTINGS_PATH);
  if (raw === null) {
    await saveMcpServers(io, []);
    return [];
  }
  const servers = readMcpServers(raw);
  await syncMcpSkill(io, servers);
  return servers;
}

async function syncMcpSkill(io: McpIo, servers: McpServer[]): Promise<void> {
  if (servers.length === 0) {
    await io.disableSkill(MCP_SKILL_NAME);
    return;
  }
  const parent = MCP_SKILL_DIR.slice(0, MCP_SKILL_DIR.lastIndexOf("/"));
  for (const file of renderMcpSkill(servers)) {
    await io.write(`${parent}/${file.path}`, file.content);
  }
  await io.enableSkill(MCP_SKILL_DIR);
}
