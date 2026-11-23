import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";

/**
 * The small envelope the BFF adds on top of the app-server protocol for
 * browser sessions. Everything else on the wire is a verbatim app-server frame,
 * so the SPA can drive it with the same `AppServerClient` the BFF uses upstream.
 */

/** Attached by the BFF to every unsolicited frame, for exact resume. */
export const SEQ_FIELD = "__seq" as const;

export interface BffHelloMessage {
  type: "__bff_hello";
  session_id: string;
  user: { email: string };
  upstream: "connecting" | "connected" | "disconnected";
  app_server_info: AppServerInfoResponseMessage | null;
  latest_seq: number;
  /** Conversations with a response in progress right now; see `BffActivityMessage`. */
  active: { agent_id: string; conversation_id: string }[];
}

export interface BffResumeCommand {
  type: "__bff_resume";
  /** Last `__seq` the client rendered, or null on a cold start. */
  from_seq: number | null;
  /** Scopes to replay; omitted replays everything the buffer holds. */
  scopes?: { agent_id: string; conversation_id: string }[];
}

/**
 * What this session currently has on screen. Push suppression reads exactly
 * this and nothing else (`SessionRegistry.isScopeWatched`).
 *
 * It cannot be inferred from the socket: a backgrounded desktop tab keeps its
 * WebSocket open indefinitely, so "connected" said nothing about whether anyone
 * was looking — and every push was suppressed, on every device, for as long as
 * a tab stayed open anywhere.
 */
export interface BffWatchingCommand {
  type: "__bff_watching";
  /** The conversation on screen, or null when none is. */
  scope: { agent_id: string; conversation_id: string } | null;
  /** `document.visibilityState === "visible"` at the moment this was sent. */
  visible: boolean;
  /**
   * Whether this session wants remote-pi progress frames (`__bff_pi_progress`).
   * Set once the app knows the `pi` feature is on; absent means false, so an
   * old client never receives frames it cannot parse.
   */
  pi?: boolean;
}

export interface BffResumeResultMessage {
  type: "__bff_resume_result";
  from_seq: number | null;
  latest_seq: number;
  replayed: number;
  /** Client must rebuild from conversation_messages_list. */
  resync_required: boolean;
}

export interface BffUpstreamStateMessage {
  type: "__bff_upstream_state";
  state: "connecting" | "connected" | "disconnected";
  app_server_info: AppServerInfoResponseMessage | null;
}

/**
 * Every conversation with an agent response in progress, app-server wide.
 * Sent to every session regardless of its scopes, whenever the set changes
 * (`session/activity.ts`). A full snapshot, never a delta.
 */
export interface BffActivityMessage {
  type: "__bff_activity";
  active: { agent_id: string; conversation_id: string }[];
}

export interface BffErrorMessage {
  type: "__bff_error";
  message: string;
  request_id?: string;
  /**
   * Whether the refused command can be sent again without asking whether the first one landed.
   *
   * `not_sent` means the frame demonstrably never reached the app-server, so nothing changed and a resend
   * is free. `delivery_uncertain` means it was written to the upstream socket and the socket died before
   * anything answered, so it may have been applied — the UI says so rather than reporting a clean failure.
   * Absent means an ordinary refusal (a rate limit, a bad path), where neither claim is being made.
   */
  code?: "not_sent" | "delivery_uncertain";
}

/**
 * One remote-pi run's current facts, pushed to pi-watching sessions instead
 * of being polled (`PiService.progressFacts`). The payload is assembled by
 * the pi service, so the registry carries it opaquely.
 */
export interface BffPiProgressMessage {
  type: "__bff_pi_progress";
  [key: string]: unknown;
}

export type BffServerMessage =
  | BffHelloMessage
  | BffResumeResultMessage
  | BffUpstreamStateMessage
  | BffActivityMessage
  | BffPiProgressMessage
  | BffErrorMessage;

export function isBffResumeCommand(value: unknown): value is BffResumeCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; from_seq?: unknown };
  return (
    candidate.type === "__bff_resume" &&
    (candidate.from_seq === null || typeof candidate.from_seq === "number")
  );
}

export function isBffWatchingCommand(value: unknown): value is BffWatchingCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; visible?: unknown; scope?: unknown; pi?: unknown };
  if (candidate.type !== "__bff_watching" || typeof candidate.visible !== "boolean") return false;
  if (candidate.pi !== undefined && typeof candidate.pi !== "boolean") return false;
  // An absent scope means "nothing on screen", same as an explicit null.
  if (candidate.scope === null || candidate.scope === undefined) return true;
  if (typeof candidate.scope !== "object") return false;
  const scope = candidate.scope as { agent_id?: unknown; conversation_id?: unknown };
  return typeof scope.agent_id === "string" && typeof scope.conversation_id === "string";
}

/**
 * Command types a browser session may send upstream.
 *
 * Deliberately an allowlist: the app-server exposes process-level surface
 * (terminals, arbitrary shell via execute_command, secrets) that should only be
 * reachable through screens we have actually built.
 */
export const ALLOWED_SESSION_COMMANDS: ReadonlySet<string> = new Set([
  // discovery + lifecycle
  "app_server_info",
  "runtime_start",
  "sync",
  "change_device_state",
  // conversation turns
  "input",
  "abort_message",
  "remove_queue_item",
  "resume_queue",
  "approval_response",
  // agents + conversations
  "agent_list",
  "agent_retrieve",
  "agent_create",
  "agent_update",
  "agent_delete",
  "create_agent",
  "conversation_list",
  "conversation_retrieve",
  "conversation_create",
  "conversation_update",
  "conversation_messages_list",
  "conversation_compact",
  "conversation_fork",
  "conversation_recompile",
  // models + toolset
  "list_models",
  "update_model",
  "update_toolset",
  "list_connect_providers",
  "connect_provider",
  "disconnect_provider",
  // files
  "get_tree",
  "list_in_directory",
  "search_files",
  "grep_in_files",
  "read_file",
  "write_file",
  "edit_file",
  "watch_file",
  "unwatch_file",
  // memory
  "list_memory",
  "read_memory_file",
  "write_memory_file",
  "delete_memory_file",
  "memory_history",
  "memory_file_at_ref",
  "memory_commit_diff",
  "enable_memfs",
  // tasks
  "cron_list",
  "cron_add",
  "cron_get",
  "cron_runs",
  "cron_trigger",
  "cron_pause",
  "cron_resume",
  "cron_update",
  "cron_delete",
  // skills
  "skill_enable",
  "skill_disable",
  // agent secrets. Dedicated commands, not `execute_command "/secret"`: the
  // slash id has no handler case (see ALLOWED_EXECUTE_COMMAND_IDS below).
  // `secret_list` deliberately returns plaintext values — the modal needs them
  // to populate the form; the CLI's names-only path is a different code path.
  "secret_list",
  "secret_apply",
  // reflection configuration. `/dream` and `/reflect` fire through
  // execute_command; these read and write the settings behind them.
  "get_reflection_settings",
  "set_reflection_settings",
  // git branches. Both carry an optional `cwd`, registered in
  // FILE_PATH_FIELDS so the workspace clamp covers it.
  "search_branches",
  "checkout_branch",
  // working directory
  "get_cwd_map",
  "set_boot_working_directory",
  // background processes
  "monitor_stop",
  // Sideband subagent launch (letta-code 0.32.19). Runs beside the parent's
  // turn without taking its lease; the child reports back to the parent
  // conversation when it finishes. Answered within 25s upstream, inside the
  // browser's 30s request deadline.
  "launch_subagent",
  // Abort a running background subagent that the caller's own conversation spawned
  // (`{runtime: <parent scope>, agent_id: <child agent id>}`). Upstream refuses a task the parent
  // runtime does not own, so the parent scope stays the boundary. Since letta-code 0.34.16.
  "subagent_stop",
  // NOTE: channel_* commands are deliberately absent. The app-server only
  // dispatches them when a gateway registered `serviceCommandHandler`, which
  // happens over the CLI's stdio pipe to a child gateway process — never over
  // the app-server WebSocket. Sent from here they would hang with no response
  // rather than fail. Telegram is configured with `letta channels` inside the
  // gateway container; see CLAUDE.md.

  // slash commands. NOTE: the app-server does NOT enforce its own
  // SUPPORTED_REMOTE_COMMANDS on the inbound path — `isExecuteCommandCommand`
  // only checks that `command_id` is a string, and the constant is used purely
  // to advertise the list in DeviceStatus. An unknown id is answered with
  // `success: false` ("Unknown command"), not refused at the boundary.
  "execute_command",
]);

/**
 * `execute_command` ids a browser session may run.
 *
 * The app-server does NOT enforce its own `SUPPORTED_REMOTE_COMMANDS` on the
 * inbound path — `isExecuteCommandCommand` only checks that `command_id` is a
 * string, and the constant exists to advertise the list in `DeviceStatus`. An
 * unknown id is answered `success: false`, not refused at the boundary. So
 * admitting the command type at all means admitting every id the handler knows,
 * and one of those is not something a browser should ever be able to trigger:
 *
 * - `upgrade-letta-code` runs `manualUpdate()` and then
 *   `scheduleRemoteRestart()`, which spawns a replacement listener and calls
 *   `process.exit()` (letta-code `listener/commands.ts`). Against this stack
 *   that swaps the installed global out from under a pinned image, silently
 *   breaking the invariant `scripts/check-version-pin.ts` exists to hold, and
 *   restarts the process that owns every conversation's turn.
 * - `clear` / `clear-messages` were remote commands until letta-code 0.34.15,
 *   which removed them: the remote clear reassigned the conversation on a
 *   runtime whose key still addressed the old scope and poisoned the durable
 *   input ledger. They now answer "use /new", so admitting them would only let a
 *   browser fire a command that always fails. A new conversation is created
 *   client-side (`createConversation`), not by clearing one.
 * - `channels` needs a gateway attached over stdio; see CLAUDE.md.
 * - `secret` and `toolset` have no `execute_command` case at all — the UI's
 *   toolset picker uses `update_toolset`, and the Secrets screen uses the
 *   dedicated `secret_list`/`secret_apply` commands above. Neither slash id is
 *   reachable here, and neither needs to be.
 *
 * Everything listed here is a conversation-scoped operation the UI actually
 * offers. Mod-contributed commands are allowed too, but only ones the
 * app-server has actually advertised (see `advertisedModCommands` in
 * `registry.ts`), so the palette and the boundary cannot disagree.
 */
export const ALLOWED_EXECUTE_COMMAND_IDS: ReadonlySet<string> = new Set([
  "compact",
  "context-limit",
  "doctor",
  "init",
  "reload",
  "dream",
  "reflect",
  "reflection",
  "monitor_stop",
]);

/**
 * Why `command_id` must be refused, or null when it is allowed.
 *
 * Kept separate from `workspaceViolation` because the shape of the answer is
 * the same (a human-readable refusal) while the input is not: one inspects a
 * path field, the other an id against a set plus the observed mod list.
 */
export function executeCommandViolation(
  commandId: unknown,
  advertisedMods: ReadonlySet<string>,
): string | null {
  if (typeof commandId !== "string" || commandId === "") {
    return "execute_command.command_id must be a non-empty string";
  }
  if (ALLOWED_EXECUTE_COMMAND_IDS.has(commandId) || advertisedMods.has(commandId)) return null;
  return `Command "/${commandId}" is not permitted from a browser session`;
}

/**
 * The model-facing name of the async AskUserQuestion tool (letta-code 0.34.1,
 * internal `AskUserQuestionAsync`). It is in no default toolset — a client
 * that can render the question must opt in per message via
 * `client_preferences.toolset.include`, which upstream validates against its
 * bundled tool definitions and persists per conversation until replaced.
 */
export const WEB_ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * Opt every browser conversation into the async AskUserQuestion tool by
 * stamping `client_preferences` onto every create_message relay.
 *
 * Injected here rather than sent by the web app: the opt-in is a property of
 * what this BFF can render, not of whatever SPA version happens to be loaded,
 * and the stamp is idempotent — upstream replaces the conversation snapshot
 * with the same value on every message. Only browser-originated frames pass
 * through this relay; the BFF's own syncs and the scope sweep keep upstream's
 * inherit semantics untouched.
 */
export function withWebClientPreferences(
  command: Record<string, unknown> & { type: string },
): Record<string, unknown> {
  if (command.type !== "input") return command;
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return command;
  const kind = (payload as { kind?: unknown }).kind;
  if (kind !== "create_message") return command;
  if ((payload as { client_preferences?: unknown }).client_preferences !== undefined)
    return command;
  return {
    ...command,
    payload: {
      ...(payload as Record<string, unknown>),
      client_preferences: { toolset: { include: [WEB_ASK_USER_QUESTION_TOOL] } },
    },
  };
}

/**
 * Root every file operation is confined to.
 *
 * The app-server applies NO root of its own: `read_file` with
 * `/root/.letta/settings.json` or `write_file` into a cron directory both
 * succeed, and no `../` is needed to get there. The only guards upstream
 * (PROTECTED_HOME_NAMES, the $HOME grep short-circuit) are browsing
 * conveniences, explicitly documented as not being security boundaries. So the
 * confinement has to live here, next to the command allowlist and for the same
 * reason: the browser may only reach surfaces we actually built for it.
 *
 * `/work` is the bind mount from the host (see docker/compose.yml). Agents get
 * `/work/<agent-id>`; `/work` itself is the shared level above.
 */
export const WORKSPACE_ROOT = "/work";

/**
 * Path-bearing commands, and which field carries the path.
 *
 * The field name is not uniform: search_files and grep_in_files take `cwd`
 * (falling back to the server's process cwd when absent), skill_enable takes
 * `skill_path`, everything else takes `path`. A clamp keyed only on `path`
 * would leave those unguarded.
 *
 * `skill_enable` is here for the same reason the file commands are, and it is
 * the one that would hurt most: it symlinks whatever directory it is given into
 * `/root/.letta/skills`, from where the skill is loaded for every agent and its
 * `scripts/` earn their own scoped permission rules upstream
 * (`permissions/analyzer.ts`). Nothing legitimate is lost by the clamp —
 * `/work` is the only place either the browser or a sandboxed agent can put
 * files in the first place.
 */
export const FILE_PATH_FIELDS: ReadonlyMap<string, "path" | "cwd" | "skill_path"> = new Map([
  ["get_tree", "path"],
  ["list_in_directory", "path"],
  ["read_file", "path"],
  ["write_file", "path"],
  ["edit_file", "path"],
  ["watch_file", "path"],
  ["unwatch_file", "path"],
  ["search_files", "cwd"],
  ["grep_in_files", "cwd"],
  ["skill_enable", "skill_path"],
  // Both branch commands take an optional `cwd` that the app-server otherwise
  // resolves against its own process cwd. Unguarded, a browser could point git
  // at any path on the host. An absent `cwd` still passes through untouched —
  // compose anchors the server cwd inside the workspace.
  ["search_branches", "cwd"],
  ["checkout_branch", "cwd"],
]);

/**
 * Normalise a POSIX path, resolving `.` and `..` without touching the disk.
 * Exported for `git/routes.ts`, which applies the same clamp to an HTTP query
 * parameter instead of a WS command body.
 */
export function normalizePosixPath(input: string): string {
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * The reason this command must be refused, or null when it is allowed.
 *
 * A relative path is refused outright rather than resolved: the app-server
 * would interpret it against its own cwd, which is not something the browser
 * can see or reason about.
 */
export function workspaceViolation(
  command: Record<string, unknown> & { type: string },
): string | null {
  const field = FILE_PATH_FIELDS.get(command.type);
  if (!field) return null;

  const raw = command[field];
  // An absent path is left to the app-server. For `cwd` that is deliberate — it
  // means "the server's own cwd", which compose anchors inside the workspace —
  // and for the required fields it is simply the app-server's error to give.
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw === "") {
    return `${command.type}.${field} must be a non-empty string`;
  }
  if (!raw.startsWith("/")) {
    return `${command.type}.${field} must be an absolute path inside ${WORKSPACE_ROOT}`;
  }

  // No exceptions outside the workspace. `/root/.letta/settings.json` used to
  // be readable for the MCP editor; the shared MCP list now lives elsewhere
  // and is read and written only through `/api/mcp`.
  const resolved = normalizePosixPath(raw);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return `Path is outside the workspace: ${resolved} is not under ${WORKSPACE_ROOT}`;
  }
  return null;
}
