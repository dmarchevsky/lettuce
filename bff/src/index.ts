import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AgentListResponseMessage,
  AgentRetrieveResponseMessage,
  ConversationRetrieveResponseMessage,
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
import { AgentAncestry } from "./agents/ancestry.ts";
import { AgentFacts } from "./agents/facts.ts";
import { AgentIdList, isAgentId } from "./agents/id-list.ts";
import {
  AgentToolAccessStore,
  agentsWhere,
  inheritAccess,
  parseToolAccess,
} from "./agents/tool-access.ts";
import { checkUpgradeOrigin } from "./auth/origin.ts";
import { resolveSession } from "./auth/resolve-session.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  encodeSession,
  type SessionPayload,
} from "./auth/session-cookie.ts";
import { registerClaudeRoutes } from "./claude/routes.ts";
import { type ClaudeFileIo, reapplyClaudeSettings } from "./claude/service.ts";
import { AGENT_POLICY_MOD_PATH, renderAgentPolicyMod } from "./codex/policy-mod.ts";
import { registerCodexRoutes } from "./codex/routes.ts";
import { type CodexFileIo, reapplyCodexSettings } from "./codex/service.ts";
import {
  type BffConfig,
  enabledFeatureNames,
  googleWritesAllowed,
  isAllowedUser,
  loadConfig,
} from "./config.ts";
import {
  CODING_MARKER_LEGACY_PATH,
  CODING_MARKER_PATH,
  type CodingMarker,
  type Component,
  deploymentComponents,
  parseCodingMarker,
} from "./deployment.ts";
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
import type { LostAccessPort } from "./google/lost-access.ts";
import { registerGoogleRoutes } from "./google/routes.ts";
import { GoogleService } from "./google/service.ts";
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
import {
  ensureMcpServers,
  loadMcpServers,
  type McpIo,
  saveMcpServers,
  updateMcpServers,
} from "./mcp/service.ts";
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
import { registerPiRoutes } from "./pi/routes.ts";
import { PI_TOOL_NAMES, PI_TOOL_SPECS, PiService } from "./pi/service.ts";
import { registerProviderRoutes } from "./providers/routes.ts";
import { ProviderSight } from "./providers/sight.ts";
import { ModelCapsStore } from "./providers/store.ts";
import {
  buildProviderModGroups,
  PROVIDERS_MOD_PATH,
  parseRegisteredProviderIds,
  parseVisionProviders,
  renderProvidersMod,
} from "./providers/vision.ts";
import { AgentNames } from "./push/agent-names.ts";
import { ApprovalWatcher } from "./push/approval-watcher.ts";
import { notify } from "./push/notify.ts";
import { registerPushRoutes } from "./push/routes.ts";
import { configureWebPush } from "./push/send.ts";
import { PushSubscriptionStore } from "./push/store.ts";
import { TurnOutcomeWatcher } from "./push/turn-watcher.ts";
import { hardenedResponse, securityHeaders } from "./security-headers.ts";
import { scopeKeyOf } from "./session/buffer.ts";
import {
  accounting,
  agentModelHandle,
  ContextSizer,
  ContextSizeStore,
  contextBudget,
  handSetWindow,
} from "./session/context-size.ts";
import { ContextWatchdog, effectiveContextLimit } from "./session/context-watchdog.ts";
import { WORKSPACE_ROOT, workspaceViolation } from "./session/protocol.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { symlinkViolation } from "./session/symlink-guard.ts";
import { TurnErrorLog } from "./session/turn-errors.ts";
import { JsonUsageDisk, TurnUsageLog } from "./session/turn-usage.ts";
import { drainActiveTurns } from "./shutdown.ts";
import { hostSkillFs, upstreamSkillFs } from "./skills/fs.ts";
import { InvalidSkillScopeError, SkillCatalog } from "./skills/service.ts";
import { UpstreamConnection } from "./upstream/connection.ts";
import { readUiVersion } from "./version.ts";
import { ddgCaller } from "./web-tools/ddg.ts";
import { loadWebToolsSettings, retireSeededDdgMcp } from "./web-tools/install.ts";
import { renderWebToolsMod, WEB_TOOLS_MOD_PATH } from "./web-tools/mod.ts";
import { registerWebToolsRoutes } from "./web-tools/routes.ts";
import { fetchWebpage, type WebToolsBackends, webSearch } from "./web-tools/service.ts";

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
// A subagent's own id is in no stored entry, so what it may start is decided by
// its ancestors too — letta-code tags every spawned subagent `parent:<id>`.
// Both ports ask about the same agents, so they share one retrieval.
const agentFacts = new AgentFacts(async (agentId) => {
  const response = await upstream.request<AgentRetrieveResponseMessage>(
    { type: "agent_retrieve", request_id: `bff-agent-${randomUUID()}`, agent_id: agentId },
    10_000,
  );
  return response.success
    ? { name: response.agent?.name ?? null, tags: response.agent?.tags ?? [] }
    : { name: null, tags: [] };
});
const agentAncestry = new AgentAncestry(async (agentId) => (await agentFacts.get(agentId)).tags);
const workerAccessFor = async (agentId: string) =>
  inheritAccess(await agentAncestry.chain(agentId), (id) => agentToolAccess.get(id));
// Push titles name the agent. Looked up through the permanent connection and
// cached; a failed lookup falls back to "Lettuce" rather than delaying the push.
const agentNames = new AgentNames(async (agentId) => (await agentFacts.get(agentId)).name);
const turnOutcomeWatcher = pushStore ? new TurnOutcomeWatcher(pushStore, log, agentNames) : null;
const approvalWatcher = pushStore ? new ApprovalWatcher(pushStore, log, agentNames) : null;
const turnErrors = new TurnErrorLog();
const turnUsage = new TurnUsageLog(
  () => new Date(),
  new JsonUsageDisk(config.contextUsageFile, (error) =>
    log(`context usage file not saved: ${errorMessage(error)}`),
  ),
);
/** Set just below, once the connection it needs exists. */
let contextWatchdog: ContextWatchdog | null = null;

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
    contextWatchdog?.observe(frame);
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
      // Last of the connect passes: it reads the agents as they now are and
      // writes each one's context window. Off the critical path on purpose — the
      // caps it works from come from this process's own store, not from the mod,
      // so nothing waits on it.
      void contextSizer
        .applyAll()
        .then((summary) => log(summary))
        .catch((error) => log(`context sizing: ${errorMessage(error)}`));
    }
  },
  log,
});

const registry = new SessionRegistry(upstream, config.frameBufferSize, log);

// Compacts a conversation the app-server's own pressure trigger cannot save —
// see `session/context-watchdog.ts` for why the declared window is not enough.
contextWatchdog = new ContextWatchdog({
  ratio: config.contextWatchdogRatio,
  usage: turnUsage,
  upstream,
  log,
});

// Context sizes the operator typed, and the window they imply for letta-code.
// Everything the Context sheet shows about compaction comes from this pair —
// see `session/context-size.ts` for why the window is derived rather than typed.
const contextSizes = new ContextSizeStore(config.contextSizeFile, (error) =>
  log(`context size file not saved: ${errorMessage(error)}`),
);
const contextSizer = new ContextSizer(
  { upstream, caps: () => modelCaps.models(), log },
  contextSizes,
);

/**
 * The model in force for a scope, the way the model picker resolves it: the
 * conversation's own override first, then the agent's.
 */
function modelHandleFrom(
  conversation: ConversationRetrieveResponseMessage | null,
  agent: unknown,
): string | null {
  const model = conversation?.conversation?.model;
  if (typeof model === "string" && model) return model;
  return agentModelHandle(agent);
}

/** Same, for a caller holding nothing but the ids. */
async function modelHandleFor(
  agentId: string,
  conversationId: string | null,
): Promise<string | null> {
  let conversation: ConversationRetrieveResponseMessage | null = null;
  if (conversationId && conversationId !== "default") {
    conversation = await upstream
      .request<ConversationRetrieveResponseMessage>(
        {
          type: "conversation_retrieve",
          request_id: `bff-sizer-conv-${randomUUID()}`,
          conversation_id: conversationId,
        },
        10_000,
      )
      .catch(() => null);
  }
  const agent = await upstream.request<AgentRetrieveResponseMessage>(
    { type: "agent_retrieve", request_id: `bff-sizer-agent-${randomUUID()}`, agent_id: agentId },
    10_000,
  );
  return modelHandleFrom(conversation, agent.success ? (agent.agent ?? null) : null);
}

// Skills this repo ships to every agent (docker/agent-skills), installed into
// the app-server's global skills directory on each connect — see
// `agent-skills.ts` for why this is not a bind mount. The files travel in the
// bff image at the same relative path as in the repo, so dev works unchanged.
const agentSkillsDir =
  process.env.AGENT_SKILLS_DIR ?? new URL("../../docker/agent-skills", import.meta.url).pathname;
/**
 * What this process has already written, keyed by path and content. A reconnect
 * to an app-server that never stopped does not need every skill file again, and
 * a reconnect pass is exactly when a turn is waiting. A state directory replaced
 * under a running BFF is re-synced on the BFF's next restart — the same restart
 * that drops this record.
 */
const shippedSkillsWritten = new Set<string>();
async function installShippedSkills(): Promise<void> {
  await installAgentSkills(
    readSkillTree(agentSkillsDir),
    async (path, content) => {
      const written = `${path}|${createHash("sha256").update(content).digest("base64url")}`;
      if (shippedSkillsWritten.has(written)) return;
      const response = await upstream.request<WriteFileResponseMessage>({
        type: "write_file",
        path,
        content,
        request_id: `bff-skill-${randomUUID()}`,
      });
      if (response?.success !== true) throw new Error(response?.error ?? "write_file failed");
      shippedSkillsWritten.add(written);
    },
    log,
  );
}

/**
 * One app-server file command, decided the same way everywhere: the payload when
 * it answered, `null` when the path is simply not there, and a thrown error
 * quoting what the app-server said for anything else.
 *
 * A missing path is the normal state of a fresh install — no settings file has
 * been written yet — so it is not a failure, and the rule belongs in one place:
 * a call site that gets it wrong turns a first boot into a 502, which is the kind
 * of bug only a new install ever sees.
 */
async function fileCommand<T extends ReadFileResponseMessage | ListInDirectoryResponseMessage, R>(
  command: { type: string; request_id: string } & Record<string, unknown>,
  // `null` from the payload means "answered, nothing there", which is the same
  // answer as an absent path.
  payload: (response: T) => R | null,
  what: string,
): Promise<R | null> {
  const response = await upstream.request<T>(command);
  if (response.success) return payload(response);
  if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
  throw new Error(response.error ?? `Could not ${what}`);
}

// Codex workers' files, reached through the app-server like every other file
// the BFF touches — see `codex/settings.ts`. Only these routes use it, never a
// browser: `/root/.letta` is outside the workspace clamp on purpose.
const codexIo: CodexFileIo = {
  async read(path) {
    return fileCommand<ReadFileResponseMessage, string>(
      {
        type: "read_file",
        path,
        encoding: "utf8",
        request_id: `bff-codex-read-${randomUUID()}`,
      },
      (response) => (typeof response.content === "string" ? response.content : null),
      `read ${path}`,
    );
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
    return fileCommand<ListInDirectoryResponseMessage, string[]>(
      {
        type: "list_in_directory",
        path: dir,
        include_files: true,
        request_id: `bff-codex-list-${randomUUID()}`,
      },
      (response) => response.files ?? [],
      `list ${dir}`,
    );
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
let codingMarker: CodingMarker | null = null;

async function checkCodingMarker(): Promise<void> {
  const text = await readRenamed(codexIo, CODING_MARKER_PATH, CODING_MARKER_LEGACY_PATH);
  if (text === null) {
    log(
      `Coding CLIs: the app-server image predates the install marker (${CODING_MARKER_PATH}); ` +
        `nothing can be verified against it — rebuild app-server to change what is installed.`,
    );
    return;
  }
  codingMarker = parseCodingMarker(text);
  for (const [name, on] of [
    ["codex", config.features.codex],
    ["claude", config.features.claude],
  ] as const) {
    if (on && !codingMarker.names.includes(name)) {
      log(
        `! ${name} is enabled by COMPOSE_PROFILES but is not installed in the app-server image — ` +
          `rebuild it: docker compose -f docker/compose.yml build app-server && … up -d`,
      );
    }
  }
}

/** Settings → About's version list — see `deployment.ts` for where each comes from. */
function deploymentRows(): Component[] {
  return deploymentComponents({
    features: config.features,
    tunnel: config.mode === "cloudflared",
    pinVersions: config.pinVersions,
    webReader: config.webTools.ddgMcpUrl !== null,
    marker: codingMarker,
    lettaCodeVersion: upstream.getInfo()?.letta_code_version ?? null,
  });
}

// Claude Code workers' files, over the same channel as Codex's — plus the
// folder half of `list_in_directory`, which is how `claude/` finds the project
// directories under `projects/`. See `claude/service.ts`.
const claudeIo: ClaudeFileIo = {
  ...codexIo,
  async listDirs(dir) {
    return fileCommand<ListInDirectoryResponseMessage, string[]>(
      {
        type: "list_in_directory",
        path: dir,
        include_files: true,
        request_id: `bff-claude-list-dirs-${randomUUID()}`,
      },
      (response) => response.folders ?? [],
      `list ${dir}`,
    );
  },
};

// Settings → Skills (see `skills/`). Bundled skills are in the app-server image,
// so they come over the connection; every other root is read from the BFF's
// read-only mounts, because the protocol's listings skip symlinks.
const skillCatalog = new SkillCatalog(
  hostSkillFs,
  upstreamSkillFs({
    async list(dir) {
      return fileCommand<ListInDirectoryResponseMessage, { folders: string[]; files: string[] }>(
        {
          type: "list_in_directory",
          path: dir,
          include_files: true,
          request_id: `bff-skills-list-${randomUUID()}`,
        },
        (response) => ({ folders: response.folders ?? [], files: response.files ?? [] }),
        `list ${dir}`,
      );
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
  // Settle pushes: a finished remote run is exactly what a waiting human wants
  // without an agent turn relaying it. Deep link lands on the Runs tab once
  // that view ships; unknown query params are inert before then. And the
  // dispatching conversation gets the same news as a <task-notification>, so
  // the agent learns by event instead of a pi_wait/pi_status poll loop.
  onSettle: (meta) => {
    const verdict =
      meta.state === "completed" || meta.state === "failed" || meta.state === "cancelled"
        ? meta.state
        : null;
    if (!verdict) return;
    if (pushStore)
      void notify(
        pushStore,
        {
          title: `Remote pi ${verdict}`,
          body: meta.prompt.split("\n")[0]?.slice(0, 90) ?? meta.runId,
          url: `/?tab=runs&run=${encodeURIComponent(meta.runId)}`,
        },
        verdict === "failed" ? "failed" : "completed",
        log,
      );
    if (meta.agentId && meta.conversationId) {
      void piService
        .settleReport(meta)
        .then((content) =>
          // `sendInternal`, not `send`: the app-server answers any `input` that
          // carries a request_id with `input_accepted`, and unless the id is
          // registered as BFF-internal that answer is treated as an
          // unsolicited frame — sequenced, buffered, and relayed to every tab
          // watching the conversation with a request id nobody issued.
          upstream.sendInternal({
            type: "input",
            request_id: crypto.randomUUID(),
            runtime: { agent_id: meta.agentId, conversation_id: meta.conversationId },
            payload: { kind: "create_message", messages: [{ role: "user", content }] },
          }),
        )
        .catch((error) => log(`Remote pi: settle report failed: ${errorMessage(error)}`));
    }
  },
});
void piService
  .reconcile()
  .catch((error) => log(`Remote pi: reconcile failed: ${errorMessage(error)}`));
// Run captures only grow; sweep at boot and every 6 h (A8: newest 300 kept,
// anything older than 14 days goes).
setInterval(
  () =>
    void piService
      .retentionSweep()
      .catch((error) => log(`Remote pi: retention sweep failed: ${errorMessage(error)}`)),
  6 * 3_600_000,
).unref?.();
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
  // Three files over the connection, none of them waiting on another. A mod sync
  // runs on connect, after every settings save and on a model-list change, so
  // the two round-trips spent reading them in series were paid on every one.
  const [web, pi, currentProvidersMod] = await Promise.all([
    loadWebToolsSettings(codexIo),
    piService.load(),
    codexIo.read(PROVIDERS_MOD_PATH).catch(() => null),
  ]);
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
        accessBase: `http://127.0.0.1:${config.port}`,
      }),
    },
  ];
  // The remote pi worker: the stored switch counts only when the `pi`
  // profile token is on, and Agent → Tools access hides the pi tools from a
  // blocked agent's turn the same way Google tools are hidden.
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
  const providerGroups = buildProviderModGroups({
    models: modelCaps.models(),
    endpoints: modelCaps.endpoints(),
    served: providerSight.servedSnapshot(),
    baseUrlOf: (prefix) => providerSight.baseUrlFor(prefix),
    isLive: (prefix) => providerSight.isConnected(prefix),
    alreadyRegistered: parseRegisteredProviderIds(currentProvidersMod),
    retired: modelCaps.retired(),
  });
  if (providerGroups) {
    providersMirrorAttempts = 0;
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
/**
 * How long either retry keeps trying before it stops: ten minutes of 30-second
 * attempts. Both wait on something outside this process (an agent to carry a
 * `reload`, an endpoint to report its model list), and a retry that never gives
 * up is background traffic plus a failing log line forever.
 */
const RETRY_MAX_ATTEMPTS = 20;
const RETRY_INTERVAL_MS = 30_000;
let providersMirrorAttempts = 0;

function scheduleProvidersMirrorRetry(): void {
  if (providersMirrorRetry) return;
  if (providersMirrorAttempts >= RETRY_MAX_ATTEMPTS) {
    log(
      `Providers: the served-model mirror never filled after ${RETRY_MAX_ATTEMPTS} attempts — ` +
        "the providers mod keeps the models it has. It is retried on the next connection.",
    );
    providersMirrorAttempts = 0;
    return;
  }
  providersMirrorAttempts += 1;
  providersMirrorRetry = setTimeout(() => {
    providersMirrorRetry = null;
    void resyncMods("providers mirror retry", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => {});
  }, RETRY_INTERVAL_MS);
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
  let attempts = 0;
  modsReloadRetry = setInterval(() => {
    if (!upstream.isReady()) return;
    attempts += 1;
    if (attempts > RETRY_MAX_ATTEMPTS) {
      if (modsReloadRetry) clearInterval(modsReloadRetry);
      modsReloadRetry = null;
      log(
        `Native tools: the mods reload never ran after ${RETRY_MAX_ATTEMPTS} attempts — ` +
          "it is retried on the next connection.",
      );
      return;
    }
    void modsIo
      .reloadMods()
      .then((done) => {
        if (!done || !modsReloadRetry) return;
        clearInterval(modsReloadRetry);
        modsReloadRetry = null;
        log("Native tools: mods reloaded");
      })
      .catch((error) => log(`Native tools: reload failed: ${errorMessage(error)}`));
  }, RETRY_INTERVAL_MS);
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

// The session gate for everything under `/api` and `/push`. Thirty-four handlers
// used to begin with the same hand-written check, which means a route that forgot
// it served agent data to an anonymous visitor and nothing — no test, no lint
// rule — would have noticed. Hono middleware only covers routes registered after
// it, so this sits above every route, including the `register*Routes` calls that
// mount their families where their handlers used to sit.
const ANONYMOUS_API_PATHS = new Set([
  // Renders a sign-in screen: it answers with `authenticated: false` by design.
  "/api/status",
  // An agent's link for a human to click; it redirects to Settings when signed out.
  "/api/google/reconnect",
  // Google's redirect back. No cookie rides along on another origin, and the
  // single-use `state` minted by the gated /connect is what authorises it.
  "/api/google/oauth/callback",
]);
const requireSession = async (c: Context, next: () => Promise<void>) => {
  if (!c.get("session") && !ANONYMOUS_API_PATHS.has(c.req.path)) {
    return c.text("Unauthorized", 401);
  }
  return next();
};
app.use("/api/*", requireSession);
app.use("/push/*", requireSession);

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
    coding_installed: codingMarker?.names ?? null,
    // Settings → About's version list; see `deployment.ts`.
    components: deploymentRows(),
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
  return hardenedResponse(hardened, null, { location: "/", "set-cookie": cookie }, 302);
});

app.post("/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie(secureCookies));
  return c.json({ ok: true });
});

registerPushRoutes(app, {
  store: pushStore,
  vapidPublicKey: config.push?.vapidPublicKey ?? null,
  log,
});

// ── MCP servers ─────────────────────────────────────────────────────────────
// One shared list for every agent, in a settings file only the BFF writes and
// only `letta mcp` (run from agent shells with HOME pointed at it) reads — see
// `mcp/settings.ts` for why upstream's per-agent settings.json cannot hold it.
// The browser never gets a write handle on it: an MCP entry is a command line
// that agent shells will exec.

app.get("/api/mcp", async (c) => {
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  try {
    return c.json({ servers: await loadMcpServers(mcpIo) });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/mcp", async (c) => {
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
  return c.json({ pinned: agentPins.list(), archived: agentArchive.list() });
});

// Archiving also unpins: a hidden agent has no business leading the list.
app.put("/api/agents/archived/:agentId", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { archived?: unknown } | null;
  if (typeof body?.archived !== "boolean") return c.text("Body must be { archived: boolean }", 400);
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  const archived = agentArchive.set(agentId, body.archived);
  const pinned = body.archived ? agentPins.set(agentId, false) : agentPins.list();
  return c.json({ pinned, archived });
});

app.get("/api/agents/pins", (c) => {
  return c.json({ pinned: agentPins.list() });
});

app.put("/api/agents/pins/:agentId", async (c) => {
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
  const agentId = c.req.param("agentId");
  if (!isAgentId(agentId)) return c.text("Not an agent id", 400);
  return c.json(agentToolAccess.get(agentId));
});

app.put("/api/agents/tool-access/:agentId", async (c) => {
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

registerCodexRoutes(app, {
  isReady: () => upstream.isReady(),
  codexEnabled: config.features.codex,
  io: codexIo,
});

// Settings → Web: the native web tools' switch, backend status and a test
// search — all of it in `web-tools/routes.ts`.
registerWebToolsRoutes(app, {
  isReady: () => upstream.isReady(),
  searchEnabled: config.features.web,
  io: codexIo,
  resyncMods,
  backends: webToolsBackends,
  searxngUrl: config.webTools.searxngUrl,
  ddgMcpUrl: config.webTools.ddgMcpUrl,
});

// Settings → Providers & models: the providers the operator added and what they
// declared about each model. Both live in one store and both drive the providers
// mod; the routes are in `providers/routes.ts`.
registerProviderRoutes(app, {
  isReady: () => upstream.isReady(),
  modelCaps,
  providerSight,
  contextSizer,
  resyncMods,
});

// The Context sheet's numbers: the context size in force (typed or declared),
// what the model promises per reply, and where the conversation therefore
// compacts. Reading it also sizes the agent, which is how an agent created after
// the last connect gets a window that matches its model. GET answers with the
// values as they are; PUT stores a typed size and writes the window it implies.
app.get("/api/context-size", async (c) => {
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.text("agent_id is required", 400);
  const conversationId = c.req.query("conversation_id") || null;
  try {
    const retrieve = () =>
      Promise.all([
        upstream.request<AgentRetrieveResponseMessage>(
          {
            type: "agent_retrieve",
            request_id: `bff-size-agent-${randomUUID()}`,
            agent_id: agentId,
          },
          10_000,
        ),
        conversationId && conversationId !== "default"
          ? upstream.request<ConversationRetrieveResponseMessage>(
              {
                type: "conversation_retrieve",
                request_id: `bff-size-conv-${randomUUID()}`,
                conversation_id: conversationId,
              },
              10_000,
            )
          : Promise.resolve(null),
      ]);
    let [agent, conversation] = await retrieve();
    // Retune before answering: an agent whose window disagrees with its model's
    // declaration is retuned here, once. The agent just fetched is passed in, so
    // this costs nothing extra; only the rare case that actually wrote a window (a
    // newly created agent) is worth reading it back, and it is read back so the
    // number shown is the number just written.
    const resized = await contextSizer
      .ensure(agentId, agent.success ? (agent.agent ?? null) : null)
      .catch(() => false);
    if (resized) [agent, conversation] = await retrieve();
    const handle = modelHandleFrom(conversation, agent.success ? (agent.agent ?? null) : null);
    const declared = contextSizer.capsFor(handle);
    const inForce = effectiveContextLimit(
      agent.success ? (agent.agent ?? null) : null,
      conversation?.conversation ?? null,
    );
    // A conversation carrying its own window was sized by hand before this kept
    // any record of it — the agent's own window was just adopted by `ensure`. Do
    // the same here, or the sheet shows the declaration over the number that is
    // really in force for this conversation.
    const conv = (conversation?.conversation ?? {}) as { context_window_limit?: unknown };
    const convWindow =
      typeof conv.context_window_limit === "number" && conv.context_window_limit > 0
        ? conv.context_window_limit
        : null;
    if (
      conversationId &&
      convWindow !== null &&
      contextSizes.get(`conv:${conversationId}`) === null &&
      handSetWindow(convWindow, declared)
    ) {
      contextSizes.set(`conv:${conversationId}`, convWindow);
    }
    return c.json(
      accounting({
        limit: inForce,
        typedAgent: contextSizes.get(`agent:${agentId}`),
        typedConversation: conversationId ? contextSizes.get(`conv:${conversationId}`) : null,
        declared,
      }),
    );
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

// The same floor the sheet enforces: a window below this cannot hold a system
// prompt, a tool schema and a summary, whatever the server claims (`use-context-limit.ts`).
const MIN_CONTEXT_SIZE = 30_000;

app.put("/api/context-size", async (c) => {
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = (await c.req.json().catch(() => null)) as {
    agent_id?: unknown;
    conversation_id?: unknown;
    scope?: unknown;
    tokens?: unknown;
  } | null;
  const agentId = typeof body?.agent_id === "string" ? body.agent_id : null;
  if (!agentId) return c.text("agent_id is required", 400);
  const conversationId = typeof body?.conversation_id === "string" ? body.conversation_id : null;
  const scope =
    body?.scope === "conversation" && conversationId
      ? ({ kind: "conversation", agentId, conversationId } as const)
      : ({ kind: "agent", agentId } as const);
  const tokens = body?.tokens === null || body?.tokens === undefined ? null : Number(body.tokens);
  if (tokens !== null && (!Number.isFinite(tokens) || tokens < MIN_CONTEXT_SIZE)) {
    return c.text(`A context size is at least ${MIN_CONTEXT_SIZE.toLocaleString()} tokens`, 400);
  }
  try {
    const handle = await modelHandleFor(
      agentId,
      scope.kind === "conversation" ? conversationId : null,
    );
    // A size that cannot hold the model's own output leaves nothing to compact
    // into: the window it implies is the size itself and every request is then
    // refused, so refuse the size instead of storing it.
    if (tokens !== null) {
      const maxOutput = contextSizer.capsFor(handle)?.maxTokens ?? null;
      const budget = contextBudget(maxOutput);
      if (tokens <= budget) {
        return c.text(
          maxOutput === null
            ? `A context size is at least ${budget.toLocaleString()} tokens`
            : `A context size must be more than ${budget.toLocaleString()} tokens: the ${maxOutput.toLocaleString()}-token output has to fit inside it, with room for the summary`,
          400,
        );
      }
    }
    const output = await contextSizer.setSize(scope, tokens, handle);
    return c.json({ output });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

// What agents currently have as native tools from the MCP side: the curated
// Google tools the grant allows, and which servers the bridge reaches.
app.get("/api/native-tools", async (c) => {
  // Gated like its siblings: the catalog is a cache, and an empty one after a
  // BFF restart reads as "no MCP servers configured" unless the answer says
  // the app-server is not connected yet.
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const { tools, failures } = mcpCatalog.snapshot();
  const servers = [...new Set(tools.map((t) => t.server.name))];
  return c.json({
    google: availableGoogleTools(tools, config.google.mcpUrl).specs.map((s) => s.name),
    bridge: { servers, tools: tools.length, failures: Object.fromEntries(failures) },
  });
});

// ── Claude Code workers ─────────────────────────────────────────────────────
// Settings → Claude Code, and the run viewer. See `claude/` for what the files
// are; the io plumbing is the same `codexIo` — one app-server file channel.

registerClaudeRoutes(app, {
  isReady: () => upstream.isReady(),
  claudeEnabled: config.features.claude,
  io: claudeIo,
});

// ── Remote pi worker ─────────────────────────────────────────────────────
// Everything here is BFF-local: settings and keys on `bff-data`, runs captured
// from the BFF's own ssh spawns. No upstream file channel, no app-server
// involved — so `pi/routes.ts` holds the handlers and takes the service,
// the profile token and the mod resync as arguments. See docs/remote-pi-plan.md.
registerPiRoutes(app, {
  piService,
  piEnabled: config.features.pi,
  resyncMods,
  hardened,
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
  // Inside the queue, so a Google change landing next to a Settings → MCP save
  // adds to the list as it is afterwards rather than as it was when this began.
  const wrote = await updateMcpServers(mcpIo, (servers) => {
    const listed = servers.some((server) => server.url === config.google.mcpUrl);
    if (serving === listed) return servers;
    return serving
      ? [...servers, { name: "google", transport: "http", url: config.google.mcpUrl }]
      : servers.filter((server) => server.url !== config.google.mcpUrl);
  });
  if (wrote) log(`Google: ${serving ? "added to" : "removed from"} the shared MCP list`);
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

registerGoogleRoutes(app, {
  googleService,
  profileEnabled: config.features.google,
  writesAllowed: googleWritesAllowed(config),
  mcpUrl: config.google.mcpUrl,
  redirectUri: config.google.redirectUri,
  publicOrigin: config.publicOrigin,
  hardened,
});

// Failed turns for one conversation, which the transcript cannot reload on its
// own: the app-server never stores them. See `session/turn-errors.ts`.
app.get("/api/turn-errors", (c) => {
  const agentId = c.req.query("agent_id");
  const conversationId = c.req.query("conversation_id");
  if (!agentId || !conversationId) return c.text("Missing agent_id or conversation_id", 400);
  return c.json({ errors: turnErrors.list(scopeKeyOf(agentId, conversationId)) });
});

// Token usage of the last turn and the one in flight, per conversation, so
// every device shows the same gauge. See `session/turn-usage.ts`.
app.get("/api/turn-usage", (c) => {
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
// How much of a file `/api/files/download` will hold, and how many of them at
// once. Upstream answers `read_file` in base64 (it caps the raw file at 25 MB),
// and the response is held twice here — the base64 text and the decoded bytes —
// so one 25 MB download is ~60 MB of heap. Nothing else bounds how many run at
// the same time, and this is the process holding the only upstream connection:
// an OOM here cancels every turn in flight, with no drain to save them.
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOADS_IN_FLIGHT = 4;
let downloadsInFlight = 0;

app.get("/api/files/download", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.text("Missing path", 400);

  const violation = workspaceViolation({ type: "read_file", path });
  if (violation) return c.text(violation, 400);

  // Same reason as the WS path: a symlink under /work resolves outside it and
  // the app-server follows it without resolving.
  const symlink = symlinkViolation(path, WORKSPACE_ROOT);
  if (symlink) return c.text(symlink, 400);

  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  if (downloadsInFlight >= MAX_DOWNLOADS_IN_FLIGHT) {
    return c.text("Too many downloads at once", 503);
  }
  downloadsInFlight += 1;
  try {
    return await readWorkspaceFile(path, c.req.query("inline") != null);
  } finally {
    downloadsInFlight -= 1;
  }
});

/** One workspace file, read through the app-server and turned into a download. */
async function readWorkspaceFile(path: string, inline: boolean): Promise<Response> {
  let response: ReadFileResponseMessage;
  try {
    response = await upstream.request<ReadFileResponseMessage>({
      type: "read_file",
      path,
      request_id: `bff-download-${randomUUID()}`,
      encoding: "base64",
    });
  } catch (error) {
    return hardenedResponse(hardened, errorMessage(error), {}, 502);
  }

  if (!response.success || typeof response.content !== "string") {
    return hardenedResponse(hardened, response.error ?? "Failed to read file", {}, 404);
  }

  // Four base64 characters per three raw bytes. Checked before decoding, so an
  // oversized file costs the base64 text only, never the second copy.
  if ((response.content.length >> 2) * 3 > MAX_DOWNLOAD_BYTES) {
    return hardenedResponse(
      hardened,
      `File is too large to download (${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB max)`,
      {},
      413,
    );
  }

  // A Buffer IS a Uint8Array, so it goes straight to Response. Wrapping it in
  // `new Uint8Array(bytes)` would copy the whole decoded file again for no
  // reason — and this route already holds the base64 string from upstream plus
  // the decoded bytes.
  const bytes = Buffer.from(response.content, "base64");
  const filename = path.split("/").pop() || "download";
  // `?inline=1` (chat-message links) asks for a viewable response; only PDFs
  // and raster images actually get one — see `inlineContentType`.
  const inlineType = inline ? inlineContentType(filename) : null;
  return hardenedResponse(hardened, bytes, {
    "content-type": inlineType ?? "application/octet-stream",
    "content-disposition": contentDisposition(filename, inlineType ? "inline" : "attachment"),
    "content-length": String(bytes.length),
  });
}

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

// An unknown path under the API namespaces is a mistake, not a client-side
// route. Without these the fallback below answered `/api/typo` with 200 + the
// HTML shell, so the browser client's `.json()` failed on `<` instead of
// reporting a missing endpoint, and anything asserting a status code got a false
// pass. Registered here (Hono matches in order) so every real route above wins.
app.all("/api/*", (c) => c.text("Not found", 404));
app.all("/push/*", (c) => c.text("Not found", 404));

// Cache policy for the build, wrapping only the two static routes below. Every
// name Vite emits under `/assets/` carries a content hash, so those bytes never
// change and `immutable` for a year is honest; the shell, the service worker and
// the manifest must be revalidated every visit or an update never lands. Bun's
// file response carries no cache header at all, which is why a fresh install
// refetched the whole bundle on every open.
app.use("*", async (c, next) => {
  await next();
  c.header(
    "cache-control",
    c.req.path.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache, no-store, must-revalidate",
  );
});

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
        return hardenedResponse(hardened, "Forbidden origin", {}, 403);
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
      return hardenedResponse(hardened, "WebSocket upgrade failed", {}, 400);
    }

    // The web-tools mod's calls: loopback only, before Hono's session layer.
    const internal = await handleInternalTools(
      request,
      bunServer.requestIP(request)?.address,
      () => toolHandlers,
      workerAccessFor,
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
