/**
 * One-line, human-readable summaries of tool calls.
 *
 * The transcript used to pretty-print every tool's raw argument JSON, so a
 * shell command read as `{"command": "git status", "description": "…"}` rather
 * than as the command. That is dense on a desktop and unreadable on a phone,
 * which is the screen this UI is built for.
 *
 * The JSON is never thrown away — `MessageList` still shows it behind the same
 * disclosure — so an unrecognised tool loses nothing by falling through.
 */

export interface ToolSummary {
  /** The line that replaces the tool name on the collapsed row. */
  headline: string;
  /** A short second line, when the tool offers one worth showing. */
  subtitle?: string;
  /** Render the headline as code (a command, a path) rather than prose. */
  mono?: boolean;
}

/** Arguments arrive as a JSON string, and mid-stream that string is truncated. */
export function parseToolArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Still streaming, so not valid JSON yet. The caller falls back to the name.
    return null;
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * Shorten a path against the agent's working directory.
 *
 * Every agent's cwd is `/work/<agent-id>`, so an unshortened path spends 45
 * characters on a UUID before it says anything. `$MEMORY_DIR` gets the same
 * treatment because memory lives outside the workspace entirely.
 */
export function shortenPath(path: string, cwd: string | null): string {
  if (!path) return "";
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const memfs = /^\/data\/local-backend\/memfs\/[^/]+\/memory\/(.*)$/.exec(path);
  if (memfs?.[1]) return `memory/${memfs[1]}`;
  return path;
}

/** How many entries an array-valued argument holds. */
function count(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return Array.isArray(value) ? value.length : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * A readable line for one tool call, or null to fall back to the tool name.
 *
 * Tool names span three toolsets upstream (Anthropic, Codex, Gemini), so the
 * snake_case aliases are matched alongside the PascalCase ones rather than
 * assuming the default toolset.
 */
export function summarizeToolCall(
  toolName: string | undefined,
  args: Record<string, unknown> | null,
  cwd: string | null,
): ToolSummary | null {
  if (!toolName || !args) return null;
  const path = (key: string) => shortenPath(str(args, key), cwd);

  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "exec_command": {
      const command = str(args, "command");
      if (!command) return null;
      const description = str(args, "description");
      return {
        headline: `$ ${command}`,
        mono: true,
        ...(description ? { subtitle: description } : {}),
      };
    }

    case "Read":
    case "ReadFile":
    case "read_file":
    case "read_file_gemini": {
      const file = path("file_path") || path("path") || path("absolute_path");
      if (!file) return null;
      const offset = args.offset;
      const limit = args.limit;
      const range =
        typeof offset === "number" || typeof limit === "number"
          ? ` (from line ${typeof offset === "number" ? offset : 1})`
          : "";
      return { headline: `${file}${range}`, mono: true };
    }

    case "Write":
    case "WriteFile":
    case "write_file": {
      const file = path("file_path") || path("path");
      return file ? { headline: file, mono: true } : null;
    }

    case "Edit":
    case "EditFile":
    case "edit_file":
    case "replace": {
      const file = path("file_path") || path("path");
      return file ? { headline: file, mono: true } : null;
    }

    // Removed upstream in letta-code 0.33 (as was `memory` below); kept so
    // older transcripts still read well.
    case "MultiEdit": {
      const file = path("file_path") || path("path");
      if (!file) return null;
      const edits = count(args, "edits");
      return {
        headline: file,
        mono: true,
        ...(edits === null ? {} : { subtitle: plural(edits, "edit") }),
      };
    }

    case "Grep":
    case "GrepFiles":
    case "grep_files":
    case "search_file_content": {
      const pattern = str(args, "pattern") || str(args, "query");
      if (!pattern) return null;
      const where = path("path") || path("cwd");
      return { headline: where ? `${pattern}  in ${where}` : pattern, mono: true };
    }

    case "Glob":
    case "glob_gemini": {
      const pattern = str(args, "pattern");
      if (!pattern) return null;
      const where = path("path");
      return { headline: where ? `${pattern}  in ${where}` : pattern, mono: true };
    }

    case "LS":
    case "ListDir":
    case "list_dir":
    case "list_directory": {
      const dir = path("path") || path("directory_path");
      return dir ? { headline: dir, mono: true } : null;
    }

    case "TodoWrite": {
      const todos = count(args, "todos");
      return todos === null ? null : { headline: plural(todos, "todo") };
    }

    // letta-code 0.34.7: read-only discovery of deferred memfs-v2 memory. The
    // path is already relative to the memory dir, so it needs no shortening.
    case "Memory": {
      const target = path("path");
      return target ? { headline: target, mono: true } : null;
    }

    case "memory": {
      const command = str(args, "command");
      const file = str(args, "file_path");
      if (!command && !file) return null;
      const reason = str(args, "reason");
      return {
        headline: [command, file].filter(Boolean).join("  "),
        mono: true,
        ...(reason ? { subtitle: reason } : {}),
      };
    }

    case "WatchPR": {
      const url = str(args, "url");
      return url ? { headline: url, mono: true } : null;
    }

    case "Wake": {
      const action = str(args, "action");
      if (!action) return null;
      const name = str(args, "name");
      const cron = str(args, "cron");
      const at = str(args, "scheduled_at");
      const after = args.after_seconds;
      const when = cron
        ? `cron ${cron} (UTC)`
        : at
          ? `at ${at}`
          : typeof after === "number"
            ? `in ${after} s`
            : "";
      return {
        headline: [action, name || str(args, "id")].filter(Boolean).join("  "),
        ...(when ? { subtitle: when } : {}),
      };
    }

    case "Task":
    case "Agent": {
      const description = str(args, "description") || str(args, "prompt");
      if (!description) return null;
      const subagent = str(args, "subagent_type");
      return {
        headline: description,
        ...(subagent ? { subtitle: subagent } : {}),
      };
    }

    case "MessageChannel": {
      const channel = str(args, "channel") || str(args, "channel_id");
      const message = str(args, "message") || str(args, "text");
      if (!channel && !message) return null;
      return {
        headline: channel ? `→ ${channel}` : "→ channel",
        ...(message ? { subtitle: message } : {}),
      };
    }

    // `fetch_webpage` / `web_search`: the native web tools (bff/src/web-tools/).
    case "fetch_webpage":
    case "WebFetch": {
      const url = str(args, "url");
      return url ? { headline: url, mono: true } : null;
    }

    case "web_search":
    case "WebSearch": {
      const query = str(args, "query");
      return query ? { headline: query } : null;
    }

    case "Skill": {
      const skill = str(args, "skill");
      return skill ? { headline: skill, mono: true } : null;
    }

    default:
      return null;
  }
}
