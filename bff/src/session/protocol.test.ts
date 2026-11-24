import { describe, expect, test } from "bun:test";
import {
  ALLOWED_SESSION_COMMANDS,
  executeCommandViolation,
  isBffWatchingCommand,
  WORKSPACE_ROOT,
  withWebClientPreferences,
  workspaceViolation,
} from "./protocol.ts";

/**
 * This command is the sole input to push suppression, and it arrives from a
 * browser — a malformed one must never be mistaken for "somebody is watching".
 */
describe("__bff_watching", () => {
  const scope = { agent_id: "agent-1", conversation_id: "conv-1" };

  test("accepts a scope, an explicit null, and an absent one", () => {
    expect(isBffWatchingCommand({ type: "__bff_watching", visible: true, scope })).toBe(true);
    expect(isBffWatchingCommand({ type: "__bff_watching", visible: false, scope: null })).toBe(
      true,
    );
    expect(isBffWatchingCommand({ type: "__bff_watching", visible: true })).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isBffWatchingCommand({ type: "__bff_resume", from_seq: null })).toBe(false);
    expect(isBffWatchingCommand({ type: "__bff_watching", scope })).toBe(false);
    expect(isBffWatchingCommand({ type: "__bff_watching", visible: "yes", scope })).toBe(false);
    expect(isBffWatchingCommand({ type: "__bff_watching", visible: true, scope: {} })).toBe(false);
    expect(
      isBffWatchingCommand({ type: "__bff_watching", visible: true, scope: { agent_id: "a" } }),
    ).toBe(false);
    expect(isBffWatchingCommand(null)).toBe(false);
  });
});

/**
 * These assert a security boundary, not a preference. The app-server applies no
 * root of its own — `read_file` with an arbitrary absolute path succeeds — so
 * everything below is the only thing standing between a browser session and the
 * container filesystem.
 */
describe("workspace clamp", () => {
  const allow = (command: Record<string, unknown> & { type: string }) =>
    expect(workspaceViolation(command)).toBeNull();
  const refuse = (command: Record<string, unknown> & { type: string }) =>
    expect(workspaceViolation(command)).toBeString();

  test("paths inside the workspace are allowed", () => {
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/notes.md` });
    allow({ type: "list_in_directory", path: WORKSPACE_ROOT });
    allow({ type: "get_tree", path: `${WORKSPACE_ROOT}/agent-1` });
  });

  test("the paths that are reachable today are refused", () => {
    refuse({ type: "list_in_directory", path: "/etc" });
    refuse({ type: "get_tree", path: "/" });
    refuse({ type: "read_file", path: "/root/.letta/transcripts" });
  });

  test("settings.json and the MCP home are not reachable from a browser session", () => {
    // MCP entries are command lines agent shells exec. They are read and
    // written only through /api/mcp, never with raw file commands.
    refuse({ type: "read_file", path: "/root/.letta/settings.json" });
    refuse({ type: "write_file", path: "/root/.letta/settings.json", content: "{}" });
    refuse({ type: "watch_file", path: "/root/.letta/settings.json" });
    refuse({ type: "read_file", path: "/root/.letta/mcp-home/.letta/settings.json" });
    refuse({ type: "list_in_directory", path: "/root/.letta" });
    // Workspace paths are unaffected.
    allow({ type: "write_file", path: `${WORKSPACE_ROOT}/agent-1/notes.md`, content: "hi" });
  });

  test("traversal out of the workspace is refused after normalisation", () => {
    refuse({ type: "read_file", path: `${WORKSPACE_ROOT}/../etc/passwd` });
    refuse({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/../../etc/passwd` });
    // Normalising back inside is fine.
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/../agent-2/notes.md` });
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/./agent-1//notes.md` });
  });

  test("a prefix that merely starts with the root string is refused", () => {
    // "/workspace" must not pass just because it shares a prefix with "/work".
    refuse({ type: "list_in_directory", path: "/workspace" });
    refuse({ type: "read_file", path: "/work-other/secret" });
  });

  test("search_files and grep_in_files are clamped on cwd, not path", () => {
    refuse({ type: "grep_in_files", query: "token", cwd: "/root/.letta" });
    refuse({ type: "search_files", pattern: "*", cwd: "/etc" });
    allow({ type: "grep_in_files", query: "token", cwd: `${WORKSPACE_ROOT}/agent-1` });
    // Absent cwd means the server's own cwd, which compose anchors inside /work.
    allow({ type: "grep_in_files", query: "token" });
  });

  test("skill_enable is clamped on skill_path", () => {
    // A skill_enable symlinks whatever it is given into /root/.letta/skills,
    // where it loads for every agent — so an unclamped path here would hand a
    // browser session the whole filesystem to pick a SKILL.md out of.
    refuse({ type: "skill_enable", skill_path: "/root/.letta/skills" });
    refuse({ type: "skill_enable", skill_path: "/etc" });
    refuse({ type: "skill_enable", skill_path: `${WORKSPACE_ROOT}/../root` });
    allow({ type: "skill_enable", skill_path: `${WORKSPACE_ROOT}/agent-1/.agents/skills/thing` });
  });

  test("relative paths are refused rather than resolved", () => {
    refuse({ type: "read_file", path: "notes.md" });
    refuse({ type: "read_file", path: "../etc/passwd" });
    refuse({ type: "read_file", path: "" });
  });

  test("commands that carry no path are untouched", () => {
    allow({ type: "agent_list" });
    allow({ type: "list_models" });
    allow({ type: "execute_command", command_id: "compact" });
  });

  test("launch_subagent is on the allowlist", () => {
    expect(ALLOWED_SESSION_COMMANDS.has("launch_subagent")).toBe(true);
  });

  test("branch commands are clamped on cwd, like grep", () => {
    // Both take an optional cwd that the app-server otherwise resolves against
    // its own process cwd. Registered in FILE_PATH_FIELDS so the clamp covers
    // them; without that entry a browser could point git at any host path.
    refuse({ type: "search_branches", query: "", cwd: "/root/.letta" });
    refuse({ type: "checkout_branch", branch: "main", cwd: "/etc" });
    refuse({ type: "checkout_branch", branch: "main", cwd: `${WORKSPACE_ROOT}/../etc` });
    allow({ type: "search_branches", query: "feat", cwd: `${WORKSPACE_ROOT}/agent-1` });
    allow({ type: "checkout_branch", branch: "feat/x", cwd: `${WORKSPACE_ROOT}/agent-1` });
    // Absent cwd still passes through as "the server's cwd", anchored in /work.
    allow({ type: "search_branches", query: "feat" });
    allow({ type: "checkout_branch", branch: "feat/x" });
  });

  test("secrets and reflection commands carry no path and are unconstrained by the clamp", () => {
    // They are scoped by agent_id / runtime, not by a filesystem path, so the
    // workspace clamp has nothing to say about them.
    allow({ type: "secret_list", agent_id: "agent-1" });
    allow({ type: "secret_apply", agent_id: "agent-1", set: { K: "v" }, unset: [] });
    allow({
      type: "get_reflection_settings",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    });
    allow({
      type: "set_reflection_settings",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      settings: { trigger: "step-count", step_count: 10 },
    });
  });
});

/**
 * The command-type allowlist is the boundary; these pin which types a browser
 * may send at all. Anything absent here is refused before it reaches the
 * app-server, regardless of how well-formed its body is.
 */
describe("session command allowlist", () => {
  const newlyAdded = [
    "secret_list",
    "secret_apply",
    "get_reflection_settings",
    "set_reflection_settings",
    "search_branches",
    "checkout_branch",
  ];

  test("the newly surfaced capabilities are admitted", () => {
    for (const type of newlyAdded) {
      expect(ALLOWED_SESSION_COMMANDS.has(type)).toBe(true);
    }
  });

  test("a running subagent can be stopped from the browser", () => {
    // The Tasks tab's Stop on a running subagent row rides on this verb
    // (letta-code 0.34.16). Without it upstream never sees the request.
    expect(ALLOWED_SESSION_COMMANDS.has("subagent_stop")).toBe(true);
  });

  test("a running subagent's events are not read over the socket", () => {
    // Upstream's wire-side page of the event log stays off the allowlist: every
    // reader in this app goes through the event stream or the file route
    // (`runs/task-logs.ts`), so admitting it would only widen the surface.
    expect(ALLOWED_SESSION_COMMANDS.has("read_subagent_events")).toBe(false);
  });

  test("the process-level surface stays off the allowlist", () => {
    // Terminals, arbitrary shell, and the raw settings write path. None of
    // these have a screen, so none of them are reachable.
    for (const type of [
      "terminal_spawn",
      "terminal_input",
      "terminal_kill",
      "file_ops",
      "upgrade_letta_code",
      "channel_start",
      "channel_stop",
      "get_experiments",
      "set_experiment",
    ]) {
      expect(ALLOWED_SESSION_COMMANDS.has(type)).toBe(false);
    }
  });
});

/**
 * `execute_command` is the one allowlisted command type whose real surface is
 * chosen by a free-form `command_id`, and the app-server enforces nothing at
 * the boundary. These pin the refusal of the ids that must never be reachable
 * from a browser — above all the one that restarts the process.
 */
describe("execute_command allowlist", () => {
  const none = new Set<string>();
  const allow = (id: string, mods: ReadonlySet<string> = none) =>
    expect(executeCommandViolation(id, mods)).toBeNull();
  const refuse = (id: unknown, mods: ReadonlySet<string> = none) =>
    expect(executeCommandViolation(id, mods)).toBeString();

  test("the commands the UI actually offers are allowed", () => {
    for (const id of ["compact", "context-limit", "doctor", "init", "reload"]) {
      allow(id);
    }
  });

  test("the remote clear removed in letta-code 0.34.15 stays refused", () => {
    refuse("clear");
    refuse("clear-messages");
  });

  test("upgrade-letta-code is refused", () => {
    refuse("upgrade-letta-code");
  });

  test("the no-op and gateway-only ids are refused", () => {
    refuse("channels");
    refuse("secret");
    refuse("toolset");
  });

  test("an unknown id is refused", () => {
    refuse("rm-rf");
    refuse("");
    refuse(undefined);
    refuse(42);
  });

  test("an advertised mod command is allowed, an unadvertised one is not", () => {
    allow("my-mod", new Set(["my-mod"]));
    refuse("my-mod");
  });
});

describe("withWebClientPreferences", () => {
  const createMessage = {
    type: "input",
    runtime: { agent_id: "agent-local-a", conversation_id: "conv-1" },
    payload: { kind: "create_message", messages: [{ role: "user", content: "hi" }] },
  };

  test("create_message gets the AskUserQuestion opt-in", () => {
    const out = withWebClientPreferences(createMessage);
    expect(out.payload).toEqual({
      ...createMessage.payload,
      client_preferences: { toolset: { include: ["AskUserQuestion"] } },
    });
  });

  test("an existing client_preferences is never overwritten", () => {
    const mine = {
      ...createMessage,
      payload: { ...createMessage.payload, client_preferences: { toolset: { include: [] } } },
    };
    expect(withWebClientPreferences(mine)).toBe(mine);
  });

  test("non-input and non-create_message frames pass through untouched", () => {
    const abort = { type: "abort_message", runtime: createMessage.runtime };
    expect(withWebClientPreferences(abort)).toBe(abort);
    const other = { type: "input", payload: { kind: "something_else" } };
    expect(withWebClientPreferences(other)).toBe(other);
    const noPayload = { type: "input" };
    expect(withWebClientPreferences(noPayload)).toBe(noPayload);
    const badPayload = { type: "input", payload: "not-an-object" };
    expect(withWebClientPreferences(badPayload)).toBe(badPayload);
  });
});
