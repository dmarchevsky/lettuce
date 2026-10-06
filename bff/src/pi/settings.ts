/**
 * Settings → Remote pi worker: where the agent reaches a pi installed on
 * another host, over SSH only.
 *
 * Unlike Codex and Claude workers, nothing runs inside the app-server for this
 * integration: the BFF itself shells out to `ssh` (see `runner.ts`), so the
 * settings live on the BFF's own `bff-data` volume and never cross the upstream
 * connection. The browser sees `PublicPiSettings`: in `stored_key` mode the key
 * is reduced to whether one is set, exactly like the Codex `apiKey` precedent;
 * in `ssh_agent` mode (the default) there is no key to store at all — an
 * ssh-agent on the BFF host signs, and lettuce holds zero secret material.
 *
 * `pathPrepend` is not cosmetic: a non-interactive remote shell gets a minimal
 * PATH that usually misses pi and node entirely (spike finding,
 * docs/remote-pi-plan.md § 3.1), so the dispatch command carries a PATH
 * prefix.
 */

/** How ssh gets its identity: an agent signs, or lettuce stores the PEM itself. */
export type PiAuthMode = "ssh_agent" | "stored_key";

export interface PiSettings {
  /** Whether the pi tools exist at all (the `pi` profile token must also be on). */
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** `ssh_agent` (default): nothing is stored here; `stored_key`: PEM below. */
  authMode: PiAuthMode;
  /**
   * ssh-agent socket path for `ssh_agent` mode; null means inherit the BFF
   * process's own `SSH_AUTH_SOCK`.
   */
  identityAgent: string | null;
  /** Private key in PEM text form. `stored_key` mode only. Never returned to a browser. */
  privateKey: string | null;
  /** Prepended to PATH in every remote command, e.g. `/opt/node/bin:/opt/pi/bin`. */
  pathPrepend: string;
  /** Absolute directory pi runs in on the remote host. */
  workdir: string;
  /** Optional pi model id; null lets the remote pi use its own default. */
  model: string | null;
}

/** What the browser sees: the key is reduced to whether one is set. */
export type PublicPiSettings = Omit<PiSettings, "privateKey"> & { hasKey: boolean };

export const DEFAULT_PI_SETTINGS: PiSettings = {
  enabled: false,
  host: "",
  port: 22,
  user: "",
  authMode: "ssh_agent",
  identityAgent: null,
  privateKey: null,
  pathPrepend: "",
  workdir: "",
  model: null,
};

export class InvalidPiSettingsError extends Error {}

export function toPublicPiSettings(settings: PiSettings): PublicPiSettings {
  const { privateKey, ...rest } = settings;
  return { ...rest, hasKey: privateKey !== null };
}

/** Lenient: a missing, hand-edited or older file still loads, with defaults filling gaps. */
export function parsePiSettings(text: string | null): PiSettings {
  if (!text) return { ...DEFAULT_PI_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_PI_SETTINGS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PI_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    host: typeof r.host === "string" ? r.host : "",
    port: typeof r.port === "number" && r.port >= 1 && r.port <= 65535 ? r.port : 22,
    user: typeof r.user === "string" ? r.user : "",
    authMode: r.authMode === "stored_key" ? "stored_key" : "ssh_agent",
    identityAgent: typeof r.identityAgent === "string" && r.identityAgent ? r.identityAgent : null,
    privateKey: typeof r.privateKey === "string" && r.privateKey ? r.privateKey : null,
    pathPrepend: typeof r.pathPrepend === "string" ? r.pathPrepend : "",
    workdir: typeof r.workdir === "string" ? r.workdir : "",
    model: typeof r.model === "string" && r.model ? r.model : null,
  };
}

export function renderPiSettings(settings: PiSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Merge a browser update into the saved settings. `privateKey` is only
 * replaced when the body carries a non-empty string — an absent or empty one
 * keeps the stored key, so the form can show `hasKey` without holding the key.
 * Throws InvalidPiSettingsError on anything unusable.
 */
export function applyPiSettingsUpdate(current: PiSettings, body: unknown): PiSettings {
  if (!body || typeof body !== "object") throw new InvalidPiSettingsError("Expected a JSON object");
  const r = body as Record<string, unknown>;

  const next: PiSettings = { ...current };
  if ("enabled" in r) {
    if (typeof r.enabled !== "boolean")
      throw new InvalidPiSettingsError("`enabled` must be true or false");
    next.enabled = r.enabled;
  }
  if (typeof r.host === "string") next.host = r.host.trim();
  if (typeof r.user === "string") next.user = r.user.trim();
  if ("port" in r) {
    const port = Number(r.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InvalidPiSettingsError("`port` must be 1-65535");
    }
    next.port = port;
  }
  if ("pathPrepend" in r) {
    if (typeof r.pathPrepend !== "string")
      throw new InvalidPiSettingsError("`pathPrepend` must be a string");
    next.pathPrepend = r.pathPrepend.trim();
  }
  if ("workdir" in r) {
    if (typeof r.workdir !== "string")
      throw new InvalidPiSettingsError("`workdir` must be a string");
    next.workdir = r.workdir.trim();
  }
  if ("model" in r) {
    if (r.model !== null && typeof r.model !== "string") {
      throw new InvalidPiSettingsError("`model` must be a string or null");
    }
    next.model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : null;
  }
  if ("authMode" in r) {
    if (r.authMode !== "ssh_agent" && r.authMode !== "stored_key") {
      throw new InvalidPiSettingsError("`authMode` must be `ssh_agent` or `stored_key`");
    }
    next.authMode = r.authMode;
  }
  if ("identityAgent" in r) {
    if (r.identityAgent !== null && typeof r.identityAgent !== "string") {
      throw new InvalidPiSettingsError("`identityAgent` must be a socket path or null");
    }
    const sock = typeof r.identityAgent === "string" ? r.identityAgent.trim() : "";
    if (sock && !sock.startsWith("/")) {
      throw new InvalidPiSettingsError("`identityAgent` must be an absolute socket path or empty");
    }
    next.identityAgent = sock ? sock : null;
  }
  if (typeof r.privateKey === "string" && r.privateKey.trim()) {
    const key = r.privateKey.trimEnd();
    if (!key.startsWith("-----BEGIN")) {
      throw new InvalidPiSettingsError("`privateKey` must be a PEM private key (-----BEGIN …)");
    }
    next.privateKey = `${key}\n`;
    // A pasted PEM implies stored_key — nobody stores a key they do not mean
    // to use. An explicit `authMode` in the same body wins.
    if (!("authMode" in r)) next.authMode = "stored_key";
  }

  if (next.enabled) {
    if (!next.host)
      throw new InvalidPiSettingsError("`host` is required to enable the remote pi worker");
    if (!next.user)
      throw new InvalidPiSettingsError("`user` is required to enable the remote pi worker");
    if (!next.workdir.startsWith("/")) {
      throw new InvalidPiSettingsError("`workdir` must be an absolute path on the remote host");
    }
    if (next.authMode === "stored_key" && !next.privateKey) {
      throw new InvalidPiSettingsError("a `privateKey` is required when auth mode is `stored_key`");
    }
  }
  return next;
}

/** Whether a saved settings blob is complete enough to dispatch runs with. */
export function piConfigured(settings: PiSettings): boolean {
  return (
    settings.enabled &&
    settings.host !== "" &&
    settings.user !== "" &&
    settings.workdir.startsWith("/") &&
    (settings.authMode === "ssh_agent" || settings.privateKey !== null)
  );
}

/** `user@host`, port implicit when 22 (ssh's own default). */
export function piTarget(settings: PiSettings): string {
  return `${settings.user}@${settings.host}`;
}
