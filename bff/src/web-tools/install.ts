/**
 * Settings → Web's switch, and the one-time retirement of the seeded
 * duckduckgo MCP server. (Writing and reloading the mod itself is
 * `internal-tools/install.ts`, shared with the other mods.)
 */

import { readRenamed } from "../internal-tools/legacy.ts";
import { type McpIo, updateMcpServers } from "../mcp/service.ts";
import {
  applyWebToolsSettingsUpdate,
  parseStoredWebToolsSettings,
  renderStoredWebToolsSettings,
  WEB_TOOLS_SETTINGS_LEGACY_PATH,
  WEB_TOOLS_SETTINGS_PATH,
  type WebToolsSettings,
} from "./settings.ts";

/** The web-tools settings file lives on letta-home, read and written over the upstream connection. */
export interface WebToolsIo {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export async function loadWebToolsSettings(
  io: Pick<WebToolsIo, "read">,
): Promise<WebToolsSettings> {
  return parseStoredWebToolsSettings(
    await readRenamed(io, WEB_TOOLS_SETTINGS_PATH, WEB_TOOLS_SETTINGS_LEGACY_PATH),
  );
}

/** A browser update: save the switch. The caller then re-syncs the mods. */
export async function saveWebToolsSettings(
  io: WebToolsIo,
  body: unknown,
): Promise<WebToolsSettings> {
  const settings = applyWebToolsSettingsUpdate(await loadWebToolsSettings(io), body);
  await io.write(WEB_TOOLS_SETTINGS_PATH, renderStoredWebToolsSettings(settings));
  return settings;
}

/** The entry this repo used to seed into the shared MCP list. */
function isSeededDdg(server: { name: string; url?: string }): boolean {
  return server.name === "duckduckgo" && /^https?:\/\/ddg-mcp:8000\/mcp\/?$/.test(server.url ?? "");
}

/**
 * Once per install: take the seeded duckduckgo server out of the shared MCP
 * list, now that `web_search`/`fetch_webpage` are native tools. Recorded in the
 * web-tools settings, so a user who adds it back afterwards keeps it.
 */
export async function retireSeededDdgMcp(io: WebToolsIo, mcp: McpIo): Promise<boolean> {
  const settings = await loadWebToolsSettings(io);
  if (settings.mcpDdgRetired) return false;
  const removed = await updateMcpServers(mcp, (servers) => {
    const kept = servers.filter((server) => !isSeededDdg(server));
    return kept.length === servers.length ? servers : kept;
  });
  await io.write(
    WEB_TOOLS_SETTINGS_PATH,
    renderStoredWebToolsSettings({ ...settings, mcpDdgRetired: true }),
  );
  return removed;
}
