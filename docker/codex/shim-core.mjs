/**
 * Pure logic of the `codex` shim (see ./codex-shim.mjs for why it exists).
 *
 * Kept free of side effects so `shim-core.test.ts` can exercise it; the entry
 * script only wires these functions to a child process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by the BFF (`bff/src/codex/settings.ts`) next to Codex's own config. */
export const SETTINGS_FILE = "lettuce.json";
/** Its name before the `letta-ui` → `lettuce` rename; the BFF mirrors into it. */
export const SETTINGS_FILE_LEGACY = "letta-ui.json";

export const DISABLED_MESSAGE =
  "Codex workers are disabled. Enable them in the web UI under Settings → Codex.";

/** `$CODEX_HOME`, else Codex's own default of `~/.codex`. */
export function codexHome(env) {
  return env.CODEX_HOME || join(env.HOME || "/root", ".codex");
}

/** The saved settings, or null when absent or unreadable — which means disabled. */
export function readShimSettings(home) {
  for (const name of [SETTINGS_FILE, SETTINGS_FILE_LEGACY]) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, name), "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next name; no file at all means disabled.
    }
  }
  return null;
}

export function isEnabled(settings) {
  return settings?.enabled === true;
}

/**
 * The container is the isolation boundary this stack keeps (see CLAUDE.md,
 * "letta-code's filesystem sandbox is OFF"), so Codex is told so rather than
 * asked to build its own bubblewrap sandbox inside it. Under an external
 * sandbox Codex enforces nothing itself — network included — so there is no
 * "restricted" option to offer: it would only be a hint to the model.
 */
export const EXTERNAL_SANDBOX_POLICY = Object.freeze({
  type: "externalSandbox",
  networkAccess: "enabled",
});

/**
 * Whether this `codex` invocation is the app-server letta-code spawns — the only
 * one whose stdin is JSON-RPC and therefore the only one to rewrite.
 *
 * letta-code puts `app-server` first today (`tools/impl/codex-app-server.ts`,
 * `spawnTransport`), but since 0.34.55 it can prepend Codex CLI overrides —
 * `-c key=value` — when it proxies a worker's model calls for tracing. That
 * feature is Cloud-only (it refuses outside the API backend, and this stack runs
 * the local one), so the naive `args[0]` test works; keyed on the first
 * non-option argument instead, a Cloud-side flip cannot silently stop the
 * sandbox rewrite and hand Codex a bubblewrap sandbox inside the container.
 */
export function isAppServerInvocation(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // `-c k=v` / `--config k=v`: a space-separated option swallows its value,
    // which is otherwise a bare token that would be read as the subcommand.
    if (arg === "-c" || arg === "--config") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === "app-server";
  }
  return false;
}

/**
 * Rewrite one JSON-RPC line from letta-code to Codex's app-server.
 *
 * letta-code sends a `sandboxPolicy` on every `turn/start`
 * (`tools/impl/codex-app-server.ts`, hard-coded — `workspaceWrite` until 0.34.14, which asked Codex
 * to build its own bubblewrap sandbox here, and `dangerFullAccess` since). Only that field changes;
 * anything that is not JSON, or carries no `sandboxPolicy`, passes through byte for byte.
 */
export function rewriteLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!message || typeof message !== "object") return line;
  const params = message.params;
  if (!params || typeof params !== "object" || !("sandboxPolicy" in params)) return line;
  return JSON.stringify({
    ...message,
    params: { ...params, sandboxPolicy: EXTERNAL_SANDBOX_POLICY },
  });
}
