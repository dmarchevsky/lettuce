import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AgentListResponseMessage,
  AgentRetrieveResponseMessage,
  ExecuteCommandResponseMessage,
  ListInDirectoryResponseMessage,
  ReadFileResponseMessage,
  SkillDisableResponseMessage,
  SkillEnableResponseMessage,
  WriteFileResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import type { ServerWebSocket } from "bun";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { installAgentSkills, readSkillTree } from "./agent-skills.ts";
import { AgentIdList, isAgentId } from "./agents/id-list.ts";
import { AgentToolAccessStore, agentsWhere, parseToolAccess } from "./agents/tool-access.ts";
import { checkUpgradeOrigin } from "./auth/origin.ts";
import { resolveSession } from "./auth/resolve-session.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  encodeSession,
  type SessionPayload,
} from "./auth/session-cookie.ts";
import {
  type ClaudeFileIo,
  getClaudeRun,
  listClaudeRuns,
  loadClaudeSettings,
  reapplyClaudeSettings,
  saveClaudeSettings,
} from "./claude/service.ts";
import { InvalidClaudeSettingsError, toPublicClaudeSettings } from "./claude/settings.ts";
import { isClaudeSessionId } from "./claude/transcript.ts";
import { AGENT_POLICY_MOD_PATH, renderAgentPolicyMod } from "./codex/policy-mod.ts";
import { isCodexThreadId } from "./codex/rollout.ts";
import {
  type CodexFileIo,
  getCodexRun,
  listCodexRuns,
  loadCodexSettings,
  reapplyCodexSettings,
  saveCodexSettings,
  suggestedCodexBaseUrl,
} from "./codex/service.ts";
import { InvalidCodexSettingsError, toPublicCodexSettings } from "./codex/settings.ts";
import {
  type BffConfig,
  enabledFeatureNames,
  googleWritesAllowed,
  isAllowedUser,
  loadConfig,
} from "./config.ts";
import { errorMessage } from "./errors.ts";
import { contentDisposition } from "./files/content-disposition.ts";
import { inlineContentType } from "./files/content-type.ts";
import {
  type GitRouteResult,
  gitCommitResponse,
  gitLogResponse,
  gitRepoResponse,
} from "./git/routes.ts";
import { checkGitAvailability, runGit } from "./git/service.ts";
import { createGoogleFsIo } from "./google/fs-io.ts";
import { googleSettingsUrl, type LostAccessPort } from "./google/lost-access.ts";
import { GoogleOAuthError } from "./google/oauth.ts";
import { GoogleAccessError, GoogleService } from "./google/service.ts";
import { InvalidGoogleSettingsError } from "./google/settings.ts";
import {
  availableGoogleTools,
  GOOGLE_TOOLS_MOD_PATH,
  googleHandlers,
  googleToolsHiddenAt,
} from "./google/tools.ts";
import {
  DEFAULT_HTTP_CAPACITY,
  DEFAULT_HTTP_REFILL_PER_SECOND,
  HttpRateLimiter,
} from "./http-rate-limit.ts";
import { handleInternalTools } from "./internal-tools/http.ts";
import { type ModsIo, type RenderedMod, syncMods } from "./internal-tools/install.ts";
import { readRenamed } from "./internal-tools/legacy.ts";
import { MODS_DIR, renderToolsMod } from "./internal-tools/mod.ts";
import type { ToolHandler } from "./internal-tools/types.ts";
import { ensureMcpServers, loadMcpServers, type McpIo, saveMcpServers } from "./mcp/service.ts";
import {
  InvalidMcpServersError,
  type McpServer,
  SettingsUnreadableError,
  validateMcpServers,
} from "./mcp/settings.ts";
import { MCP_SKILL_NAME } from "./mcp/skill.ts";
import { McpCatalog } from "./mcp-bridge/catalog.ts";
import { mcpClient } from "./mcp-bridge/client.ts";
import { BRIDGE_TOOL_SPECS, bridgeHandlers, MCP_BRIDGE_MOD_PATH } from "./mcp-bridge/tools.ts";
import {
  assertEffectiveUsable,
  effectivePiSettings,
  InvalidPiAgentSettingsError,
  InvalidPiSettingsError,
  isPiRunId,
  PI_TOOL_NAMES,
  PI_TOOL_SPECS,
  PiService,
  parsePiAgentSettings,
  piConfigured,
  toPublicPiSettings,
} from "./pi/service.ts";
import { parsePiRun, summarizePiRun } from "./pi/transcript.ts";
import { ProviderSight } from "./providers/sight.ts";
import {
  ModelCapsError,
  ModelCapsStore,
  parseModelCapsBody,
  splitHandle,
} from "./providers/store.ts";
import {
  buildProviderModGroups,
  PROVIDERS_MOD_PATH,
  parseRegisteredProviderIds,
  parseVisionProviders,
  renderProvidersMod,
} from "./providers/vision.ts";
import { AgentNames } from "./push/agent-names.ts";
import { ApprovalWatcher } from "./push/approval-watcher.ts";
import { configureWebPush, sendPush } from "./push/send.ts";
import { PushSubscriptionStore } from "./push/store.ts";
import { TurnOutcomeWatcher } from "./push/turn-watcher.ts";
import { securityHeaders } from "./security-headers.ts";
import { scopeKeyOf } from "./session/buffer.ts";
import { WORKSPACE_ROOT, workspaceViolation } from "./session/protocol.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { symlinkViolation } from "./session/symlink-guard.ts";
import { TurnErrorLog } from "./session/turn-errors.ts";
import { TurnUsageLog } from "./session/turn-usage.ts";
import { drainActiveTurns } from "./shutdown.ts";
import { hostSkillFs, upstreamSkillFs } from "./skills/fs.ts";
import { InvalidSkillScopeError, SkillCatalog } from "./skills/service.ts";
import { UpstreamConnection } from "./upstream/connection.ts";
import { readUiVersion } from "./version.ts";
import { ddgCaller } from "./web-tools/ddg.ts";
import {
  loadWebToolsSettings,
  retireSeededDdgMcp,
  saveWebToolsSettings,
} from "./web-tools/install.ts";
import { renderWebToolsMod, WEB_TOOLS_MOD_PATH } from "./web-tools/mod.ts";
import { fetchWebpage, type WebToolsBackends, webSearch } from "./web-tools/service.ts";
import { InvalidWebToolsSettingsError } from "./web-tools/settings.ts";
import { webToolsStatus } from "./web-tools/status.ts";

const config: BffConfig = loadConfig();
/** This build's release tag (see the `VERSION` file and CLAUDE.md). */
const uiVersion = readUiVersion();
const secureCookies = config.publicOrigin.startsWith("https://");

// Push is fully optional (see `config.push`'s doc comment) — null when the
// three VAPID settings aren't configured, same "degrade silently, run
// without it" pattern this repo already uses for the sandbox backend.
const pushStore = config.push
  ? new PushSubscriptionStore(config.push.subscriptionsFile, (error) =>
      log(`Push subscription persist failed: ${errorMessage(error)}`),
    )
  : null;
if (config.push) configureWebPush(config.push);
const agentPins = new AgentIdList(config.pinnedAgentsFile, (error) =>
  log(`Pinned agents persist failed: ${errorMessage(error)}`),
);
const agentArchive = new AgentIdList(config.archivedAgentsFile, (error) =>
  log(`Archived agents persist failed: ${errorMessage(error)}`),
);
const agentToolAccess = new AgentToolAccessStore(config.agentToolAccessFile, (error) =>
  log(`Agent tool access persist failed: ${errorMessage(error)}`),
);
// A call with no agent id (an agent shell's curl) gets the default: this is availability, not a boundary.
const googleAccessFor = (agentId: string | null) =>
  agentId ? agentToolAccess.get(agentId).google : "full";
// Push titles name the agent. Looked up through the permanent connection and
// cached; a failed lookup falls back to "Lettuce" rather than delaying the push.
const agentNames = new AgentNames(async (agentId) => {
  const response = await upstream.request<AgentRetrieveResponseMessage>(
    { type: "agent_retrieve", request_id: `bff-agent-name-${randomUUID()}`, agent_id: agentId },
    10_000,
  );
  return response.success ? (response.agent?.name ?? null) : null;
});
const turnOutcomeWatcher = pushStore ? new TurnOutcomeWatcher(pushStore, log, agentNames) : null;
const approvalWatcher = pushStore ? new ApprovalWatcher(pushStore, log, agentNames) : null;
const turnErrors = new TurnErrorLog();
const turnUsage = new TurnUsageLog();

function log(message: string): void {
  console.log(`[bff] ${new Date().toISOString()} ${message}`);
}

// ── The one permanent upstream connection ────────────────────────────────────
// Opened here at boot, before any browser exists, and never closed. This is
// also what starts the app-server's process services (cron scheduler, Telegram
// adapters), which only boot on first client attach.
const upstream = new UpstreamConnection({
  url: config.appServerUrl,
  onFrame: (frame: WsProtocolMessage) => {
    // Before the fan-out: a browser refetches usage when it sees a usage
    // delta, and must find this step already counted.
    turnUsage.observe(frame);
    const sightUpdate = providerSight.observe(frame);
    registry.handleUpstreamFrame(frame);
    turnErrors.observe(frame);
    turnOutcomeWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
    approvalWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
    if (sightUpdate.modelsMayHaveChanged) {
      // A relayed connect/disconnect: re-fetch both lists, then re-render.
      void resyncMods("model list may have changed", {
        refreshCatalog: false,
        refreshProviders: true,
      }).catch(() => {});
    } else if (sightUpdate.modelsChanged) {
      void resyncMods("model list changed", { refreshCatalog: false }).catch(() => {});
    }
  },
  onStateChange: (state, info) => {
    log(`Upstream state: ${state}`);
    registry.broadcastUpstreamState(state, info);
    if (state === "connected") {
      skillCatalog.reset();
      void installShippedSkills();
      // One after another: each of these rewrites the shared MCP list, and two
      // read-modify-writes at once would drop one's change.
      void ensureMcpServers(mcpIo)
        .then((servers) => log(`MCP: ${servers.length} shared server(s) configured`))
        .catch((error) => log(`MCP: could not sync shared servers: ${errorMessage(error)}`))
        .then(() => retireSeededDdgMcp(codexIo, mcpIo))
        .then(
          (removed) => removed && log("MCP: removed duckduckgo — web search is a native tool now"),
        )
        .catch((error) => log(`MCP: could not retire duckduckgo: ${errorMessage(error)}`))
        .then(() => googleService.reapply())
        .catch((error) => log(`Google: could not re-render config: ${errorMessage(error)}`))
        .then(() => resyncMods("connected", { refreshCatalog: true, refreshProviders: true }))
        .catch(() => {});
      void reapplyCodexSettings(codexIo, { profileEnabled: config.features.codex })
        .then((applied) => applied && log("Codex: re-rendered config from saved settings"))
        .catch((error) => log(`Codex: could not re-render config: ${errorMessage(error)}`));
      void reapplyClaudeSettings(claudeIo, { profileEnabled: config.features.claude })
        .then((applied) => applied && log("Claude Code: re-rendered config from saved settings"))
        .catch((error) => log(`Claude Code: could not re-render config: ${errorMessage(error)}`));
      void checkCodingMarker().catch((error) =>
        log(`Coding CLIs: could not read the install marker: ${errorMessage(error)}`),
      );
    }
  },
  log,
});

const registry = new SessionRegistry(upstream, config.frameBufferSize, log);

// Skills this repo ships to every agent (docker/agent-skills), installed into
// the app-server's global skills directory on each connect — see
// `agent-skills.ts` for why this is not a bind mount. The files travel in the
// bff image at the same relative path as in the repo, so dev works unchanged.
const agentSkillsDir =
  process.env.AGENT_SKILLS_DIR ?? new URL("../../docker/agent-skills", import.meta.url).pathname;
async function installShippedSkills(): Promise<void> {
  await installAgentSkills(
    readSkillTree(agentSkillsDir),
    async (path, content) => {
      const response = await upstream.request<WriteFileResponseMessage>({
        type: "write_file",
        path,
        content,
        request_id: `bff-skill-${randomUUID()}`,
      });
      if (response?.success !== true) throw new Error(response?.error ?? "write_file failed");
    },
    log,
  );
}

// Codex workers' files, reached through the app-server like every other file
// the BFF touches — see `codex/settings.ts`. Only these routes use it, never a
// browser: `/root/.letta` is outside the workspace clamp on purpose.
const codexIo: CodexFileIo = {
  async read(path) {
    const response = await upstream.request<ReadFileResponseMessage>({
      type: "read_file",
      path,
      encoding: "utf8",
      request_id: `bff-codex-read-${randomUUID()}`,
    });
    if (response.success && typeof response.content === "string") return response.content;
    if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
    throw new Error(response.error ?? `Could not read ${path}`);
  },
  async write(path, content) {
    const response = await upstream.request<WriteFileResponseMessage>({
      type: "write_file",
      path,
      content,
      request_id: `bff-codex-write-${randomUUID()}`,
    });
    if (response?.success !== true) throw new Error(response?.error ?? `Could not write ${path}`);
  },
  async listFiles(dir) {
    const response = await upstream.request<ListInDirectoryResponseMessage>({
      type: "list_in_directory",
      path: dir,
      include_files: true,
      request_id: `bff-codex-list-${randomUUID()}`,
    });
    if (response.success) return response.files ?? [];
    if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
    throw new Error(response.error ?? `Could not list ${dir}`);
  },
};

// Which coding CLIs the app-server image actually installed, read from the
// marker the Dockerfile writes (docker/codex/Dockerfile). `null` = not read
// yet, or an image that predates the marker — the mismatch check says which.
// The same image tag can be built with or without the CLIs (CODING_FEATURES is
// a build arg, not a tag suffix), so a profile token can be on against an image
// that was built without it: without this check that would fail silently.
// The marker moved to /opt/lettuce with the `letta-ui` rename; the old path is
// still tried because the marker lives in the image, and the image is only
// rebuilt when letta-code is bumped.
const CODING_MARKER_PATH = "/opt/lettuce/features";
const CODING_MARKER_LEGACY_PATH = "/opt/letta-ui/features";
let codingInstalled: string[] | null = null;

async function checkCodingMarker(): Promise<void> {
  const text = await readRenamed(codexIo, CODING_MARKER_PATH, CODING_MARKER_LEGACY_PATH);
  if (text === null) {
    log(
      `Coding CLIs: the app-server image predates the install marker (${CODING_MARKER_PATH}); ` +
        `nothing can be verified against it — rebuild app-server to change what is installed.`,
    );
    return;
  }
  codingInstalled = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const [name, on] of [
    ["codex", config.features.codex],
    ["claude", config.features.claude],
  ] as const) {
    if (on && !codingInstalled.includes(name)) {
      log(
        `! ${name} is enabled by COMPOSE_PROFILES but is not installed in the app-server image — ` +
          `rebuild it: docker compose -f docker/compose.yml build app-server && … up -d`,
      );
    }
  }
}

// Claude Code workers' files, over the same channel as Codex's — plus the
// folder half of `list_in_directory`, which is how `claude/` finds the project
// directories under `projects/`. See `claude/service.ts`.
const claudeIo: ClaudeFileIo = {
  ...codexIo,
  async listDirs(dir) {
    const response = await upstream.request<ListInDirectoryResponseMessage>({
      type: "list_in_directory",
      path: dir,
      include_files: true,
      request_id: `bff-claude-list-dirs-${randomUUID()}`,
    });
    if (response.success) return response.folders ?? [];
    if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
    throw new Error(response.error ?? `Could not list ${dir}`);
  },
};

// Settings → Skills (see `skills/`). Bundled skills are in the app-server image,
// so they come over the connection; every other root is read from the BFF's
// read-only mounts, because the protocol's listings skip symlinks.
const skillCatalog = new SkillCatalog(
  hostSkillFs,
  upstreamSkillFs({
    async list(dir) {
      const response = await upstream.request<ListInDirectoryResponseMessage>({
        type: "list_in_directory",
        path: dir,
        include_files: true,
        request_id: `bff-skills-list-${randomUUID()}`,
      });
      if (response.success) return { folders: response.folders, files: response.files ?? [] };
      if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
      throw new Error(response.error ?? `Could not list ${dir}`);
    },
    async read(path) {
      const content = await codexIo.read(path);
      if (content === null) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  }),
  () =>
    new Map([
      ...readSkillTree(agentSkillsDir).map(
        (file) => [file.path.split("/")[0] ?? "", "this app"] as const,
      ),
      [MCP_SKILL_NAME, "Settings → MCP"],
    ]),
);

// The shared MCP list and its skill (see `mcp/`), through the app-server like
// the Codex files. Reads reuse `codexIo.read` — same file, same ENOENT → null.
const mcpIo: McpIo = {
  read: (path) => codexIo.read(path),
  write: (path, content) => codexIo.write(path, content),
  async enableSkill(skillPath) {
    const response = await upstream.request<SkillEnableResponseMessage>({
      type: "skill_enable",
      skill_path: skillPath,
      request_id: `bff-mcp-skill-enable-${randomUUID()}`,
    });
    if (response?.success !== true) throw new Error(response?.error ?? "skill_enable failed");
  },
  async disableSkill(name) {
    const response = await upstream.request<SkillDisableResponseMessage>({
      type: "skill_disable",
      name,
      request_id: `bff-mcp-skill-disable-${randomUUID()}`,
    });
    // Nothing linked is the state we want, not a failure.
    if (response?.success !== true && !/not found/i.test(response?.error ?? "")) {
      throw new Error(response?.error ?? "skill_disable failed");
    }
  },
};

// ── Native tools: the BFF's letta-code mods ──────────────────────────────────
// Three mods in the app-server's global mods directory register native tools
// that call back into the BFF over loopback (`internal-tools/`): web search
// and page reading (`web-tools/`), the curated Google tools (`google/tools.ts`)
// and the generic MCP bridge (`mcp-bridge/`).
const webToolsBackends = (): WebToolsBackends => ({
  searxngUrl: config.webTools.searxngUrl,
  ddg: config.webTools.ddgMcpUrl ? ddgCaller(config.webTools.ddgMcpUrl) : null,
});
// The remote pi worker (docs/remote-pi-plan.md): settings, keys and captured
// run streams are all BFF-local on `bff-data`; the BFF itself is the ssh
// client, so nothing here crosses the upstream connection.
const piService = new PiService({
  paths: { dir: config.piDir },
  featureEnabled: () => config.features.pi,
  log,
});
void piService
  .reconcile()
  .catch((error) => log(`Remote pi: reconcile failed: ${errorMessage(error)}`));
const mcpCatalog = new McpCatalog({
  servers: () => loadMcpServers(mcpIo),
  client: mcpClient,
  log,
});
// `googleService` is declared further down; the port only calls it at tool time.
const googleLostAccess: LostAccessPort = {
  publicOrigin: config.publicOrigin,
  markLost: (why) => googleService.markLost(why),
};
const toolHandlers: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  ["web_search", (args) => webSearch(args, webToolsBackends())],
  ["fetch_webpage", (args) => fetchWebpage(args, webToolsBackends())],
  ...bridgeHandlers(mcpCatalog, mcpClient, {
    url: config.google.mcpUrl,
    lostAccess: googleLostAccess,
    accessFor: googleAccessFor,
  }),
  ...googleHandlers({
    catalog: () => mcpCatalog.current(),
    googleUrl: config.google.mcpUrl,
    client: mcpClient,
    lostAccess: googleLostAccess,
    accessFor: googleAccessFor,
  }),
  ...piService.handlers(),
]);
const modsIo: ModsIo = {
  read: codexIo.read,
  write: codexIo.write,
  // `reload` needs an agent runtime to run in; which agent does not matter —
  // it reloads the global mods for the whole process.
  async reloadMods() {
    const list = await upstream.request<AgentListResponseMessage>({
      type: "agent_list",
      request_id: `bff-mods-agents-${randomUUID()}`,
      query: { limit: 1 },
    });
    const agentId = list.success ? list.agents[0]?.id : undefined;
    if (!agentId) return false;
    const response = await upstream.request<ExecuteCommandResponseMessage>({
      type: "execute_command",
      command_id: "reload",
      request_id: `bff-mods-reload-${randomUUID()}`,
      runtime: { agent_id: agentId, conversation_id: "default" },
    });
    if (!response.success) throw new Error(response.output || "reload failed");
    return true;
  },
};

// What the operator has declared about capability-less models (Settings →
// Providers & models), and the mirror of the currently served list that the
// providers mod is rendered from (bff/src/providers/). The legacy
// VISION_PROVIDERS env is a first-boot seed into the store — a value that
// will not parse is a mistake in the operator's environment, not a reason to
// stay down: log it loudly and seed nothing.
const visionSeed = (() => {
  try {
    return parseVisionProviders(process.env.VISION_PROVIDERS);
  } catch (error) {
    log(`Providers: ignoring VISION_PROVIDERS — ${errorMessage(error)}`);
    return [];
  }
})();
const modelCaps = new ModelCapsStore(config.modelCapsFile, (error) =>
  log(`Model capabilities persist failed: ${errorMessage(error)}`),
);
const seeded = modelCaps.seedFromVisionProviders(visionSeed);
if (seeded > 0) {
  log(`Providers: capability store seeded from VISION_PROVIDERS (${seeded} model(s))`);
}

// The served-model mirror, kept from every model/provider list that passes
// over the permanent connection (browsers' refreshes included) plus forced
// refreshes around renders. A change here re-renders the providers mod, which
// is how an endpoint that gained a model gets it published without a restart.
const providerSight = new ProviderSight({
  request: (command) => upstream.request(command),
  newRequestId: () => `bff-sight-${randomUUID()}`,
  log,
});

/** Every mod as it should be now, from the saved switch and the last catalog. */
async function renderAllMods(): Promise<RenderedMod[]> {
  const web = await loadWebToolsSettings(codexIo);
  const { tools } = mcpCatalog.snapshot();
  const access = agentToolAccess.all();
  const googleHidden = Object.fromEntries(
    Object.entries(access).map(([agentId, a]) => [agentId, googleToolsHiddenAt(a.google)]),
  );
  const mods: RenderedMod[] = [
    {
      path: WEB_TOOLS_MOD_PATH,
      // Effective-enabled: the `search` token must be on for the stored switch
      // to count at all — with the profile off the sidecars do not exist.
      source: renderWebToolsMod({
        enabled: web.enabled && config.features.web,
        port: config.port,
      }),
    },
    {
      path: GOOGLE_TOOLS_MOD_PATH,
      source: renderToolsMod({
        title: "lettuce google-tools v1",
        tools: availableGoogleTools(tools, config.google.mcpUrl).specs,
        port: config.port,
        hidden: googleHidden,
      }),
    },
    {
      path: MCP_BRIDGE_MOD_PATH,
      source: renderToolsMod({
        title: "lettuce mcp-bridge v1",
        tools: tools.length > 0 ? BRIDGE_TOOL_SPECS : [],
        port: config.port,
      }),
    },
    {
      path: AGENT_POLICY_MOD_PATH,
      source: renderAgentPolicyMod({
        codexBlocked: agentsWhere(access, (a) => !a.codex),
        claudeBlocked: agentsWhere(access, (a) => !a.claude),
      }),
    },
  ];
  // The remote pi worker: the stored switch counts only when the `pi`
  // profile token is on, and Agent → Tools access hides the pi tools from a
  // blocked agent's turn the same way Google tools are hidden.
  const pi = await piService.load();
  const piHidden = Object.fromEntries(
    Object.entries(access)
      .filter(([, a]) => a.pi === false)
      .map(([agentId]) => [agentId, [...PI_TOOL_NAMES]]),
  );
  mods.push({
    path: `${MODS_DIR}/lettuce-pi-tools.mjs`,
    source: renderToolsMod({
      title: "lettuce pi-tools v1",
      tools: pi.enabled && config.features.pi ? PI_TOOL_SPECS : [],
      port: config.port,
      hidden: piHidden,
    }),
  });
  // The providers mod mirrors the served model list, so it can only be
  // rendered from a complete mirror: `null` means the mirror is still empty
  // for a prefix that needs one (the BFF connected before the first model
  // list landed) and the existing file must stand — a partial render would
  // erase live models. Retry until the mirror is filled.
  const currentProvidersMod = await codexIo.read(PROVIDERS_MOD_PATH).catch(() => null);
  const providerGroups = buildProviderModGroups({
    models: modelCaps.models(),
    endpoints: modelCaps.endpoints(),
    served: providerSight.servedSnapshot(),
    baseUrlOf: (prefix) => providerSight.baseUrlFor(prefix),
    isLive: (prefix) => providerSight.isConnected(prefix),
    alreadyRegistered: parseRegisteredProviderIds(currentProvidersMod),
  });
  if (providerGroups) {
    mods.push({ path: PROVIDERS_MOD_PATH, source: renderProvidersMod(providerGroups) });
  } else {
    log("Providers: served-model mirror incomplete — providers mod left as-is");
    scheduleProvidersMirrorRetry();
  }
  return mods;
}

/**
 * Mod files this BFF no longer writes, by name. Every one of them was renamed
 * in the `letta-ui` → `lettuce` rename, and each still registers its tools if
 * it survives on disk, so `syncMods` overwrites them with an inert stub. Once
 * every install's mods directory has been through a sync this list can go,
 * along with the stub writer.
 */
const RETIRED_MOD_PATHS: readonly string[] = [
  `${MODS_DIR}/letta-ui-web-tools.mjs`,
  `${MODS_DIR}/letta-ui-google-tools.mjs`,
  `${MODS_DIR}/letta-ui-mcp-bridge.mjs`,
  `${MODS_DIR}/letta-ui-agent-policy.mjs`,
  `${MODS_DIR}/letta-ui-providers.mjs`,
];

// Serialised: a Google change, an MCP save and a reconnect can all land at once.
let modsChain: Promise<unknown> = Promise.resolve();
/** Retries a reload that could not run yet (no agent existed) until one can. */
let modsReloadRetry: ReturnType<typeof setInterval> | null = null;
/** Retry for a providers render deferred on an empty model-list mirror. */
let providersMirrorRetry: ReturnType<typeof setTimeout> | null = null;

function scheduleProvidersMirrorRetry(): void {
  if (providersMirrorRetry) return;
  providersMirrorRetry = setTimeout(() => {
    providersMirrorRetry = null;
    void resyncMods("providers mirror retry", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => {});
  }, 30_000);
}

function resyncMods(
  reason: string,
  options: { refreshCatalog: boolean; refreshProviders?: boolean },
) {
  const run = modsChain.then(async () => {
    if (!upstream.isReady()) return "unchanged" as const;
    // The providers mod is rendered from the mirror, so refresh it first.
    if (options.refreshProviders) await providerSight.refresh();
    if (options.refreshCatalog) await mcpCatalog.refresh();
    const result = await syncMods(modsIo, await renderAllMods(), RETIRED_MOD_PATHS);
    if (result !== "unchanged") log(`Native tools: mods ${result} (${reason})`);
    if (result === "reload-pending") scheduleModsReload();
    return result;
  });
  modsChain = run.catch((error) =>
    log(`Native tools: could not sync mods (${reason}): ${errorMessage(error)}`),
  );
  return run;
}

function scheduleModsReload(): void {
  if (modsReloadRetry) return;
  modsReloadRetry = setInterval(() => {
    if (!upstream.isReady()) return;
    void modsIo
      .reloadMods()
      .then((done) => {
        if (!done || !modsReloadRetry) return;
        clearInterval(modsReloadRetry);
        modsReloadRetry = null;
        log("Native tools: mods reloaded");
      })
      .catch((error) => log(`Native tools: reload failed: ${errorMessage(error)}`));
  }, 30_000);
}

/**
 * After a Google change the sidecar restarts with its new permissions over a
 * few seconds (supervisor.py polls every 2 s), so its tool list is re-read a
 * few times rather than once.
 */
let googleRefreshTimers: ReturnType<typeof setTimeout>[] = [];
function refreshToolsAfterGoogleChange(): void {
  for (const timer of googleRefreshTimers) clearTimeout(timer);
  googleRefreshTimers = [4_000, 12_000, 30_000].map((delay) =>
    setTimeout(
      () => void resyncMods("Google changed", { refreshCatalog: true }).catch(() => {}),
      delay,
    ),
  );
}

// The symlink guard inspects the workspace through this process's own mount. If
// that mount is absent — running the BFF outside the container, or a compose
// file that forgot it — every component stats as ENOENT and the guard passes
// everything. That is fail-open, so say so loudly rather than leaving it to be
// discovered by an escape.
if (!existsSync(WORKSPACE_ROOT)) {
  log(
    `! ${WORKSPACE_ROOT} is not mounted in this process: the symlink guard cannot ` +
      `verify workspace paths and will allow any lexically-in-root path. Mount the ` +
      `host workspaces directory at ${WORKSPACE_ROOT} (see docker/compose.yml).`,
  );
}

upstream.start();

// ── HTTP ─────────────────────────────────────────────────────────────────────
interface AppVariables {
  session: SessionPayload | null;
}

const app = new Hono<{ Variables: AppVariables }>();

// Applied before anything else so every response carries the hardening set,
// including the ones produced by the auth middleware below.
const hardened = securityHeaders({ publicOrigin: config.publicOrigin });
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(hardened)) c.header(name, value);
  await next();
});

app.get("/healthz", (c) => c.text("ok\n"));

app.get("/readyz", (c) =>
  upstream.isReady() ? c.text("ok\n") : c.text(`app-server ${upstream.getState()}\n`, 503),
);

// Which build is this, unauthenticated like /readyz and for the same reason:
// `bun run deploy-check` asks it from outside, with no session, to prove the
// container runs the commit it was built from rather than an older artifact.
// It reveals a version and a commit hash — the same things /readyz reveals about
// state, and no more. The commit itself is not secret and the repo is public.
app.get("/versionz", (c) => c.text(`${uiVersion}\n`));

// Resolves the session for every other route, minting one transparently from
// a Cloudflare Access JWT the first time it sees one with no cookie yet.
// After that first hit, every request (including this one) uses the cheap
// cookie check — no per-request JWKS/JWT verification. Applied as middleware
// (rather than one dedicated login route) so it also covers plain XHRs like
// `/api/status`, not just top-level navigations. The `/ws` upgrade, which runs
// before Hono, resolves through the same function.
const sessionDeps = { config, mint: mintSession, log };
app.use("*", async (c, next) => {
  const resolved = await resolveSession(c.req.raw, sessionDeps);
  if (resolved?.setCookie) c.header("set-cookie", resolved.setCookie, { append: true });
  c.set("session", resolved?.session ?? null);
  await next();
});

// Throttle the API and push routes per user. The WS command path has had a
// limiter since the render loop that OOM'd the app-server; these routes are the
// more expensive half, because a download makes the app-server read a whole
// file and the BFF hold it in memory.
//
// Registered AFTER the session middleware above on purpose: keying the bucket
// needs the resolved identity. Registering it earlier would make every signed-in
// user share the single anonymous bucket, so one person's flood would throttle
// everyone else. Health probes sit outside these prefixes, so an orchestrator's
// polling never counts against a user's bucket.
const httpLimiter = new HttpRateLimiter(DEFAULT_HTTP_CAPACITY, DEFAULT_HTTP_REFILL_PER_SECOND);
const throttle = async (c: Context, next: () => Promise<void>) => {
  const session = c.get("session");
  const retryAfter = httpLimiter.take(session ? session.email : "__anonymous__");
  if (retryAfter !== null) {
    return c.text("Too many requests", {
      status: 429,
      headers: { "retry-after": String(retryAfter) },
    });
  }
  await next();
};
app.use("/api/*", throttle);
app.use("/push/*", throttle);

// The web client reads exactly three fields: `authenticated`, `auth_mode` and
// `user.email`. Everything else here is operational detail — the running
// letta-code version, backend kind, protocol version, how many sessions are
// connected — and this route is UNAUTHENTICATED, so an anonymous visitor could
// fingerprint the deployment straight from it. The full payload is served only
// to a signed-in session, where it is useful for debugging; an anonymous
// caller gets the minimum needed to render a sign-in screen.
app.get("/api/status", (c) => {
  const session = c.get("session");
  const auth_mode = config.devBypassEmail
    ? "dev-bypass"
    : config.mode === "cloudflared"
      ? "cf-access"
      : "none";

  if (!session) return c.json({ authenticated: false, auth_mode });

  return c.json({
    authenticated: true,
    auth_mode,
    user: { email: session.email },
    version: uiVersion,
    // Which integrations this deployment offers (from COMPOSE_PROFILES) — the
    // web hides the matching Settings sections and lists on this.
    features: config.features,
    // What the app-server image actually has installed; null until read, or
    // when the image predates the marker. Compare against `features` — a token
    // on with the CLI missing is a stale image, which the connect log also says.
    coding_installed: codingInstalled,
    upstream: {
      state: upstream.getState(),
      info: upstream.getInfo(),
      generation: upstream.getGeneration(),
    },
    sessions: registry.sessionCount,
    latest_seq: registry.latestSeq,
  });
});

// Dev-bypass's only self-service entry point. In production (Access
// enforcing) there is nothing for this route to do — a visitor who reaches
// the origin at all already has a valid Access JWT, which the middleware
// above turns into a session before any handler runs.
app.get("/auth/login", (c) => {
  if (config.devBypassEmail) return c.redirect("/auth/dev-login");
  return c.text("Sign in via Cloudflare Access.", 400);
});

app.get("/auth/dev-login", (c) => {
  const email = config.devBypassEmail;
  if (!email) return c.text("Dev login is disabled", 404);

  // Unset ALLOWED_USERS makes the bypass email its own allowlist, so this can
  // only fire when both were set explicitly and name different people — a real
  // misconfiguration rather than the self-contradiction it used to report.
  if (!isAllowedUser(config, email)) {
    return c.text(`DEV_BYPASS_EMAIL ${email} is not listed in ALLOWED_USERS`, 403);
  }

  log(`Dev login as ${email} (NO AUTHENTICATION — loopback only)`);
  const { cookie } = mintSession(email);
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookie, ...hardened },
  });
});

app.post("/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie(secureCookies));
  return c.json({ ok: true });
});

app.get("/push/vapid-key", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.push) return c.text("Push notifications are not configured on this instance", 404);
  return c.json({ key: config.push.vapidPublicKey });
});

app.post("/push/subscribe", async (c) => {
  const session = c.get("session");
  if (!session) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  try {
    const body = await c.req.json();
    const record = pushStore.add(
      body,
      session.email,
      (body as { preferences?: unknown })?.preferences,
    );
    return c.json({ ok: true, preferences: record.preferences });
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Malformed subscription", 400);
  }
});

app.post("/push/unsubscribe", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

  pushStore.remove(endpoint);
  return c.json({ ok: true });
});

app.get("/push/preferences", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const endpoint = c.req.query("endpoint");
  if (!endpoint) return c.text("Missing endpoint", 400);

  const preferences = pushStore.getPreferences(endpoint);
  if (!preferences) return c.text("Unknown push subscription", 404);
  return c.json({ preferences });
});

app.post("/push/preferences", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

  try {
    const record = pushStore.updatePreferences(
      endpoint,
      (body as { preferences?: unknown }).preferences,
    );
    return c.json({ ok: true, preferences: record.preferences });
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Unknown push subscription", 404);
  }
});

// Delivery, proven end to end, without staging an unwatched turn. Every real
// trigger is suppressed while a visible session is on that conversation, so a
// device that is subscribed but undeliverable is otherwise indistinguishable
// from one that is simply being watched. This route skips that check and the
// per-event preferences: it is the user asking for exactly this notification.
app.post("/push/test", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

  const record = pushStore.all().find((candidate) => candidate.endpoint === endpoint);
  if (!record) return c.text("Unknown push subscription", 404);

  try {
    const result = await sendPush(record, {
      title: "Lettuce",
      body: "Test notification — push is working on this device.",
      url: "/",
    });
    if (result === "gone") {
      pushStore.remove(endpoint);
      log(`Push test: ${endpoint} is gone; removed`);
      return c.text("This device's subscription has expired — turn notifications off and on", 410);
    }
    log(`Push test: sent to ${endpoint}`);
    return c.json({ ok: true });
  } catch (error) {
    log(`Push test to ${endpoint} failed: ${errorMessage(error)}`);
    return c.text(errorMessage(error), 502);
  }
});

// ── MCP servers ─────────────────────────────────────────────────────────────
// One shared list for every agent, in a settings file only the BFF writes and
// only `letta mcp` (run from agent shells with HOME pointed at it) reads — see
// `mcp/settings.ts` for why upstream's per-agent settings.json cannot hold it.
// The browser never gets a write handle on it: an MCP entry is a command line
// that agent shells will exec.

app.get("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  try {
    return c.json({ servers: await loadMcpServers(mcpIo) });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  const body = await c.req.json().catch(() => null);
  let servers: McpServer[];
  try {
    servers = validateMcpServers((body as { servers?: unknown } | null)?.servers);
  } catch (error) {
    if (error instanceof InvalidMcpServersError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 400);
  }

  // The file needs no reload — the next `letta mcp` call and the next turn's
  // skill listing see it from disk — but the bridge's catalog and its mod do.
  try {
    await saveMcpServers(mcpIo, servers);
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
  void resyncMods("Settings → MCP", { refreshCatalog: true }).catch(() => {});
  return c.json({ ok: true, servers });
});

// ── Skills ──────────────────────────────────────────────────────────────────
// Upstream publishes the skill list only on a live conversation runtime, which
// is evicted between turns — so the BFF discovers it itself. See
// `skills/discovery.ts`.

// ── Pinned and archived agents ──────────────────────────────────────────────
// What the switcher and sidebar list first, and what they hide; see
// `agents/id-list.ts`. One GET for both, so a list renders once.

app.get("/api/agents/flags", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  return c.json({ pinned: agentPins.list(), archived: agentArchive.list() });
});

// Archiving also unpins: a hidden agent has no business leading the list.
app.put("/api/agents/archived/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const body = (await c.req.json().catch(() => null)) as { archived?: unknown } | null;
  if (typeof body?.archived !== "boolean") return c.text("Body must be { archived: boolean }", 400);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  const archived = agentArchive.set(agentId, body.archived);
  const pinned = body.archived ? agentPins.set(agentId, false) : agentPins.list();
  return c.json({ pinned, archived });
});

app.get("/api/agents/pins", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  return c.json({ pinned: agentPins.list() });
});

app.put("/api/agents/pins/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const body = (await c.req.json().catch(() => null)) as { pinned?: unknown } | null;
  if (typeof body?.pinned !== "boolean") return c.text("Body must be { pinned: boolean }", 400);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  return c.json({ pinned: agentPins.set(agentId, body.pinned) });
});

// ── Per-agent tool access ───────────────────────────────────────────────────
// Codex workers and Google, narrowed per agent (Agent → Tools); enforced by the
// rendered mods, see `agents/tool-access.ts`.

app.get("/api/agents/tool-access/:agentId", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  return c.json(agentToolAccess.get(agentId));
});

app.put("/api/agents/tool-access/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  const access = parseToolAccess(await c.req.json().catch(() => null));
  if (!access) {
    return c.text(
      'Body must be { codex: boolean, claude: boolean, google: "full" | "read" | "off", pi?: boolean }',
      400,
    );
  }
  if (agentToolAccess.set(agentId, access)) {
    // Awaited so the answer says whether it is live; a new turn picks it up either way.
    const mods = await resyncMods("Agent → Tools", { refreshCatalog: false }).catch(() => null);
    return c.json({ ...agentToolAccess.get(agentId), mods: mods ?? "failed" });
  }
  return c.json({ ...agentToolAccess.get(agentId), mods: "unchanged" });
});

app.get("/api/skills", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.text("agent_id is required", 400);
  try {
    return c.json(await skillCatalog.list(agentId, c.req.query("cwd")));
  } catch (error) {
    if (error instanceof InvalidSkillScopeError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

// ── Codex workers ───────────────────────────────────────────────────────────
// Settings → Codex, and the run viewer. See `codex/` for what the files are and
// why the BFF, not the browser, touches them.

app.get("/api/codex/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  try {
    const [settings, suggestedBaseUrl] = await Promise.all([
      loadCodexSettings(codexIo),
      suggestedCodexBaseUrl(codexIo),
    ]);
    return c.json({ settings: toPublicCodexSettings(settings), suggestedBaseUrl });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/codex/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  // Gated by the `codex` profile token: nothing to configure without the CLI,
  // and the connect-time reapply has already forced the stored switch off.
  if (!config.features.codex) return c.text("Codex workers are off: COMPOSE_PROFILES", 404);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await saveCodexSettings(codexIo, body);
    return c.json({ settings: toPublicCodexSettings(saved) });
  } catch (error) {
    if (error instanceof InvalidCodexSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

// Settings → Web: the native web tools' switch, backend status and a test search.
app.get("/api/web-tools/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  try {
    const settings = await loadWebToolsSettings(codexIo);
    return c.json({ settings: { enabled: settings.enabled } });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/web-tools/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  // Gated by the `search` profile token: without the sidecars there is no
  // backend to point the switch at.
  if (!config.features.web) return c.text("Web search is off: COMPOSE_PROFILES", 404);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await saveWebToolsSettings(codexIo, body);
    const mod = await resyncMods("Settings → Web", { refreshCatalog: false });
    return c.json({ settings: { enabled: saved.enabled }, mod });
  } catch (error) {
    if (error instanceof InvalidWebToolsSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/web-tools/status", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  return c.json(
    await webToolsStatus({
      searxngUrl: config.webTools.searxngUrl,
      ddgMcpUrl: config.webTools.ddgMcpUrl,
      read: codexIo.read,
    }),
  );
});

// The same search an agent's `web_search` runs, so the settings screen can
// prove the backends answer without starting a turn.
app.post("/api/web-tools/test", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const body = (await c.req.json().catch(() => null)) as { query?: unknown } | null;
  return c.json(await webSearch({ query: body?.query, max_results: 5 }, webToolsBackends()));
});

// ── Model capabilities ──────────────────────────────────────────────────────
// What the operator declares about models behind endpoints that report no
// capabilities (plain OpenAI-compatible and its BYOK aliases): vision,
// thinking, the real context window. The declarations drive the providers mod
// — which is THE capability truth for every prefix it registers — so a save
// re-renders and reloads it and answers with the same `mod` state the
// web-tools switch uses ("reload-pending" when no agent exists yet).
// Keys stored here are write-only: no route echoes them, same rule as the
// provider connections themselves.

app.get("/api/model-caps", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  // Endpoint snapshots minus the key: a declared provider no Settings
  // connection owns (an env-seeded one like halogen) still needs its URL and
  // name to render as a served model. Keys stay write-only, same as everywhere.
  const endpoints = Object.fromEntries(
    Object.entries(modelCaps.endpoints()).map(([prefix, info]) => [
      prefix,
      {
        ...(info.baseUrl ? { baseUrl: info.baseUrl } : {}),
        ...(info.name ? { name: info.name } : {}),
      },
    ]),
  );
  return c.json({ models: modelCaps.models(), endpoints });
});

app.put("/api/model-caps", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  let saved: ReturnType<typeof parseModelCapsBody>;
  try {
    saved = parseModelCapsBody(await c.req.json().catch(() => null));
  } catch (error) {
    if (error instanceof ModelCapsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 400);
  }
  modelCaps.setModel(saved.handle, saved.caps);
  // Snapshot what the live connection currently has, so the group survives
  // the connection going away; a blank key keeps the stored one (the protocol
  // can never read it back, so the save form starts blank every time).
  const prefix = saved.handle.slice(0, saved.handle.indexOf("/"));
  const baseUrl = providerSight.baseUrlFor(prefix);
  modelCaps.setEndpoint(prefix, {
    ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
  // Awaited so the answer says whether it is live; the reload retries on its
  // own while no agent exists to carry it.
  const mod = await resyncMods("Settings → model capabilities", {
    refreshCatalog: false,
    refreshProviders: true,
  }).catch(() => null);
  return c.json({ model: { handle: saved.handle, ...saved.caps }, mod: mod ?? "failed" });
});

app.delete("/api/model-caps", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const parts = splitHandle(c.req.query("handle"));
  if (!parts) return c.text('handle must look like "provider/model"', 400);
  const removed = modelCaps.removeModel(`${parts.prefix}/${parts.model}`);
  const mod = await resyncMods("Settings → model capabilities", {
    refreshCatalog: false,
    refreshProviders: true,
  }).catch(() => null);
  return c.json({ removed, mod: mod ?? "failed" });
});

// What agents currently have as native tools from the MCP side: the curated
// Google tools the grant allows, and which servers the bridge reaches.
app.get("/api/native-tools", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const { tools, failures } = mcpCatalog.snapshot();
  const servers = [...new Set(tools.map((t) => t.server.name))];
  return c.json({
    google: availableGoogleTools(tools, config.google.mcpUrl).specs.map((s) => s.name),
    bridge: { servers, tools: tools.length, failures: Object.fromEntries(failures) },
  });
});

app.get("/api/codex/runs", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
  try {
    return c.json({ runs: await listCodexRuns(codexIo, limit) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/codex/runs/:threadId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const threadId = c.req.param("threadId");
  // The id becomes part of a file lookup; only a real Codex thread id gets that far.
  if (!isCodexThreadId(threadId)) return c.text("Not a Codex thread id", 400);
  try {
    const run = await getCodexRun(codexIo, threadId);
    return run ? c.json({ run }) : c.text("No such Codex run", 404);
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

// ── Claude Code workers ─────────────────────────────────────────────────────
// Settings → Claude Code, and the run viewer. See `claude/` for what the files
// are; the io plumbing is the same `codexIo` — one app-server file channel.

app.get("/api/claude/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  try {
    return c.json({ settings: toPublicClaudeSettings(await loadClaudeSettings(claudeIo)) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/claude/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  // Gated by the `claude` profile token, exactly like Codex above.
  if (!config.features.claude) return c.text("Claude Code workers are off: COMPOSE_PROFILES", 404);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await saveClaudeSettings(claudeIo, body);
    return c.json({ settings: toPublicClaudeSettings(saved) });
  } catch (error) {
    if (error instanceof InvalidClaudeSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/claude/runs", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
  try {
    return c.json({ runs: await listClaudeRuns(claudeIo, limit) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/claude/runs/:sessionId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const sessionId = c.req.param("sessionId");
  // The id becomes part of a file lookup; only a real Claude session id gets that far.
  if (!isClaudeSessionId(sessionId)) return c.text("Not a Claude session id", 400);
  try {
    const run = await getClaudeRun(claudeIo, sessionId);
    return run ? c.json({ run }) : c.text("No such Claude run", 404);
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

// ── Remote pi worker ─────────────────────────────────────────────────────
// Everything BFF-local: settings and keys on `bff-data`, runs captured from
// the BFF's own ssh spawns. No upstream file channel, no app-server involved.
// See `pi/` and docs/remote-pi-plan.md.

/** A body may carry form values that are not saved yet — a check tests those. */
function piDraftFromBody(body: unknown): Partial<Record<string, unknown>> {
  if (!body || typeof body !== "object") return {};
  const r = body as Record<string, unknown>;
  const draft: Partial<Record<string, unknown>> = {};
  for (const field of ["host", "user", "pathPrepend", "workdir"] as const) {
    if (typeof r[field] === "string") draft[field] = r[field];
  }
  if (r.port !== undefined) draft.port = r.port;
  return draft;
}

app.get("/api/pi/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const settings = await piService.load();
  return c.json({
    settings: toPublicPiSettings(settings),
    // What the last check said about the saved target, or null. The UI adds
    // "changed since the last check" itself; the BFF only remembers facts.
    check: await piService.lastCheck(settings),
    // Which agents point somewhere of their own, so the shared section can say
    // "2 agents use their own settings" instead of being surprised by them.
    agents: Object.entries(piService.agentSettings.all()).map(([agentId, override]) => ({
      agentId,
      mode: override.mode,
    })),
  });
});

app.put("/api/pi/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await piService.save(body);
    const mod = await resyncMods("Settings → Remote pi", { refreshCatalog: false });
    // Save answers the question automatically, because an unpinned or
    // unreachable host is otherwise discovered by an agent's failed run. A
    // check that cannot run never fails the save.
    const check = await piService.checkHost(saved).catch(() => null);
    return c.json({ settings: toPublicPiSettings(saved), mod, check });
  } catch (error) {
    if (error instanceof InvalidPiSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

/** What a check is about: saved values, or the form's, plus whose host to use. */
function piCheckBody(body: unknown): { draft: Record<string, unknown>; agentId: string | null } {
  const r = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof r.agent_id === "string" && isAgentId(r.agent_id) ? r.agent_id : null;
  return { draft: piDraftFromBody(body), agentId };
}

/**
 * One agent's own Remote Pi settings: its workdir, and if it must, its own host.
 * Stored by the BFF beside the pi settings and resolved at tool-call time, so
 * the four pi tools stay exactly the four tools upstream sees.
 */
async function piAgentPayload(agentId: string) {
  const global = await piService.load();
  const effective = await piService.settingsFor(agentId);
  return {
    agentId,
    override: piService.agentSettings.get(agentId),
    effective: toPublicPiSettings(effective),
    globalConfigured: piConfigured(global),
    globalTarget:
      global.host && global.user ? `${global.user}@${global.host}:${global.port}` : null,
    check: await piService.lastCheck(effective),
  };
}

app.get("/api/pi/agent/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  return c.json(await piAgentPayload(agentId));
});

app.put("/api/pi/agent/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  const body = await c.req.json().catch(() => null);
  const override = parsePiAgentSettings(body);
  if (!override) {
    return c.text("Body must be { mode, host, port, user, pathPrepend, workdir, model }", 400);
  }
  try {
    assertEffectiveUsable(await effectivePiSettings(await piService.load(), override));
  } catch (error) {
    if (error instanceof InvalidPiAgentSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 500);
  }
  piService.agentSettings.set(agentId, override);
  await piService.agentSettings.drain();
  // Same courtesy as the shared settings: answer the host question right away.
  const check = await piService.checkHost({}, agentId).catch(() => null);
  return c.json({ ...(await piAgentPayload(agentId)), check });
});

/** Back to inheriting everything. */
app.delete("/api/pi/agent/:agentId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  piService.agentSettings.remove(agentId);
  await piService.agentSettings.drain();
  return c.json(await piAgentPayload(agentId));
});

/** Check the host — saved values, or the form's, when they are not saved yet. */
app.post("/api/pi/check", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const body = await c.req.json().catch(() => null);
  try {
    const { draft, agentId } = piCheckBody(body);
    return c.json({ check: await piService.checkHost(draft as never, agentId) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

/**
 * TOFU pin: ssh-keyscan a host and write what it answers. A different key
 * already pinned for that host is a 409 with both fingerprints — replacing it
 * is a second, deliberate click.
 */
app.post("/api/pi/pin-host", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const options = {
    ...(typeof body?.host === "string" ? { host: body.host } : {}),
    ...(Number.isFinite(Number(body?.port)) && body?.port !== undefined && body?.port !== ""
      ? { port: Number(body.port) }
      : {}),
    ...(body?.force === true ? { force: true } : {}),
    ...(typeof body?.agent_id === "string" && isAgentId(body.agent_id)
      ? { agentId: body.agent_id }
      : {}),
  };
  try {
    const pinned = await piService.pinHost(options);
    if (pinned.changed) return c.json({ pinned }, 409);
    return c.json({ pinned });
  } catch (error) {
    return c.text(errorMessage(error), 400);
  }
});

/** Generate or rotate the lettuce-held deploy key; only the public half is served. */
app.post("/api/pi/generate-key", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.features.pi) return c.text("Remote pi worker is off: COMPOSE_PROFILES", 404);
  try {
    const settings = await piService.generateKeyPair();
    return c.json({ settings: toPublicPiSettings(settings) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/pi/runs", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
  const runs = (await piService.listRuns(limit)).map(summarizePiRun);
  return c.json({ runs });
});

app.get("/api/pi/runs/:runId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const runId = c.req.param("runId");
  if (!isPiRunId(runId)) return c.text("Not a run id", 400);
  const meta = await piService.getRun(runId);
  if (!meta) return c.text("No such run", 404);
  const events = (await piService.store.readEventsTail(runId, 8_000_000)) ?? "";
  return c.json({ run: parsePiRun(meta, events), capturing: piService.runner.isRunning(runId) });
});

// ── Google (Gmail / Calendar / Tasks) ───────────────────────────────────────
// Agents use Google through the `google-mcp` sidecar; this is where the user
// decides how far. The policy and the token live on volumes only the BFF and
// the sidecar mount — never the app-server, where agent shells run — so an
// agent cannot change its own access. See `google/`.

/** The shared MCP list is only how agents find the sidecar; access is decided there. */
async function syncGoogleMcpEntry(serving: boolean): Promise<void> {
  if (!upstream.isReady()) return; // retried by `reapply` on the next connect
  // Every Google change passes through here (save, connect, disconnect,
  // reapply), and each can change which Google tools the sidecar offers.
  refreshToolsAfterGoogleChange();
  const servers = await loadMcpServers(mcpIo);
  const listed = servers.some((server) => server.url === config.google.mcpUrl);
  if (serving === listed) return;
  await saveMcpServers(
    mcpIo,
    serving
      ? [...servers, { name: "google", transport: "http", url: config.google.mcpUrl }]
      : servers.filter((server) => server.url !== config.google.mcpUrl),
  );
  log(`Google: ${serving ? "added to" : "removed from"} the shared MCP list`);
}

const googleService = new GoogleService({
  io: createGoogleFsIo(config.google.policyDir, config.google.credsDir),
  fetch: (input, init) => fetch(input, init),
  redirectUri: config.google.redirectUri,
  syncMcpEntry: syncGoogleMcpEntry,
  // The `google` profile token: stored settings intact, sidecar and MCP entry
  // off while it is absent. See `GoogleServiceDeps.profileEnabled`.
  profileEnabled: () => config.features.google,
  log,
});

/** Whether the sidecar answers at all — it serves nothing while disabled. */
async function googleSidecarUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", config.google.mcpUrl), {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function googleWriteRefusal(c: Context): Response | null {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!googleWritesAllowed(config)) {
    return c.text(
      "Google access cannot be changed while DEV_BYPASS_EMAIL is set: agents can sign " +
        "themselves in through the bypass. Use Cloudflare Access, or set " +
        "GOOGLE_ALLOW_DEV_BYPASS=true on a machine only you use.",
      403,
    );
  }
  return null;
}

function googleErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof InvalidGoogleSettingsError || error instanceof GoogleAccessError) {
    return c.text(error.message, 400);
  }
  if (error instanceof GoogleOAuthError) return c.text(error.message, 502);
  return c.text(errorMessage(error), 500);
}

app.get("/api/google", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  try {
    // Opening Settings → Google asks Google whether the token still works (at
    // most every few minutes), so it shows the truth, not what consent said.
    await googleService.checkIfDue(GOOGLE_STATUS_CHECK_MS);
    const [settings, sidecarUp] = await Promise.all([googleService.status(), googleSidecarUp()]);
    return c.json({
      settings,
      sidecarUp,
      redirectUri: config.google.redirectUri,
      writable: googleWritesAllowed(config),
    });
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.put("/api/google", async (c) => {
  // Gated by the `google` profile token, which is also what starts the
  // sidecar; the stored switch is treated as off while it is absent.
  if (!config.features.google) return c.text("Google is off: COMPOSE_PROFILES", 404);
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(await googleService.save(body));
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

const GOOGLE_STATUS_CHECK_MS = 5 * 60 * 1000;

// One click from a chat link to Google's consent screen: what an agent hands
// the user when access is lost (`google/lost-access.ts`). A GET because it is a
// link; it only mints a single-use `state` for the signed-in user and sends
// them to Google, where nothing happens without their own consent. When it
// cannot (signed out, read-only, no client saved) it lands on Settings → Google,
// which says why.
app.get("/api/google/reconnect", async (c) => {
  const settingsPage = googleSettingsUrl(config.publicOrigin);
  if (!c.get("session") || !googleWritesAllowed(config)) return c.redirect(settingsPage, 302);
  try {
    return c.redirect(await googleService.startConnect(), 302);
  } catch {
    return c.redirect(settingsPage, 302);
  }
});

app.post("/api/google/connect", async (c) => {
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  try {
    return c.json({ url: await googleService.startConnect() });
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.post("/api/google/disconnect", async (c) => {
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  try {
    return c.json(await googleService.disconnect());
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.post("/api/google/verify", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  try {
    return c.json(await googleService.verify());
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function googleResultPage(title: string, detail: string, status: number): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)}</title>` +
    `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    `<p><a href="/?settings=google">Back to the app</a> — Settings → Google shows what agents can do.</p>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...hardened },
  });
}

// Google's redirect back. Deliberately not gated on the session: with a
// GOOGLE_OAUTH_REDIRECT_URI override (local testing via localhost) the browser
// arrives on another origin without our cookie. The single-use `state` minted
// by the gated /connect is what authorises it.
app.get("/api/google/oauth/callback", async (c) => {
  try {
    const { email } = await googleService.finishConnect({
      state: c.req.query("state"),
      code: c.req.query("code"),
      error: c.req.query("error"),
    });
    return googleResultPage("Google connected", `Agents now act as ${email}.`, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return googleResultPage("Google was not connected", detail, 400);
  }
});

// Failed turns for one conversation, which the transcript cannot reload on its
// own: the app-server never stores them. See `session/turn-errors.ts`.
app.get("/api/turn-errors", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.query("agent_id");
  const conversationId = c.req.query("conversation_id");
  if (!agentId || !conversationId) return c.text("Missing agent_id or conversation_id", 400);
  return c.json({ errors: turnErrors.list(scopeKeyOf(agentId, conversationId)) });
});

// Token usage of the last turn and the one in flight, per conversation, so
// every device shows the same gauge. See `session/turn-usage.ts`.
app.get("/api/turn-usage", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.query("agent_id");
  const conversationId = c.req.query("conversation_id");
  if (!agentId || !conversationId) return c.text("Missing agent_id or conversation_id", 400);
  return c.json(turnUsage.get(scopeKeyOf(agentId, conversationId)));
});

// A real HTTP URL for a workspace file, so a chat-message link or the Files
// tab can hand the browser a plain download instead of driving the read_file
// WS command itself. Goes through the app-server exactly like every other
// file command — no new upstream surface, just a new way to reach the
// existing one over HTTP instead of the browser's multiplexed WS session.
app.get("/api/files/download", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);

  const path = c.req.query("path");
  if (!path) return c.text("Missing path", 400);

  const violation = workspaceViolation({ type: "read_file", path });
  if (violation) return c.text(violation, 400);

  // Same reason as the WS path: a symlink under /work resolves outside it and
  // the app-server follows it without resolving.
  const symlink = symlinkViolation(path, WORKSPACE_ROOT);
  if (symlink) return c.text(symlink, 400);

  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  let response: ReadFileResponseMessage;
  try {
    response = await upstream.request<ReadFileResponseMessage>({
      type: "read_file",
      path,
      request_id: `bff-download-${randomUUID()}`,
      encoding: "base64",
    });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }

  if (!response.success || typeof response.content !== "string") {
    return c.text(response.error ?? "Failed to read file", 404);
  }

  // A Buffer IS a Uint8Array, so it goes straight to Response. Wrapping it in
  // `new Uint8Array(bytes)` would copy the whole decoded file again for no
  // reason — and this route already holds the base64 string from upstream plus
  // the decoded bytes.
  const bytes = Buffer.from(response.content, "base64");
  const filename = path.split("/").pop() || "download";
  // `?inline=1` (chat-message links) asks for a viewable response; only PDFs
  // and raster images actually get one — see `inlineContentType`.
  const inlineType = c.req.query("inline") != null ? inlineContentType(filename) : null;
  return new Response(bytes, {
    headers: {
      "content-type": inlineType ?? "application/octet-stream",
      "content-disposition": contentDisposition(filename, inlineType ? "inline" : "attachment"),
      "content-length": String(bytes.length),
      // Spread last-but-one: the hardening set must survive, and `nosniff` in
      // particular matters here because this is the route that hands the
      // browser agent-authored bytes.
      ...hardened,
    },
  });
});

// ── Git history (Files → History) ──────────────────────────────────────────
// Upstream exposes only branch commands and the app-server image ships no git
// binary, so the log is read here, against the BFF's read-only view of /work,
// and nothing goes upstream. The handlers (session, workspace clamp, symlink
// guard, realpath re-check, then git) live in `git/routes.ts`; this is only
// the HTTP plumbing. See that file and `git/log.ts` for the reasoning.

app.get("/api/git/repo", async (c) => {
  return gitResponse(
    c,
    await gitRepoResponse({ hasSession: !!c.get("session") }, { path: c.req.query("path") }),
  );
});

app.get("/api/git/log", async (c) => {
  return gitResponse(
    c,
    await gitLogResponse(
      { hasSession: !!c.get("session") },
      {
        path: c.req.query("path"),
        limit: c.req.query("limit"),
        skip: c.req.query("skip"),
      },
    ),
  );
});

app.get("/api/git/commit", async (c) => {
  return gitResponse(
    c,
    await gitCommitResponse(
      { hasSession: !!c.get("session") },
      { path: c.req.query("path"), sha: c.req.query("sha") },
    ),
  );
});

function gitResponse(c: Context, result: GitRouteResult): Response {
  // The handler picked the status; plain numbers do not satisfy Hono's json
  // overload, which is the entire reason for the cast.
  const status = result.status as 200;
  return result.json !== undefined
    ? c.json(result.json, status)
    : c.text(result.text ?? "", status);
}

// ── Static SPA ───────────────────────────────────────────────────────────────
// Registered last: Hono matches in order, so /api, /auth and the health probes
// above always win. In local development Vite serves the app instead and
// proxies those paths here, so a missing build is not an error.
const webDist = process.env.WEB_DIST ?? "web/dist";

// Any real file in the build — hashed `/assets/*`, and the root-level PWA files
// `sw.js`, `manifest.webmanifest`, `icon-*.png`. Without this the catch-all
// below answered `/sw.js` and `/manifest.webmanifest` with the HTML shell, so
// the service worker never registered and the manifest never parsed — the app
// looked like a PWA in source but could not be installed. `serveStatic` calls
// `next()` when the file is absent, so client routes still fall through.
app.get("*", serveStatic({ root: webDist }));

// SPA fallback — every unmatched GET renders the app shell so client-side
// routes survive a reload or a deep link.
app.get("*", serveStatic({ path: `${webDist}/index.html` }));

/** A fresh session for `email`, and the `set-cookie` value that carries it. */
function mintSession(email: string): { session: SessionPayload; cookie: string } {
  const session: SessionPayload = {
    email,
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  };
  const token = encodeSession(session, config.sessionSecret);
  return { session, cookie: buildSessionCookie(token, config.sessionTtlSeconds, secureCookies) };
}

/** The non-empty `endpoint` a push request body names, or null. */
function endpointOf(body: unknown): string | null {
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
}

// ── WebSocket ────────────────────────────────────────────────────────────────
interface SocketData {
  /** Null for an upgrade accepted only to be told it is signed out; see `/ws`. */
  user: SessionUser | null;
  sessionId: string;
}

/**
 * Close code for "signed out". A refused upgrade (401) reaches the browser as
 * a bare 1006, indistinguishable from being offline, so the client retried
 * forever; a close code after the handshake is the one signal it can read.
 */
const AUTH_REQUIRED_CLOSE_CODE = 4401;

// PUBLIC_ORIGIN is only a declaration of intent; the bind address is the
// enforcement. The bypass stays on loopback unless DEV_BYPASS_ALLOW_REMOTE
// explicitly says otherwise, so it cannot reach the network by accident.
const bindHostname =
  config.devBypassEmail && !config.devBypassAllowRemote ? "127.0.0.1" : "0.0.0.0";

const server = Bun.serve<SocketData>({
  port: config.port,
  hostname: bindHostname,

  async fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // A WebSocket handshake is not subject to CORS, and SameSite=Lax does not
      // cover upgrades — so without this check any page the signed-in user
      // visits could open a socket to this BFF and act as them.
      const origin = checkUpgradeOrigin(
        request.headers.get("origin"),
        config.mode,
        config.publicOrigin,
        request.headers.get("host"),
      );
      if (!origin.ok) {
        log(`Refused /ws upgrade: ${origin.reason}`);
        return new Response("Forbidden origin", { status: 403, headers: hardened });
      }

      // Signed out is accepted and then closed with AUTH_REQUIRED_CLOSE_CODE
      // (see `open` below), so the client can tell it apart from offline. A
      // session minted from the Access JWT rides back on the 101's cookie.
      const resolved = await resolveSession(request, sessionDeps);
      // The authenticated identity rides along in `data`, so the socket never
      // has to re-derive it from cookies after the upgrade.
      const upgraded = bunServer.upgrade(request, {
        ...(resolved?.setCookie ? { headers: { "set-cookie": resolved.setCookie } } : {}),
        data: {
          user: resolved ? { email: resolved.session.email } : null,
          sessionId: "",
        } satisfies SocketData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400, headers: hardened });
    }

    // The web-tools mod's calls: loopback only, before Hono's session layer.
    const internal = await handleInternalTools(
      request,
      bunServer.requestIP(request)?.address,
      () => toolHandlers,
    );
    if (internal) return internal;

    return app.fetch(request);
  },

  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      if (!ws.data.user) {
        ws.send(JSON.stringify({ type: "__bff_auth_required" }));
        ws.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
        return;
      }
      ws.data.sessionId = registry.add(
        {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
        },
        ws.data.user,
      );
    },

    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      if (!ws.data.sessionId) return;
      registry.handleSessionMessage(
        ws.data.sessionId,
        typeof message === "string" ? message : message.toString("utf8"),
      );
    },

    close(ws: ServerWebSocket<SocketData>) {
      // Browser socket only. The upstream connection is untouched, so any
      // in-flight turn keeps running.
      registry.remove(ws.data.sessionId);
    },
  },
});

log(`Mode: ${config.mode}`);
const featureNames = enabledFeatureNames(config.features);
log(
  `Features: ${
    featureNames.length > 0 ? featureNames.join(", ") : "(none — no feature token in LETTA_MODE)"
  }`,
);
log(`Listening on ${bindHostname}:${server.port} (public origin ${config.publicOrigin})`);
log(`App-server: ${config.appServerUrl}`);
// A misbuilt image without git would otherwise be noticed only as a quiet 503
// on the first History open; say it out loud once here instead.
void checkGitAvailability(runGit, (message) => log(message));
log(`Allowlisted users: ${config.allowedUsers.join(", ") || "(none — nobody can sign in)"}`);
if (config.devBypassEmail) {
  log("!".repeat(72));
  log(`DEV BYPASS ACTIVE — no authentication. Any request gets a session as`);
  log(`${config.devBypassEmail}.`);
  log(
    config.devBypassAllowRemote
      ? `EXPOSED ON THE NETWORK at ${config.publicOrigin} by DEV_BYPASS_ALLOW_REMOTE=true.`
      : "Bound to 127.0.0.1 only; not reachable off this machine.",
  );
  log("!".repeat(72));
}

// Closing the upstream connection cancels every turn in flight (it is the only
// subscriber of every scope), so shutdown first drains: browsers keep being
// served and the connection stays open until no turn is running, bounded by
// SHUTDOWN_DRAIN_TIMEOUT_SECONDS. A second signal skips the wait.
let shuttingDown = false;
let secondSignal: () => void = () => {};
const interrupted = new Promise<void>((resolve) => {
  secondSignal = resolve;
});

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down`);
  await drainActiveTurns({
    activeScopes: () => (upstream.isReady() ? registry.activeScopes() : []),
    timeoutMs: config.shutdownDrainTimeoutMs,
    log,
    interrupted,
  });
  upstream.stop();
  await server.stop(true);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      log(`Received ${signal} again, not waiting any longer`);
      secondSignal();
      return;
    }
    shuttingDown = true;
    void shutdown(signal);
  });
}
