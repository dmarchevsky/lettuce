/**
 * What Settings → Google Workspace stores, and the two files it renders for the
 * `google-mcp` sidecar.
 *
 * Everything here lives on two named volumes that only the BFF and the sidecar
 * mount (docker/compose.yml) — never the app-server, where every agent shell
 * could rewrite it. That, not anything in this file, is what keeps an agent
 * from changing its own Google access:
 *
 *   google-policy  bff: /app/google/policy (rw)   sidecar: /policy (ro)
 *     settings.json  the BFF's own state: client, wanted levels, the grant
 *     sidecar.json   what the sidecar runs: on/off, account, --permissions
 *   google-creds   bff: /app/google/creds (rw)    sidecar: /creds (rw)
 *     <email>.json   the OAuth token, in workspace-mcp's credential format
 */

import {
  coveredPermissions,
  GOOGLE_SERVICES,
  type GooglePermissions,
  hasAnyService,
  isLevel,
  NO_PERMISSIONS,
  permissionArgs,
  samePermissions,
} from "./policy.ts";

export const GOOGLE_SETTINGS_FILE = "settings.json";
export const GOOGLE_SIDECAR_FILE = "sidecar.json";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** A consent that produced a usable token. */
export interface GoogleGrant {
  email: string;
  /** The scopes Google says it granted — possibly fewer than were asked for. */
  scopes: string[];
  /** The levels the consent asked for. */
  requested: GooglePermissions;
  grantedAt: string;
  /**
   * When Google stopped accepting the token (revoked, expired, or a password
   * change). The grant is kept rather than dropped so Settings can say what was
   * lost and the Google tools stay registered: a call then tells the agent to
   * send the user to reconnect, instead of the tools silently vanishing.
   */
  lostAt?: string;
}

export interface GoogleSettings {
  enabled: boolean;
  clientId: string;
  /** Never sent back to a browser. */
  clientSecret: string | null;
  /** The levels the user wants. What runs is capped by the grant. */
  permissions: GooglePermissions;
  grant: GoogleGrant | null;
}

export const DEFAULT_GOOGLE_SETTINGS: GoogleSettings = {
  enabled: false,
  clientId: "",
  clientSecret: null,
  permissions: { ...NO_PERMISSIONS },
  grant: null,
};

export class InvalidGoogleSettingsError extends Error {}

function permissionsOf(value: unknown): GooglePermissions {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: Record<string, string | null> = {};
  for (const service of GOOGLE_SERVICES) {
    result[service] = isLevel(service, raw[service]) ? (raw[service] as string) : null;
  }
  return result as GooglePermissions;
}

function grantOf(value: unknown): GoogleGrant | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.email !== "string" || !raw.email.includes("@")) return null;
  if (!Array.isArray(raw.scopes)) return null;
  return {
    email: raw.email,
    scopes: raw.scopes.filter((scope): scope is string => typeof scope === "string"),
    requested: permissionsOf(raw.requested),
    grantedAt: typeof raw.grantedAt === "string" ? raw.grantedAt : "",
    ...(typeof raw.lostAt === "string" ? { lostAt: raw.lostAt } : {}),
  };
}

/** Lenient: an unreadable or partial file loads as defaults, never as more access. */
export function parseStoredGoogleSettings(text: string | null): GoogleSettings {
  if (!text) return structuredClone(DEFAULT_GOOGLE_SETTINGS);
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_GOOGLE_SETTINGS);
    raw = parsed as Record<string, unknown>;
  } catch {
    return structuredClone(DEFAULT_GOOGLE_SETTINGS);
  }
  return {
    enabled: raw.enabled === true,
    clientId: typeof raw.clientId === "string" ? raw.clientId.trim() : "",
    clientSecret:
      typeof raw.clientSecret === "string" && raw.clientSecret.trim()
        ? raw.clientSecret.trim()
        : null,
    permissions: permissionsOf(raw.permissions),
    grant: grantOf(raw.grant),
  };
}

export interface GoogleSettingsUpdate {
  enabled?: boolean;
  clientId?: string;
  /** Absent keeps the stored secret; "" or null clears it. */
  clientSecret?: string | null;
  permissions?: Partial<Record<string, string | null>>;
}

/**
 * Apply a browser update. Absent fields keep their value. Validation only —
 * what a change in levels does to the grant is `service.ts`'s business.
 */
export function applyGoogleSettingsUpdate(current: GoogleSettings, body: unknown): GoogleSettings {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidGoogleSettingsError("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  const next: GoogleSettings = structuredClone(current);

  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") {
      throw new InvalidGoogleSettingsError("enabled must be true or false");
    }
    next.enabled = input.enabled;
  }
  if ("clientId" in input) {
    if (typeof input.clientId !== "string") {
      throw new InvalidGoogleSettingsError("clientId must be text");
    }
    next.clientId = input.clientId.trim();
  }
  if ("clientSecret" in input) {
    if (input.clientSecret !== null && typeof input.clientSecret !== "string") {
      throw new InvalidGoogleSettingsError("clientSecret must be text");
    }
    next.clientSecret = input.clientSecret?.trim() || null;
  }
  if ("permissions" in input) {
    const raw = input.permissions;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidGoogleSettingsError("permissions must be an object");
    }
    const levels = raw as Record<string, unknown>;
    for (const key of Object.keys(levels)) {
      if (!GOOGLE_SERVICES.includes(key as never)) {
        throw new InvalidGoogleSettingsError(`Unknown service: ${key}`);
      }
    }
    for (const service of GOOGLE_SERVICES) {
      if (!(service in levels)) continue;
      const level = levels[service];
      if (level === null || level === "") {
        next.permissions[service] = null;
      } else if (isLevel(service, level)) {
        (next.permissions as Record<string, string | null>)[service] = level as string;
      } else {
        throw new InvalidGoogleSettingsError(`Unknown ${service} level: ${String(level)}`);
      }
    }
  }
  return next;
}

/** The levels the sidecar actually runs with: wanted, capped by the grant. */
export function effectivePermissions(settings: GoogleSettings): GooglePermissions {
  if (!settings.grant) return { ...NO_PERMISSIONS };
  return coveredPermissions(settings.permissions, settings.grant.scopes);
}

/** Whether the sidecar serves anything at all. */
export function isServing(settings: GoogleSettings): boolean {
  return (
    settings.enabled &&
    settings.grant !== null &&
    settings.clientSecret !== null &&
    hasAnyService(effectivePermissions(settings))
  );
}

/** The wanted levels are not all covered by the current grant: a consent is due. */
export function needsReconnect(settings: GoogleSettings): boolean {
  if (!hasAnyService(settings.permissions)) return false;
  if (settings.grant?.lostAt) return true;
  return !samePermissions(effectivePermissions(settings), settings.permissions);
}

export interface SidecarConfig {
  enabled: boolean;
  email: string | null;
  clientId: string;
  clientSecret: string;
  /** workspace-mcp `--permissions` arguments. */
  permissions: string[];
}

/**
 * The sidecar's whole configuration. Its supervisor (docker/google-mcp)
 * restarts workspace-mcp whenever this file changes, and serves nothing
 * unless `enabled` is true.
 */
export function renderSidecarConfig(settings: GoogleSettings): string {
  const serving = isServing(settings);
  const config: SidecarConfig = serving
    ? {
        enabled: true,
        email: settings.grant?.email ?? null,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret ?? "",
        permissions: permissionArgs(effectivePermissions(settings)),
      }
    : { enabled: false, email: null, clientId: "", clientSecret: "", permissions: [] };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderStoredGoogleSettings(settings: GoogleSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * workspace-mcp's credential file name for an account: Python's
 * `quote(email, safe="@._-")` (auth/credential_store.py) plus `.json`. `quote`
 * always leaves letters, digits and `_.-~` alone.
 */
export function credentialFileName(email: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(email)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~@]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `${out}.json`;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  scopes: string[];
}

/**
 * A token in the shape workspace-mcp's `LocalDirectoryCredentialStore` reads
 * (google-auth `Credentials` fields). `expiry` is naive UTC ISO, as it writes
 * it. The sidecar refreshes the access token itself and rewrites this file.
 */
export function renderCredentialFile(settings: GoogleSettings, tokens: GoogleTokenSet): string {
  const expiry = new Date(tokens.expiresAt).toISOString().replace(/Z$/, "");
  return `${JSON.stringify(
    {
      token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_uri: GOOGLE_TOKEN_URI,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      scopes: tokens.scopes,
      expiry,
    },
    null,
    2,
  )}\n`;
}

/** What the browser sees: the secret is reduced to whether one is set. */
export interface PublicGoogleSettings {
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  /**
   * Where the live client came from. `env` means `GOOGLE_CLIENT_ID` in the
   * environment — the same client `SIGNIN=google` signs in with — and the fields
   * below are then read-only in the UI rather than a second answer.
   */
  clientSource: GoogleClientSource;
  permissions: GooglePermissions;
  grant: GoogleGrant | null;
  effective: GooglePermissions;
  serving: boolean;
  needsReconnect: boolean;
}

type GoogleClientSource = "env" | "stored";

export function toPublicGoogleSettings(
  settings: GoogleSettings,
  clientSource: GoogleClientSource = "stored",
): PublicGoogleSettings {
  return {
    enabled: settings.enabled,
    clientId: settings.clientId,
    hasClientSecret: settings.clientSecret !== null,
    clientSource,
    permissions: settings.permissions,
    grant: settings.grant,
    effective: effectivePermissions(settings),
    serving: isServing(settings),
    needsReconnect: needsReconnect(settings),
  };
}
