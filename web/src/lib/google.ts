/**
 * Settings → Google Workspace, as the browser sees it. Mirrors `bff/src/google/`; the
 * two packages cannot import from each other.
 */

export const GOOGLE_SERVICES = ["gmail", "calendar", "tasks", "contacts"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

export type GooglePermissions = Record<GoogleService, string | null>;

/** Levels per service, lowest first, with what each one lets an agent do. */
export const GOOGLE_LEVELS: Record<GoogleService, { level: string; label: string }[]> = {
  gmail: [
    { level: "readonly", label: "Read mail" },
    { level: "organize", label: "Read, label, archive, mark read" },
    { level: "drafts", label: "…and write drafts" },
    { level: "send", label: "…and send mail" },
    { level: "full", label: "…and change mail settings and filters" },
  ],
  calendar: [
    { level: "readonly", label: "Read calendars and events" },
    { level: "full", label: "Create, change and delete events" },
  ],
  tasks: [
    { level: "readonly", label: "Read tasks" },
    { level: "manage", label: "Create and update tasks, no deleting" },
    { level: "full", label: "Create, update and delete tasks" },
  ],
  contacts: [
    { level: "readonly", label: "Read contacts" },
    { level: "full", label: "Create, change and delete contacts" },
  ],
};

export const SERVICE_LABELS: Record<GoogleService, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  tasks: "Tasks",
  contacts: "Contacts",
};

export interface GoogleGrant {
  email: string;
  scopes: string[];
  requested: GooglePermissions;
  grantedAt: string;
  /** When Google stopped accepting the token: reconnect needed. */
  lostAt?: string;
}

export interface GoogleSettings {
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  /** Where the client in force comes from: the environment wins over this file. */
  clientSource: "env" | "stored";
  /** What the user chose. */
  permissions: GooglePermissions;
  grant: GoogleGrant | null;
  /** What agents actually get: the choice, capped by what Google granted. */
  effective: GooglePermissions;
  serving: boolean;
  needsReconnect: boolean;
  /** Addresses and `@domain`s Gmail may send to and Calendar may invite; empty: anyone. */
  allowedRecipients: string[];
}

export interface GoogleStatus {
  settings: GoogleSettings;
  sidecarUp: boolean;
  redirectUri: string;
  /** False when this deployment refuses changes (`SIGNIN=none`). */
  writable: boolean;
}

export interface GoogleSettingsUpdate {
  enabled?: boolean;
  clientId?: string;
  /** Absent keeps the stored secret, "" clears it. */
  clientSecret?: string;
  permissions?: Partial<GooglePermissions>;
  allowedRecipients?: string[];
}

export interface GoogleResult {
  settings: GoogleSettings;
  warning: string | null;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchGoogleStatus(): Promise<GoogleStatus> {
  return (await ok(await fetch("/api/google"))).json();
}

export async function saveGoogleSettings(update: GoogleSettingsUpdate): Promise<GoogleResult> {
  const response = await ok(
    await fetch("/api/google", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return response.json();
}

/** Google's consent URL for the saved levels. */
export async function startGoogleConnect(): Promise<string> {
  const response = await ok(await fetch("/api/google/connect", { method: "POST" }));
  return ((await response.json()) as { url: string }).url;
}

export async function disconnectGoogle(): Promise<GoogleResult> {
  return (await ok(await fetch("/api/google/disconnect", { method: "POST" }))).json();
}

export async function verifyGoogle(): Promise<GoogleResult> {
  return (await ok(await fetch("/api/google/verify", { method: "POST" }))).json();
}

/** "gmail.readonly" from "https://www.googleapis.com/auth/gmail.readonly". */
export function shortScope(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}

export function levelLabel(service: GoogleService, level: string | null): string {
  if (level === null) return "Off";
  return GOOGLE_LEVELS[service].find((entry) => entry.level === level)?.label ?? level;
}

/** Whether these levels let an agent reach an address: send mail, or invite to an event. */
export function reachesAddresses(permissions: GooglePermissions): boolean {
  return (
    permissions.gmail === "send" || permissions.gmail === "full" || permissions.calendar === "full"
  );
}

/** The allowed-recipients textarea as the list the BFF stores (it validates the entries). */
export function recipientLines(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "");
  return [...new Set(lines)];
}

/**
 * True when saving `next` drops an OAuth scope `current` needs — the BFF then
 * revokes the token. Tasks `manage` and `full` share one scope (the difference
 * is only which tools the sidecar lists), so moving between them revokes nothing.
 */
export function wouldNarrow(current: GooglePermissions, next: GooglePermissions): boolean {
  const rank = (service: GoogleService, level: string | null) => {
    if (level === null) return -1;
    const effective = service === "tasks" && level === "full" ? "manage" : level;
    return GOOGLE_LEVELS[service].findIndex((entry) => entry.level === effective);
  };
  return GOOGLE_SERVICES.some(
    (service) => rank(service, next[service]) < rank(service, current[service]),
  );
}
