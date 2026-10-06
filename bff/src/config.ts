export interface BffConfig {
  port: number;
  /**
   * "local" (default) — no Cloudflare configuration needed, reachable
   * directly on the LAN; sign-in is DEV_BYPASS_EMAIL or nothing.
   * "cloudflared" — Cloudflare Access is the gate; set via
   * `LETTA_MODE`, itself a pass-through of Compose's own
   * `COMPOSE_PROFILES` (see docker/compose.yml), so the one setting that
   * decides whether the `cloudflared` container even exists is the same
   * one the app reads.
   */
  mode: "local" | "cloudflared";
  /** App-server WebSocket base URL, e.g. ws://letta:4500 */
  appServerUrl: string;
  /** Absolute public origin of this BFF. */
  publicOrigin: string;
  /** The `<team>` in `https://<team>.cloudflareaccess.com`. */
  cfAccessTeamDomain: string;
  /** The Access Application's Audience (AUD) tag. */
  cfAccessAud: string;
  /** Explicit issuer override — see `auth/cf-access.ts` for why this exists. */
  cfAccessIssuer: string | null;
  sessionSecret: string;
  sessionTtlSeconds: number;
  /**
   * Lower-cased addresses permitted to hold a session. In cloudflared mode this
   * is a defense-in-depth mirror of the Cloudflare Access policy — Access is
   * the gate, and this is what still stands if that policy is ever
   * misconfigured (a bypass rule, "everyone in the directory"). It stays a
   * LIST, not a single address, precisely because the policy it mirrors is one.
   *
   * "Single-user" in this project means no per-user isolation — one runtime,
   * every socket sees every event — not that only one address may sign in.
   */
  allowedUsers: string[];
  /** Total frames retained for session resume across all conversations. */
  frameBufferSize: number;
  /**
   * How long SIGTERM waits for in-flight turns before closing the upstream
   * connection (see `shutdown.ts`). Must stay below the container's
   * `stop_grace_period`, or Docker's SIGKILL ends the drain first.
   */
  shutdownDrainTimeoutMs: number;
  /** Set for local development: skips Cloudflare Access and signs in as this email. */
  devBypassEmail: string | null;
  /** Explicit opt-in to serving the bypass beyond the local machine. */
  devBypassAllowRemote: boolean;
  /**
   * Push is fully optional and self-gating: null unless all three VAPID
   * settings are present, so a plain local dev run needs no push setup at
   * all. Callers check `config.push !== null` before wiring up push routes.
   */
  push: PushConfig | null;
  /** Pinned and archived agents (`agents/id-list.ts`), on the `bff-data` volume. */
  pinnedAgentsFile: string;
  archivedAgentsFile: string;
  /** Per-agent Codex and Google access (`agents/tool-access.ts`), on the `bff-data` volume. */
  agentToolAccessFile: string;
  /**
   * Remote pi worker (`pi/`): settings + private key + captured run streams,
   * all on the `bff-data` volume under one directory. None of it ever crosses
   * the upstream connection — the BFF itself is the ssh client here.
   */
  piDir: string;
  /**
   * Declared model capabilities (`providers/store.ts`), on the `bff-data`
   * volume: vision/thinking/real windows for models behind endpoints that
   * report none. Drives the providers mod.
   */
  modelCapsFile: string;
  /**
   * Backends of the agents' native `web_search` / `fetch_webpage` tools (see
   * `web-tools/`): SearXNG answers searches, ddg-mcp reads pages and is the
   * search fallback. Null switches that backend off.
   */
  webTools: { searxngUrl: string | null; ddgMcpUrl: string | null };
  /** Settings → Google — see `google/settings.ts`. */
  google: GoogleConfig;
  /**
   * Which integrations this deployment offers at all, from the tokens in
   * `COMPOSE_PROFILES` (passed through as `LETTA_MODE`): `web`⇐`search`,
   * `google`⇐`google`, and the two VIRTUAL coding tokens `codex` and `claude`
   * — profiles no service declares, which exist to decide the app-server
   * image's install (see `docker/codex/Dockerfile`) and, here, which Settings
   * sections exist and which integrations the BFF will switch on. A stored
   * Settings switch is only honoured when its feature is on: effective-enabled
   * is token AND switch, enforced at every availability decision.
   */
  features: FeatureFlags;
}

/** The profile-gated integrations. See `BffConfig.features`. */
export interface FeatureFlags {
  web: boolean;
  google: boolean;
  codex: boolean;
  claude: boolean;
  /** Virtual token like codex/claude, but BFF-side only: no image involvement. */
  pi: boolean;
}

export interface GoogleConfig {
  /** The BFF's mount of the `google-policy` volume. */
  policyDir: string;
  /** The BFF's mount of the `google-creds` volume. */
  credsDir: string;
  /** The sidecar's MCP endpoint, as agents reach it; what goes into the shared list. */
  mcpUrl: string;
  /** Must match a redirect URI on the OAuth client exactly. */
  redirectUri: string;
  /**
   * Whether a dev-bypass session may change Google access. Off by default:
   * agent shells share the BFF's network namespace, so in dev-bypass mode an
   * agent can `curl 127.0.0.1:8080/auth/dev-login` and hold a session of its
   * own. Only Cloudflare Access proves a human is asking.
   */
  allowDevBypass: boolean;
}

/** Whether this deployment lets a signed-in session change Google access. */
export function googleWritesAllowed(config: BffConfig): boolean {
  return config.devBypassEmail === null || config.google.allowDevBypass;
}

export interface PushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** The address in the VAPID `sub` claim — a bare email, no scheme. */
  vapidContactEmail: string;
  subscriptionsFile: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

/**
 * Minimum length for `SESSION_SECRET`, in characters.
 *
 * The secret is the only thing standing between an unauthenticated network
 * position and a forged session for an allowlisted address: HMAC-SHA256 over
 * `{email, exp}`, and the server trusts whatever verifies. A short or
 * low-entropy secret is therefore brute-forceable offline, and once recovered
 * it forges sessions for as long as it stays in place — there is no
 * server-side session store to invalidate against.
 *
 * 32 characters is the floor, not the recommendation. `openssl rand -hex 32`
 * (64 chars) clears it comfortably; a 32-char value is only acceptable if it
 * is genuinely random, which the checks below try to catch for the obvious
 * cases.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Reject the secrets that are long enough to pass a length check but carry
 * almost no entropy: one character repeated, or a short pattern tiled to fill.
 *
 * Deliberately narrow. Anything stricter starts rejecting legitimate random
 * secrets and turns a security control into a support burden — the same trap
 * as an over-eager email regex in `parseAllowedUsers`. The goal is to stop
 * `"aaaaaaaa..."` and tiled placeholders from reaching a deployment unnoticed,
 * not to grade the operator's RNG.
 *
 * Exported for tests; `loadConfig` is the only production caller.
 */
export function assertSessionSecretIsStrong(secret: string): void {
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET is too short (${secret.length} characters, minimum ` +
        `${MIN_SESSION_SECRET_LENGTH}). It signs session cookies, so a guessable ` +
        `value lets anyone forge one for any address in ALLOWED_USERS. ` +
        `Generate a real secret with: openssl rand -hex 32`,
    );
  }

  if (/^(.)\1*$/.test(secret)) {
    throw new Error(
      "SESSION_SECRET is one character repeated, which carries no entropy. " +
        "Generate a real secret with: openssl rand -hex 32",
    );
  }

  // A short pattern tiled to reach the minimum length ("abcabcabc...").
  for (let unitLength = 1; unitLength <= 4; unitLength += 1) {
    if (secret.length % unitLength !== 0) continue;
    const unit = secret.slice(0, unitLength);
    if (unit.repeat(secret.length / unitLength) === secret) {
      throw new Error(
        `SESSION_SECRET is a ${unitLength}-character pattern repeated to fill the ` +
          `minimum length, which carries almost no entropy. Generate a real ` +
          `secret with: openssl rand -hex 32`,
      );
    }
  }
}

/**
 * Parses a comma-separated allowlist, naming `source` in every error so a
 * misconfiguration says which input to go and fix.
 *
 *   a@example.com, b@example.com
 *
 * Addresses are lower-cased and de-duplicated; `isAllowedUser` compares against
 * an already-lowercased address, so normalizing here is what makes a
 * capitalized entry match at all.
 *
 * The `@` check is deliberately the only validation. It catches the realistic
 * failure — a typo'd or truncated env var — at BOOT rather than as an
 * unexplained 403 at sign-in, which is all that would happen otherwise since an
 * address that matches nothing simply never matches. Anything stricter is the
 * classic email-regex trap and would start rejecting valid addresses.
 */
export function parseAllowedUsers(raw: string, source: string): string[] {
  const emails = raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (emails.length === 0) throw new Error(`${source} lists no addresses`);

  const invalid = emails.filter((email) => !email.includes("@"));
  if (invalid.length > 0) {
    throw new Error(
      `${source} contains entries that are not email addresses: ${invalid.join(", ")}`,
    );
  }

  return [...new Set(emails)];
}

/**
 * The allowlist comes from the environment and nowhere else — there is no file.
 *
 * In local mode DEV_BYPASS_EMAIL *is* the whole configuration, so it implies
 * its own entry. Requiring both used to mean two settings naming the same
 * person that could only ever disagree with each other, and when they did the
 * result was a 403 saying the bypass email was not in the allowlist — a
 * self-contradiction rather than a diagnosis.
 *
 * With neither set the list is empty and nobody can sign in, which is the
 * documented safe default rather than an error.
 */
function readAllowedUsers(accessIsTheGate: boolean, devBypassEmail: string | null): string[] {
  const inline = process.env.ALLOWED_USERS?.trim();
  if (inline) return parseAllowedUsers(inline, "ALLOWED_USERS");

  if (accessIsTheGate) {
    throw new Error(
      "Missing required environment variable ALLOWED_USERS. Cloudflare Access is the gate in " +
        "this mode, and this list is the check that still stands if that policy is ever " +
        "misconfigured — so it cannot be inferred. Set it to a comma-separated list of the " +
        "same addresses the Access policy allows.",
    );
  }

  return devBypassEmail ? [devBypassEmail.toLowerCase()] : [];
}

function isLoopbackOrigin(publicOrigin: string): boolean {
  let host: string;
  try {
    host = new URL(publicOrigin).hostname;
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid URL: ${publicOrigin}`);
  }
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/**
 * The dev bypass issues a session to anyone who asks. Exposing it beyond the
 * local machine means anyone who can reach the port is the configured user, so
 * that requires a second, explicit opt-in: a stale DEV_BYPASS_EMAIL alone can
 * never open the server to the network.
 */
function assertBypassIsSafe(
  devBypassEmail: string,
  publicOrigin: string,
  allowRemote: boolean,
): void {
  if (isLoopbackOrigin(publicOrigin) || allowRemote) return;

  throw new Error(
    `Refusing to start: DEV_BYPASS_EMAIL is set (${devBypassEmail}) but PUBLIC_ORIGIN ` +
      `(${publicOrigin}) is reachable from other machines. The bypass authenticates ` +
      `nobody — anyone who can reach this port would get a session as ${devBypassEmail}. ` +
      `Set PUBLIC_ORIGIN to a loopback address, or unset DEV_BYPASS_EMAIL and configure ` +
      `CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD. To knowingly expose unauthenticated ` +
      `access on this network anyway, set DEV_BYPASS_ALLOW_REMOTE=true.`,
  );
}

/**
 * `LETTA_MODE` is a pass-through of Compose's own `COMPOSE_PROFILES` (see
 * docker/compose.yml) — the same comma-separated profile list decides which
 * containers exist, which coding CLIs the app-server image installed, and
 * which integrations the app offers.
 */
function profileList(): string {
  return process.env.LETTA_MODE?.trim() ?? "";
}

/**
 * Whether a profile list carries `name` as a whole comma-delimited token:
 * `search` matches `cloudflared,search,google` but not `searchy` and not
 * `research`. Exact tokens matter because the list is one shared namespace —
 * a profile named for a sidecar, a virtual coding token, and whatever someone
 * adds next all live in the same string.
 *
 * Exported for tests; `readMode` and `readFeatures` are the only production
 * callers.
 */
export function hasProfile(profiles: string, name: string): boolean {
  return profiles.split(",").some((token) => token.trim() === name);
}

function readMode(): "local" | "cloudflared" {
  return hasProfile(profileList(), "cloudflared") ? "cloudflared" : "local";
}

/**
 * The feature flags, one per gated integration. `web` rides on the `search`
 * token because that token is what makes SearXNG and ddg-mcp exist — the web
 * tools have nothing to call without them. `codex` and `claude` are virtual
 * tokens: no container declares them, and the same tokens decide whether the
 * CLIs are baked into the app-server image.
 */
function readFeatures(): FeatureFlags {
  const profiles = profileList();
  return {
    web: hasProfile(profiles, "search"),
    google: hasProfile(profiles, "google"),
    codex: hasProfile(profiles, "codex"),
    claude: hasProfile(profiles, "claude"),
    pi: hasProfile(profiles, "pi"),
  };
}

/**
 * The features that are on, by name — what the boot log prints as `Features:`.
 *
 * Derived from the flag record rather than a hand-written list of names:
 * `pi` was absent from that list, so the one line an operator reads to confirm
 * a compose token landed claimed the token was off while `config.features.pi`
 * was true. A new flag now shows up here without anyone remembering to say so.
 */
export function enabledFeatureNames(features: FeatureFlags): string[] {
  return Object.entries(features)
    .filter(([, on]) => on)
    .map(([name]) => name);
}

/** `SESSION_SECRET`, read and checked in one place so no path skips the floor. */
function readSessionSecret(): string {
  const secret = required("SESSION_SECRET");
  assertSessionSecretIsStrong(secret);
  return secret;
}

export function loadConfig(): BffConfig {
  const mode = readMode();
  const devBypassEmail = process.env.DEV_BYPASS_EMAIL?.trim() || null;
  const devBypassAllowRemote = process.env.DEV_BYPASS_ALLOW_REMOTE?.trim() === "true";
  const publicOrigin = required("PUBLIC_ORIGIN").replace(/\/$/, "");
  if (devBypassEmail) {
    assertBypassIsSafe(devBypassEmail, publicOrigin, devBypassAllowRemote);
  }
  // Cloudflare Access credentials are only needed in cloudflared mode, and
  // not even then if the dev bypass is active. Local mode never reads them.
  // The allowlist keys off the same condition: it is required exactly when
  // Access is the thing actually signing people in.
  const needsCfAccess = mode === "cloudflared" && !devBypassEmail;
  return {
    mode,
    port: optionalNumber("PORT", 8080),
    appServerUrl: required("LETTA_APP_SERVER_URL"),
    publicOrigin,
    cfAccessTeamDomain: needsCfAccess
      ? required("CF_ACCESS_TEAM_DOMAIN")
      : (process.env.CF_ACCESS_TEAM_DOMAIN ?? ""),
    cfAccessAud: needsCfAccess ? required("CF_ACCESS_AUD") : (process.env.CF_ACCESS_AUD ?? ""),
    cfAccessIssuer: process.env.CF_ACCESS_ISSUER?.trim() || null,
    sessionSecret: readSessionSecret(),
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    allowedUsers: readAllowedUsers(needsCfAccess, devBypassEmail),
    frameBufferSize: optionalNumber("FRAME_BUFFER_SIZE", 5000),
    // 9 min: under `stop_grace_period` (10m), and drain + image build under
    // Dockhand's 900 s `compose up` timeout — see docker/compose.yml.
    shutdownDrainTimeoutMs: optionalNumber("SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 9 * 60) * 1000,
    devBypassEmail,
    devBypassAllowRemote,
    push: readPushConfig(),
    pinnedAgentsFile: process.env.PINNED_AGENTS_FILE?.trim() || "/app/data/pinned-agents.json",
    archivedAgentsFile:
      process.env.ARCHIVED_AGENTS_FILE?.trim() || "/app/data/archived-agents.json",
    agentToolAccessFile:
      process.env.AGENT_TOOL_ACCESS_FILE?.trim() || "/app/data/agent-tool-access.json",
    piDir: process.env.PI_DIR?.trim() || "/app/data/pi",
    modelCapsFile: process.env.MODEL_CAPS_FILE?.trim() || "/app/data/vision-models.json",
    webTools: {
      searxngUrl: process.env.SEARXNG_URL?.trim() || null,
      ddgMcpUrl: process.env.DDG_MCP_URL?.trim() || null,
    },
    google: {
      policyDir: process.env.GOOGLE_POLICY_DIR?.trim() || "/app/google/policy",
      credsDir: process.env.GOOGLE_CREDS_DIR?.trim() || "/app/google/creds",
      mcpUrl: process.env.GOOGLE_MCP_URL?.trim() || "http://google-mcp:8000/mcp",
      redirectUri:
        process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
        `${publicOrigin}/api/google/oauth/callback`,
      allowDevBypass: process.env.GOOGLE_ALLOW_DEV_BYPASS?.trim() === "true",
    },
    features: readFeatures(),
  };
}

function readPushConfig(): PushConfig | null {
  const vapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY?.trim() || "";
  const vapidPrivateKey = process.env.PUSH_VAPID_PRIVATE_KEY?.trim() || "";
  const vapidContactEmail = process.env.PUSH_VAPID_CONTACT_EMAIL?.trim() || "";
  if (!vapidPublicKey || !vapidPrivateKey || !vapidContactEmail) return null;

  return {
    vapidPublicKey,
    vapidPrivateKey,
    vapidContactEmail,
    subscriptionsFile:
      process.env.PUSH_SUBSCRIPTIONS_FILE?.trim() || "/app/data/push-subscriptions.json",
  };
}

export function isAllowedUser(config: BffConfig, email: string): boolean {
  return config.allowedUsers.includes(email.trim().toLowerCase());
}
