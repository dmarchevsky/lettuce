/**
 * Pure logic of the `claude` shim (see ./claude-shim.mjs for why it exists).
 *
 * Kept free of side effects so `claude-shim-core.test.ts` can exercise it; the
 * entry script only wires these functions to a child process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by the BFF (`bff/src/claude/settings.ts`) in Claude's config dir. */
export const SETTINGS_FILE = "lettuce.json";
/** Its name before the `letta-ui` → `lettuce` rename; the BFF mirrors into it. */
export const SETTINGS_FILE_LEGACY = "letta-ui.json";

export const DISABLED_MESSAGE =
  "Claude Code workers are disabled. Enable them in the web UI under Settings → Claude Code.";

/**
 * `$CLAUDE_CONFIG_DIR`, else where compose points it (the letta-home mount, so
 * transcripts survive recreates and the BFF can read them).
 */
export const CLAUDE_CONFIG_DIR = "/root/.letta/claude";

/**
 * Satisfies `claude auth status --json` in endpoint mode (the preflight
 * letta-code runs: it needs `loggedIn: true`, which any `ANTHROPIC_AUTH_TOKEN`
 * value gives — measured on 2.1.285 and 2.1.289) when no token was configured. A proxy that checks the
 * token rejects it at request time, which is the honest failure; a proxy that
 * ignores auth never sees a difference.
 */
export const PLACEHOLDER_AUTH_TOKEN = "lettuce-placeholder-not-an-anthropic-key";

/** Never passed to a subscription-mode run: each would redirect or shadow the OAuth token. */
export const SUBSCRIPTION_UNSAFE_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

/** Where Claude's config (and `projects/` transcripts) live for this run. */
export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || CLAUDE_CONFIG_DIR;
}

/** The saved settings, or null when absent or unreadable — which means disabled. */
export function readShimSettings(configDir) {
  for (const name of [SETTINGS_FILE, SETTINGS_FILE_LEGACY]) {
    try {
      const parsed = JSON.parse(readFileSync(join(configDir, name), "utf8"));
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
 * The environment for the real CLI. Claude Code has no config file of its own
 * for its credentials or endpoint — it reads environment variables — so the
 * settings the BFF saved are injected here rather than rendered into a file.
 * Anything already in the environment wins: compose sets `CLAUDE_CONFIG_DIR`,
 * and an operator who exports a value in the container means it.
 *
 * Two modes (`settings.mode`; absent means endpoint, which is what every file
 * saved before subscription mode existed holds):
 * - `subscription`: the long-lived OAuth token from `claude setup-token`, as
 *   `CLAUDE_CODE_OAUTH_TOKEN`, and the mode's own `subscriptionModel`. No
 *   endpoint and no bearer token — and any already in the environment are
 *   removed, the one exception to "the environment wins":
 *   `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` outrank the OAuth token in
 *   Claude Code's auth order (so they would shadow it), and
 *   `ANTHROPIC_BASE_URL` would send the subscription token to a proxy.
 *   `auth status --json` reports `loggedIn: true` with only the OAuth token
 *   set — measured on 2.1.289.
 * - endpoint: the Anthropic-compatible URL, `model` and bearer token.
 */
export function buildEnv(settings, env) {
  const next = { ...env };
  next.CLAUDE_CONFIG_DIR ||= CLAUDE_CONFIG_DIR;
  if (settings.mode === "subscription") {
    for (const name of SUBSCRIPTION_UNSAFE_ENV) delete next[name];
    if (settings.subscriptionModel) next.ANTHROPIC_MODEL ||= settings.subscriptionModel;
    if (settings.oauthToken) next.CLAUDE_CODE_OAUTH_TOKEN ||= settings.oauthToken;
    return next;
  }
  if (settings.model) next.ANTHROPIC_MODEL ||= settings.model;
  if (settings.baseUrl) next.ANTHROPIC_BASE_URL ||= settings.baseUrl;
  next.ANTHROPIC_AUTH_TOKEN ||= settings.authToken || PLACEHOLDER_AUTH_TOKEN;
  return next;
}
