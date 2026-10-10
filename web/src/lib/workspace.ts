/**
 * Where agents keep their files.
 *
 * `/work` is the bind mount from the host (docker/compose.yml maps
 * `../../workspaces:/work`), and compose anchors the app-server's working
 * directory there so agent output persists and is visible on the host — the
 * image's own `WORKDIR /workspace` is container-layer storage that vanishes on
 * recreate.
 *
 * Each agent gets `/work/<agent-id>`, which `use-conversation.ts` passes as the
 * runtime `cwd`. That is a CONVENTION, not a kernel boundary: letta-code's
 * filesystem sandbox is off (LETTA_FS_SANDBOX=0, see docker/compose.yml), so
 * an agent's shell can reach anything in the container, peers' workspaces
 * included.
 *
 * The one hard boundary here is the BROWSER's. Keep in sync with
 * `WORKSPACE_ROOT` in bff/src/session/protocol.ts, which clamps every file
 * command a browser session can issue. The two packages cannot import from each
 * other, and the BFF copy is the one that actually refuses traffic — this one
 * only decides where to point the runtime.
 */
export const WORKSPACE_ROOT = "/work";

/** The directory an agent works in. Ids are opaque, so no escaping is needed. */
export function agentWorkspace(agentId: string): string {
  return `${WORKSPACE_ROOT}/${agentId}`;
}

/**
 * Permission modes the app-server understands (`DevicePermissionMode`).
 *
 * Note the default is `unrestricted`, and the app-server does not persist a
 * mode equal to the default — so an explicit `unrestricted` is indistinguishable
 * from "never set" after a restart.
 */
export const PERMISSION_MODES = [
  {
    id: "unrestricted",
    label: "Unrestricted",
    description: "Run everything without asking. The default.",
  },
  {
    id: "standard",
    label: "Standard",
    description: "Ask before anything that writes or runs.",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    description: "Apply file edits automatically, still ask for commands.",
  },
  {
    id: "strict",
    label: "Strict",
    description: "Ask for everything, including reads.",
  },
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number]["id"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode.id === value);
}

export interface SlashCommand {
  id: string;
  description: string;
  args?: string;
}

/**
 * Ids the app-server advertises but cannot actually run.
 *
 * `supported_commands` is advertisement only — the inbound path never checks it,
 * and it disagrees with the handler's own switch in both directions. These four
 * would return "Unknown command" or do nothing, so they are not worth offering.
 */
const UNDISPATCHABLE = new Set([
  // Documented in listener-constants.ts: routed through secret_list/secret_apply,
  // so it has no execute_command case.
  "secret",
  // Advertised but has no case either; falls through to the mod lookup.
  "toolset",
  // Needs a gateway attached over stdio; see AGENTS.md.
  "channels",
  // Meaningless against a pinned image.
  "upgrade-letta-code",
]);

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation history",
  compact: "Compact the conversation to free context",
  "context-limit": "Show the current context window usage",
  doctor: "Run environment diagnostics",
  init: "Explore the working directory and write a project guide",
  reload: "Reload settings, local mods and agent secrets",
};

/** Build the palette from what device status advertises, built-ins then mods. */
export function readCommands(supported: unknown, mods: unknown): SlashCommand[] {
  const builtins = (Array.isArray(supported) ? supported : [])
    .filter((id): id is string => typeof id === "string" && !UNDISPATCHABLE.has(id))
    .map((id) => ({ id, description: COMMAND_DESCRIPTIONS[id] ?? "" }));

  const modCommands = (Array.isArray(mods) ? mods : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const mod = raw as { id?: unknown; description?: unknown; args?: unknown };
    if (typeof mod.id !== "string") return [];
    return [
      {
        id: mod.id,
        description: typeof mod.description === "string" ? mod.description : "",
        ...(typeof mod.args === "string" ? { args: mod.args } : {}),
      },
    ];
  });

  return [...builtins, ...modCommands];
}

/**
 * Split "/id rest" into a command id and its arguments, or null when the text
 * is an ordinary message.
 *
 * Only an EXACT match against an advertised id counts, because a leading slash
 * is not evidence of intent on its own: `/work/agent-x/notes.md` is a path
 * someone pasted, and the app-server answers an unrecognised `command_id` with
 * "Unknown command" (`commands.ts`, default case) rather than falling back to
 * treating it as text. Anything unmatched must therefore still be sent as a
 * message — the app-server's own `input` path never inspects the slash, so this
 * function is the only place the distinction is ever made.
 */
export function parseSlashCommand(
  text: string,
  commands: SlashCommand[],
): { id: string; args?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const separator = trimmed.search(/\s/);
  const id = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator);
  if (!commands.some((command) => command.id === id)) return null;

  const args = separator === -1 ? "" : trimmed.slice(separator).trim();
  return args ? { id, args } : { id };
}

/**
 * Commands whose id the typed text is a prefix of, for the composer's popover.
 *
 * Returns nothing once a space has been typed: from there on the user is
 * writing arguments, and a suggestion list hovering over the composer would be
 * covering the transcript for no reason.
 */
export function matchSlashCommands(text: string, commands: SlashCommand[]): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return commands.filter((command) => command.id.toLowerCase().startsWith(prefix));
}
