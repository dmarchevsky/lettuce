/**
 * Settings → Claude Code: what Claude Code subagent workers run against.
 *
 * letta-code starts `claude` (our shim, docker/codex) for `subagent_type:
 * "claude-code"` and hands it nothing but a prompt and a cwd. Claude Code has
 * no config file for its endpoint — it reads `ANTHROPIC_BASE_URL`,
 * `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` from the environment — so the
 * BFF keeps the saved settings as `lettuce.json` in Claude's config dir and
 * the shim injects them as env. There is no `config.toml` analogue.
 *
 * `lettuce.json` doubles as the shim's switch: absent, unreadable or
 * `enabled: false` and the shim refuses to run (docker/codex/claude-shim-core.mjs).
 *
 * Two ways to authenticate (`mode`):
 * - `endpoint`: Claude Code speaks only the Anthropic Messages API, which
 *   llama.cpp does not serve, so the endpoint is a user-supplied
 *   Anthropic-compatible URL (a proxy such as LiteLLM, or any Anthropic-API
 *   gateway), a model id and an optional bearer token.
 * - `subscription`: the user's Claude subscription, through the long-lived
 *   OAuth token `claude setup-token` prints (run on any machine with a
 *   browser — no login happens in the container). The shim passes it as
 *   `CLAUDE_CODE_OAUTH_TOKEN` and sets no endpoint; the model is optional.
 *
 * Each mode keeps its own token and model (`authToken` + `model` for the
 * endpoint, `oauthToken` + `subscriptionModel`), so switching back and forth
 * loses neither and never sends one mode's model id to the other's API.
 */

/** On the letta-home bind mount (`CLAUDE_CONFIG_DIR` in docker/compose.yml). */
export const CLAUDE_HOME = "/root/.letta/claude";
export const CLAUDE_SETTINGS_PATH = `${CLAUDE_HOME}/lettuce.json`;
/**
 * This file's name before the `letta-ui` → `lettuce` rename. Read when the new
 * one is absent and mirrored on every write, because the `claude` shim that
 * reads it ships in the app-server image and that image is only rebuilt on a
 * version bump. See `bff/src/internal-tools/legacy.ts`.
 */
export const CLAUDE_SETTINGS_LEGACY_PATH = `${CLAUDE_HOME}/letta-ui.json`;
/** Where Claude writes its per-run transcripts: `<dir>/<session id>.jsonl`. */
export const CLAUDE_PROJECTS_DIR = `${CLAUDE_HOME}/projects`;

export const CLAUDE_AUTH_MODES = ["endpoint", "subscription"] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

export interface ClaudeSettings {
  enabled: boolean;
  /** Absent in files saved before subscription mode existed: `endpoint`. */
  mode: ClaudeAuthMode;
  /** Anthropic-compatible base URL, e.g. `http://host:4000`. */
  baseUrl: string;
  /** Endpoint mode's model id, as the endpoint names it. */
  model: string;
  /** Subscription mode's model: an alias (`sonnet`, `opus`) or id; "" = Claude Code's default. */
  subscriptionModel: string;
  /** Sent as `ANTHROPIC_AUTH_TOKEN`. Never returned to a browser. */
  authToken: string | null;
  /** Subscription mode: sent as `CLAUDE_CODE_OAUTH_TOKEN`. Never returned to a browser. */
  oauthToken: string | null;
}

/** What the browser sees: each token is reduced to whether one is set. */
export type PublicClaudeSettings = Omit<ClaudeSettings, "authToken" | "oauthToken"> & {
  hasAuthToken: boolean;
  hasOauthToken: boolean;
};

export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  enabled: false,
  mode: "endpoint",
  baseUrl: "",
  model: "",
  subscriptionModel: "",
  authToken: null,
  oauthToken: null,
};

export class InvalidClaudeSettingsError extends Error {}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAuthMode(value: unknown): value is ClaudeAuthMode {
  return (CLAUDE_AUTH_MODES as readonly unknown[]).includes(value);
}

/** Write-only secret: `null` / `""` clears it, anything else must be text. */
function tokenUpdate(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new InvalidClaudeSettingsError(`${field} must be text`);
  }
  return optionalString(value);
}

/** Lenient: a hand-edited or older file still loads, with defaults filling the gaps. */
export function parseStoredClaudeSettings(text: string | null): ClaudeSettings {
  if (!text) return { ...DEFAULT_CLAUDE_SETTINGS };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CLAUDE_SETTINGS };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CLAUDE_SETTINGS };
  }
  return {
    enabled: raw.enabled === true,
    mode: isAuthMode(raw.mode) ? raw.mode : "endpoint",
    baseUrl: optionalString(raw.baseUrl) ?? "",
    model: optionalString(raw.model) ?? "",
    subscriptionModel: optionalString(raw.subscriptionModel) ?? "",
    authToken: optionalString(raw.authToken),
    oauthToken: optionalString(raw.oauthToken),
  };
}

/**
 * Apply a browser update onto the stored settings. Absent fields keep their
 * value — `mode` included; `authToken` and `oauthToken` in particular are
 * write-only, so leaving one out keeps the saved token and `null` / `""`
 * clears it.
 */
export function applyClaudeSettingsUpdate(current: ClaudeSettings, body: unknown): ClaudeSettings {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidClaudeSettingsError("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  const next: ClaudeSettings = { ...current };

  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") {
      throw new InvalidClaudeSettingsError("enabled must be true or false");
    }
    next.enabled = input.enabled;
  }
  if ("mode" in input) {
    if (!isAuthMode(input.mode)) {
      throw new InvalidClaudeSettingsError(`mode must be one of ${CLAUDE_AUTH_MODES.join(", ")}`);
    }
    next.mode = input.mode;
  }
  if ("baseUrl" in input) {
    const url = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) {
      throw new InvalidClaudeSettingsError("baseUrl must be an http(s) URL");
    }
    next.baseUrl = url;
  }
  if ("model" in input) {
    if (input.model !== null && typeof input.model !== "string") {
      throw new InvalidClaudeSettingsError("model must be text");
    }
    next.model = typeof input.model === "string" ? input.model.trim() : "";
  }
  if ("subscriptionModel" in input) {
    if (input.subscriptionModel !== null && typeof input.subscriptionModel !== "string") {
      throw new InvalidClaudeSettingsError("subscriptionModel must be text");
    }
    next.subscriptionModel = optionalString(input.subscriptionModel) ?? "";
  }
  if ("authToken" in input) next.authToken = tokenUpdate(input.authToken, "authToken");
  if ("oauthToken" in input) next.oauthToken = tokenUpdate(input.oauthToken, "oauthToken");

  if (next.enabled && next.mode === "subscription" && !next.oauthToken) {
    throw new InvalidClaudeSettingsError(
      "Paste the token from `claude setup-token` before enabling Claude Code workers",
    );
  }
  if (next.enabled && next.mode === "endpoint" && (!next.baseUrl || !next.model)) {
    throw new InvalidClaudeSettingsError(
      "Set an endpoint URL and a model before enabling Claude Code workers",
    );
  }
  return next;
}

export function toPublicClaudeSettings(settings: ClaudeSettings): PublicClaudeSettings {
  const { authToken, oauthToken, ...rest } = settings;
  return { ...rest, hasAuthToken: authToken !== null, hasOauthToken: oauthToken !== null };
}

/** The stored settings. Also what the shim reads for `enabled` and the env. */
export function renderStoredClaudeSettings(settings: ClaudeSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
