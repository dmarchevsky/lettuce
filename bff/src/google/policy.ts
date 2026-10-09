/**
 * Settings → Google: which Google services agents may use, and how far.
 *
 * Agents reach Gmail, Calendar, Tasks and Contacts through the `google-mcp`
 * sidecar (docker/google-mcp), a pinned workspace-mcp run with `--permissions`.
 * The levels below are workspace-mcp's own (auth/permissions.py), and so is the
 * level → OAuth scope table: the sidecar filters its tools by the scopes a
 * level implies, and the BFF asks Google for exactly those scopes. That makes
 * the policy hold in two places an agent cannot reach — the token itself
 * (Google refuses anything outside its scopes) and the sidecar's tool list —
 * which is the whole point: agent shells can write everything in the
 * app-server container, so nothing that decides access may live there.
 *
 * Levels are cumulative, lowest first. `null` means the service is off.
 */

export const GOOGLE_SERVICES = ["gmail", "calendar", "tasks", "contacts"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

const G = "https://www.googleapis.com/auth/";

/**
 * workspace-mcp 2.1.0 `SERVICE_PERMISSION_LEVELS`, restricted to the four
 * services exposed here. Each entry lists the scopes that level ADDS. Re-check
 * on every WORKSPACE_MCP_VERSION bump: a drifted table means the sidecar hides
 * tools the token could use, or — worse — offers tools the token cannot.
 */
export const PERMISSION_LEVELS = {
  gmail: [
    ["readonly", [`${G}gmail.readonly`]],
    ["organize", [`${G}gmail.labels`, `${G}gmail.modify`]],
    ["drafts", [`${G}gmail.compose`]],
    ["send", [`${G}gmail.send`]],
    ["full", [`${G}gmail.settings.basic`]],
  ],
  calendar: [
    ["readonly", [`${G}calendar.readonly`]],
    ["full", [`${G}calendar`, `${G}calendar.events`]],
  ],
  tasks: [
    ["readonly", [`${G}tasks.readonly`]],
    // `manage` and `full` hold the same scope; workspace-mcp denies task
    // deletion at `manage` by tool filtering alone (SERVICE_DENIED_ACTIONS).
    ["manage", [`${G}tasks`]],
    ["full", []],
  ],
  contacts: [
    ["readonly", [`${G}contacts.readonly`]],
    ["full", [`${G}contacts`]],
  ],
} as const satisfies Record<GoogleService, readonly (readonly [string, readonly string[]])[]>;

export type GoogleLevel<S extends GoogleService = GoogleService> =
  (typeof PERMISSION_LEVELS)[S][number][0];

/** Per service: its level, or null for off. */
export type GooglePermissions = { [S in GoogleService]: GoogleLevel<S> | null };

export const NO_PERMISSIONS: GooglePermissions = {
  gmail: null,
  calendar: null,
  tasks: null,
  contacts: null,
};

/**
 * Asked for on every consent alongside the service scopes: the account's
 * address is how the token file is named and which account the sidecar acts
 * as. workspace-mcp requests the same three itself.
 */
export const IDENTITY_SCOPES = ["openid", `${G}userinfo.email`, `${G}userinfo.profile`];

export function levelsOf(service: GoogleService): string[] {
  return PERMISSION_LEVELS[service].map(([level]) => level);
}

/** Position of a level in its service's order; -1 for off. */
export function levelRank(service: GoogleService, level: string | null): number {
  return level === null ? -1 : levelsOf(service).indexOf(level);
}

export function isLevel(service: GoogleService, value: unknown): boolean {
  return typeof value === "string" && levelsOf(service).includes(value);
}

/** The cumulative scopes one service needs at one level. */
export function scopesForLevel(service: GoogleService, level: string | null): string[] {
  const rank = levelRank(service, level);
  const scopes: string[] = [];
  PERMISSION_LEVELS[service].forEach(([, added], index) => {
    if (index <= rank) scopes.push(...added);
  });
  return scopes;
}

/** Every scope a consent must ask for: identity plus each enabled service. */
export function scopesForPermissions(permissions: GooglePermissions): string[] {
  const scopes = new Set(IDENTITY_SCOPES);
  for (const service of GOOGLE_SERVICES) {
    for (const scope of scopesForLevel(service, permissions[service])) scopes.add(scope);
  }
  return [...scopes].sort();
}

export function hasAnyService(permissions: GooglePermissions): boolean {
  return GOOGLE_SERVICES.some((service) => permissions[service] !== null);
}

/**
 * What a grant actually allows, capped at what the policy wants: per service,
 * the highest level no higher than `wanted` whose scopes Google granted.
 *
 * Google's consent screen lets the user untick individual scopes, so what was
 * granted can be less than what was asked for — the sidecar must then run at
 * the level the token really covers, or it would list tools that fail.
 */
export function coveredPermissions(
  wanted: GooglePermissions,
  grantedScopes: readonly string[],
): GooglePermissions {
  const granted = new Set(grantedScopes);
  const result: Record<string, string | null> = {};
  for (const service of GOOGLE_SERVICES) {
    let best: string | null = null;
    for (const level of levelsOf(service)) {
      if (levelRank(service, level) > levelRank(service, wanted[service])) break;
      if (scopesForLevel(service, level).every((scope) => granted.has(scope))) best = level;
    }
    result[service] = best;
  }
  return result as GooglePermissions;
}

/** True when `next` allows less than `current` for any service. */
export function narrows(current: GooglePermissions, next: GooglePermissions): boolean {
  return GOOGLE_SERVICES.some(
    (service) => levelRank(service, next[service]) < levelRank(service, current[service]),
  );
}

export function samePermissions(a: GooglePermissions, b: GooglePermissions): boolean {
  return GOOGLE_SERVICES.every((service) => a[service] === b[service]);
}

/** workspace-mcp's `--permissions` arguments, e.g. `["gmail:readonly", "tasks:manage"]`. */
export function permissionArgs(permissions: GooglePermissions): string[] {
  return GOOGLE_SERVICES.filter((service) => permissions[service] !== null).map(
    (service) => `${service}:${permissions[service]}`,
  );
}
