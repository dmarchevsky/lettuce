export interface BffConfig {
  port: number;
  /**
   * How this instance is reached: `lan` (the published port is the way in) or
   * `cloudflared` (a tunnel is). Set by `ACCESS`, which must agree with the
   * `cloudflared` token in `COMPOSE_PROFILES` — the variable is what the app
   * believes and the token is the container that makes it true, so either half
   * missing is a boot error (`readAccess`).
   *
   * It used to be inferred from that token, which is how "where is it reachable
   * from" and "who signs in" ended up being the same setting.
   */
  access: Access;
  /**
   * How a visitor proves they are the owner: `none` (a machine-local instance),
   * `password`, `cf-access` (Cloudflare Access's signature-verified JWT email),
   * or `google` (our own Google OAuth client). Exactly one, because `SIGNIN` is
   * one value rather than a list a deployment can contradict itself with.
   */
  signin: Signin;
  /**
   * The host interface Compose publishes our port on (`BFF_BIND`). The BFF
   * cannot see the host side of a published port, so compose hands the value
   * over and `assertSigninIsSafe` is what reads it: the two combinations that
   * need a closed door cannot ask Compose to derive that default.
   */
  hostBind: string;
  /** App-server WebSocket base URL, e.g. ws://letta:4500 */
  appServerUrl: string;
  /**
   * The capability token the app-server demands on the WebSocket upgrade, when it
   * was started with `--ws-auth` (`LETTA_APP_SERVER_TOKEN`). `null` when unset or
   * blank, and it must stay `null` rather than `""` — upstream's client throws on
   * an empty token ("app-server auth token must not be empty").
   *
   * Unset is the container's own shape and the recommendation: there the BFF joins
   * the app-server's network namespace and reaches it on loopback with no auth, so
   * nothing to send. It exists for a BFF pointed at an app-server on another host,
   * which is a reduced deployment, not a supported one — see
   * `docs/CONFIGURATION.md` ("Remote app-server") and `remoteAppServerNotice`.
   */
  appServerToken: string | null;
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
   * The addresses permitted to hold a session. Only the two methods that get an
   * address from somewhere consult it (`cf-access`, `google`), and it is
   * required exactly then: under `cf-access` it is a defense-in-depth mirror of
   * the Cloudflare Access policy — Access is the gate, and this is what still
   * stands if that policy is ever misconfigured (a bypass rule, "everyone in the
   * directory") — while under `google` it is the only gate there is.
   *
   * `password` and `none` involve no address, so setting it for them is a boot
   * warning rather than a second knob. It stays a LIST, not a single address,
   * because the policy it mirrors is one.
   *
   * "Single-user" in this project means no per-user isolation — one runtime,
   * every socket sees every event — not that only one address may sign in.
   */
  allowedUsers: string[];
  /** Total frames retained for session resume across all conversations. */
  frameBufferSize: number;
  /**
   * Whether the BFF answers a repeat `runtime_start` from what it already knows
   * instead of forwarding it (see `session/runtime-start-cache.ts`). On unless
   * `RUNTIME_START_CACHE=off`, which puts every conversation open back through
   * the app-server's state replay — seconds of whole-server stall each time on
   * a slow disk.
   */
  runtimeStartCache: boolean;
  /**
   * How long SIGTERM waits for in-flight turns before closing the upstream
   * connection (see `shutdown.ts`). Must stay below the container's
   * `stop_grace_period`, or Docker's SIGKILL ends the drain first.
   */
  shutdownDrainTimeoutMs: number;
  /**
   * Push is fully optional and self-gating: null unless all three VAPID
   * settings are present, so a plain local dev run needs no push setup at
   * all. Callers check `config.push !== null` before wiring up push routes.
   */
  push: PushConfig | null;
  /**
   * Where the sign-in password's scrypt hash lives (`auth/password.ts`), on the
   * `bff-auth` volume. Never under `LETTA_STATE_DIR`: agent shells run as uid 0
   * in the app-server, which mounts that whole tree read-write, so a hash there
   * is an offline crack target — the same reason `google-creds` is a volume.
   */
  signinDir: string;
  /** Pinned and archived agents (`agents/id-list.ts`), on the `bff-data` volume. */
  pinnedAgentsFile: string;
  archivedAgentsFile: string;
  /** Per-agent Codex and Google access (`agents/tool-access.ts`), on the `bff-data` volume. */
  agentToolAccessFile: string;
  /** Per-agent avatar choices (`agents/avatar-prefs.ts`), on the `bff-data` volume. */
  avatarPrefsFile: string;
  /**
   * Uploaded faces, one file per face named for its hash (`agents/avatar-library.ts`),
   * on the `bff-data` volume. The directory *is* the index, and it is created on
   * first upload — a missing one means no faces, never a BFF that will not boot.
   */
  avatarImageDir: string;
  /** Recently chosen glyphs (`agents/avatar-library.ts`), same volume, same reason. */
  avatarRecentsFile: string;
  /**
   * Last finished turn per conversation (`session/turn-usage.ts`), on the
   * `bff-data` volume, so the context gauge survives a BFF restart instead of
   * reading "—" until the next turn.
   */
  contextUsageFile: string;
  contextSizeFile: string;
  /**
   * Share of the declared context window at which the BFF compacts a
   * conversation itself (`session/context-watchdog.ts`). 0 switches the
   * watchdog off; see that file for why upstream's own trigger is not enough.
   */
  contextWatchdogRatio: number;
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
  /** Settings → Google Workspace — see `google/settings.ts`. */
  google: GoogleConfig;
  /**
   * Which integrations this deployment offers at all, from the tokens in
   * `COMPOSE_PROFILES` (passed through as `LETTA_MODE`): `web`⇐`search`,
   * `google`⇐`google`, `telegram`⇐`telegram` (the real token that creates the
   * `channel-gateway` container), and the two VIRTUAL coding tokens `codex`
   * and `claude` — profiles no service declares, which exist to decide the app-server
   * image's install (see `docker/codex/Dockerfile`) and, here, which Settings
   * sections exist and which integrations the BFF will switch on. A stored
   * Settings switch is only honoured when its feature is on: effective-enabled
   * is token AND switch, enforced at every availability decision.
   */
  features: FeatureFlags;
  /**
   * Image versions for the pieces that cannot report one: a sidecar has no
   * version endpoint and the BFF cannot read Compose, so compose hands over the
   * same literal that picks the tag (docker/compose.yml) and Settings → About
   * shows it. The coding CLIs are measured inside the image instead
   * (`/opt/lettuce/features`), because a stale image disproves a pin.
   */
  pinVersions: { searxng: string; googleMcp: string; cloudflared: string; ddgMcp: string };
}

/** The profile-gated integrations. See `BffConfig.features`. */
export interface FeatureFlags {
  web: boolean;
  google: boolean;
  codex: boolean;
  claude: boolean;
  /** Virtual token like codex/claude, but BFF-side only: no image involvement. */
  pi: boolean;
  /**
   * Real token, like `google`: the `telegram` profile is what creates the
   * `channel-gateway` container (docker/compose.yml), so without it there is
   * no bot to configure and Settings → Telegram hides.
   */
  telegram: boolean;
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
   * The Google OAuth client from the environment. Preferred over the pair typed
   * into Settings → Google Workspace, and the only source `SIGNIN=google` can
   * use: sign-in happens before anybody could have opened Settings. One client
   * serving both flows is deliberate — it lists both redirect URIs, and it means
   * the operator configures Google once.
   */
  envClientId: string;
  envClientSecret: string;
  /**
   * Whether a session that authenticated nobody (`SIGNIN=none`) may change
   * Google access. Off by default: agent shells share the BFF's network
   * namespace, so in that mode an agent can `curl 127.0.0.1:8080/auth/login`
   * and hold a session of its own. Only a real credential proves a human asked.
   */
  allowInsecureSignin: boolean;
}

/** Whether this deployment lets a signed-in session change Google access. */
export function googleWritesAllowed(config: BffConfig): boolean {
  return config.signin !== "none" || config.google.allowInsecureSignin;
}

/**
 * Whether a sign-in method produces an address to match against
 * `ALLOWED_USERS`. `password` and `none` have one owner and no address at all.
 */
export function signinHasAddress(signin: Signin): boolean {
  return signin === "cf-access" || signin === "google";
}

/** One line per method, for the boot log and Settings → Sign-in. */
export function signinLabel(signin: Signin): string {
  switch (signin) {
    case "none":
      return "off (this machine only)";
    case "password":
      return "password";
    case "cf-access":
      return "Cloudflare Access";
    case "google":
      return "Google";
  }
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
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

/**
 * A token-shaped setting: trimmed, and absent means `null` rather than `""`.
 * The distinction matters wherever the value is handed to something that rejects
 * a blank string instead of reading it as unset.
 */
function optionalToken(name: string): string | null {
  return process.env[name]?.trim() || null;
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
 * A 0-1 share, where 0 is a value rather than an error: `CONTEXT_WATCHDOG_RATIO=0`
 * is how an operator switches the watchdog off, and a misconfigured BFF that
 * refuses to boot is worse than one that keeps compacting.
 */
function optionalShare(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1`);
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
 * It is required exactly when the sign-in method identifies people by address,
 * because that is the only case where "who may hold a session" needs an answer
 * the deployment must give. `password` and `none` have one owner and no address,
 * so an empty list there is correct rather than a locked door.
 *
 * The same reasoning used to key off the deployment's mode; now it keys off the
 * method, which is the thing that actually produces an address.
 */
function readAllowedUsers(signin: Signin): string[] {
  const inline = process.env.ALLOWED_USERS?.trim();
  if (inline) return parseAllowedUsers(inline, "ALLOWED_USERS");

  if (signinHasAddress(signin)) {
    throw new Error(
      `Missing required environment variable ALLOWED_USERS. SIGNIN=${signin} signs people in by ` +
        "address, so the list of who may hold a session cannot be inferred. Set it to a " +
        "comma-separated list of addresses.",
    );
  }

  return [];
}

/** Loopback, in any spelling a host bind takes. */
function isLoopbackBind(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

/**
 * The variables the split replaced. Ignoring one silently would leave an
 * operator believing a door their `.env` no longer controls is open or shut,
 * so their presence is an error that names the replacement. Compose keeps
 * passing `GOOGLE_ALLOW_DEV_BYPASS` for exactly one release so the rename is
 * caught here too, in a container as well as in a bare `bun run dev`.
 */
function assertNoRemovedAuthVariables(): void {
  const removed: [string, string][] = [
    [
      "DEV_BYPASS_EMAIL",
      "SIGNIN=none (machine-local only) or SIGNIN=password (anything on a network)",
    ],
    ["DEV_BYPASS_ALLOW_REMOTE", "BFF_BIND, which stays 127.0.0.1 unless SIGNIN=password"],
    ["GOOGLE_ALLOW_DEV_BYPASS", "GOOGLE_ALLOW_INSECURE_SIGNIN"],
  ];
  for (const [name, replacement] of removed) {
    if (process.env[name]?.trim()) {
      throw new Error(
        `${name} is gone: how the app is reached and how you sign in are set separately now. ` +
          `Set ${replacement} instead.`,
      );
    }
  }
}

/**
 * The combinations that must not run, refused at boot.
 *
 * Compose cannot derive one setting's default from another's value —
 * docker/compose.yml says so out loud about `BFF_BIND` — so the pairings that
 * keep an unauthenticated instance machine-local, and a tunnel's origin reachable
 * only through the tunnel, are checked here instead of documented and hoped for.
 */
function assertSigninIsSafe(config: { signin: Signin; access: Access; hostBind: string }): void {
  const { signin, access, hostBind } = config;

  if (access === "cloudflared" && !isLoopbackBind(hostBind)) {
    throw new Error(
      `ACCESS=cloudflared but BFF_BIND is ${hostBind}. The tunnel reaches the BFF over Docker's own ` +
        "network, so a wide published port is a second way in that nothing guards — set " +
        "BFF_BIND=127.0.0.1 (the default) and reach the app through the tunnel.",
    );
  }

  if (signin === "cf-access" && access !== "cloudflared") {
    throw new Error(
      "SIGNIN=cf-access but this instance is not reached through a Cloudflare Tunnel, so no " +
        "Cf-Access-Jwt-Assertion header can ever arrive and nobody would be able to sign in. Set " +
        "ACCESS=cloudflared (with the `cloudflared` profile token), or choose another method.",
    );
  }

  if (signin === "none" && access === "cloudflared") {
    throw new Error(
      "SIGNIN=none behind a Cloudflare Tunnel puts the app on a public hostname with nothing in " +
        "front of it: the tunnel forwards requests with no credential asked for. A tunnel plus " +
        "SIGNIN=password is a fine public deployment, as is an Access policy with SIGNIN=cf-access " +
        "— pick one, or run the instance with ACCESS=lan.",
    );
  }

  if (signin === "none" && !isLoopbackBind(hostBind)) {
    throw new Error(
      `SIGNIN=none authenticates nobody, but BFF_BIND is ${hostBind}: anyone who can reach this ` +
        "port is the owner, with your shell, files and integrations. Keep it machine-local with " +
        "BFF_BIND=127.0.0.1, or put it on the network with SIGNIN=password.",
    );
  }
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

const ACCESS_VALUES = ["lan", "cloudflared"] as const;
const SIGNIN_VALUES = ["none", "password", "cf-access", "google"] as const;
export type Access = (typeof ACCESS_VALUES)[number];
export type Signin = (typeof SIGNIN_VALUES)[number];

/** An env var that must be one of a fixed set — an unrecognised value is a typo, not a default. */
function readEnvOneOf<T extends string>(name: string, allowed: readonly T[]): T | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} is "${raw}", which is not one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * `ACCESS` says how the app is reached; the `cloudflared` profile token is the
 * container that makes that true. Both directions of disagreement are fatal: a
 * `cloudflared` token with `ACCESS=lan` is a live public hostname in front of an
 * app that does not know it is exposed, and the reverse is an app waiting for a
 * tunnel nobody started. Unset derives from the token, so an install predating
 * this variable needs no new line in `docker/.env`.
 */
function readAccess(): Access {
  const tunnel = hasProfile(profileList(), "cloudflared");
  const access = readEnvOneOf("ACCESS", ACCESS_VALUES) ?? (tunnel ? "cloudflared" : "lan");

  if (access === "cloudflared" && !tunnel) {
    throw new Error(
      "ACCESS=cloudflared but COMPOSE_PROFILES has no `cloudflared` token, so no tunnel exists to " +
        "serve it. Add the token — it is what creates the tunnel container — or set ACCESS=lan.",
    );
  }
  if (access === "lan" && tunnel) {
    throw new Error(
      "COMPOSE_PROFILES creates the cloudflared tunnel but ACCESS=lan, which leaves the app " +
        "unaware that a public hostname points at it. Set ACCESS=cloudflared, or drop the token " +
        "to keep the instance LAN-only.",
    );
  }
  return access;
}

/**
 * Unset keeps a pre-split deployment's behaviour: behind a tunnel, Access was the
 * gate; without one, nothing was — which is now an explicit `SIGNIN=none` rather
 * than the default, so a fresh LAN install asks for a password instead.
 */
function readSignin(access: Access): Signin {
  return (
    readEnvOneOf("SIGNIN", SIGNIN_VALUES) ?? (access === "cloudflared" ? "cf-access" : "password")
  );
}

/**
 * The feature flags, one per gated integration. `web` rides on the `search`
 * token because that token is what makes SearXNG and ddg-mcp exist — the web
 * tools have nothing to call without them. `codex` and `claude` are virtual
 * tokens: no container declares them, and the same tokens decide whether the
 * CLIs are baked into the app-server image. `telegram` is a real one: the
 * token creates the `channel-gateway` container the channel runs in.
 */
function readFeatures(): FeatureFlags {
  const profiles = profileList();
  return {
    web: hasProfile(profiles, "search"),
    google: hasProfile(profiles, "google"),
    codex: hasProfile(profiles, "codex"),
    claude: hasProfile(profiles, "claude"),
    pi: hasProfile(profiles, "pi"),
    telegram: hasProfile(profiles, "telegram"),
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
  assertNoRemovedAuthVariables();
  const access = readAccess();
  const signin = readSignin(access);
  const hostBind = process.env.LETTA_HOST_BIND?.trim() || "127.0.0.1";
  const publicOrigin = required("PUBLIC_ORIGIN").replace(/\/$/, "");
  assertSigninIsSafe({ signin, access, hostBind });

  // The Access connection details are only needed by the method that reads the
  // header Cloudflare writes, and the Google client pair only by the method that
  // redirects to Google. Required exactly then, so a deployment is not asked for
  // credentials it has no use for.
  const needsCfAccess = signin === "cf-access";
  const googleEnvClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleEnvClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (signin === "google" && (!googleEnvClientId || !googleEnvClientSecret)) {
    throw new Error(
      "SIGNIN=google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. They cannot come from " +
        "Settings → Google Workspace, because signing in happens before anybody could have opened " +
        "Settings — and an instance that signs nobody in until a click is not one you can reach. " +
        "The same client Settings → Google Workspace uses is fine; it just has to be in " +
        "docker/.env, with this origin added as an authorised redirect URI.",
    );
  }

  return {
    access,
    signin,
    hostBind,
    port: optionalNumber("PORT", 8080),
    appServerUrl: required("LETTA_APP_SERVER_URL"),
    appServerToken: optionalToken("LETTA_APP_SERVER_TOKEN"),
    publicOrigin,
    cfAccessTeamDomain: needsCfAccess
      ? required("CF_ACCESS_TEAM_DOMAIN")
      : (process.env.CF_ACCESS_TEAM_DOMAIN ?? ""),
    cfAccessAud: needsCfAccess ? required("CF_ACCESS_AUD") : (process.env.CF_ACCESS_AUD ?? ""),
    cfAccessIssuer: process.env.CF_ACCESS_ISSUER?.trim() || null,
    sessionSecret: readSessionSecret(),
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    allowedUsers: readAllowedUsers(signin),
    frameBufferSize: optionalNumber("FRAME_BUFFER_SIZE", 5000),
    runtimeStartCache: process.env.RUNTIME_START_CACHE?.trim() !== "off",
    // 9 min: under `stop_grace_period` (10m), and drain + image build under
    // the prod deploy manager's 900 s `compose up` timeout — see docker/compose.yml.
    shutdownDrainTimeoutMs: optionalNumber("SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 9 * 60) * 1000,
    push: readPushConfig(),
    signinDir: process.env.SIGNIN_DIR?.trim() || "/app/auth",
    pinnedAgentsFile: process.env.PINNED_AGENTS_FILE?.trim() || "/app/data/pinned-agents.json",
    archivedAgentsFile:
      process.env.ARCHIVED_AGENTS_FILE?.trim() || "/app/data/archived-agents.json",
    agentToolAccessFile:
      process.env.AGENT_TOOL_ACCESS_FILE?.trim() || "/app/data/agent-tool-access.json",
    avatarPrefsFile: process.env.AVATAR_PREFS_FILE?.trim() || "/app/data/avatar-prefs.json",
    avatarImageDir: process.env.AVATAR_IMAGE_DIR?.trim() || "/app/data/avatars",
    avatarRecentsFile: process.env.AVATAR_RECENTS_FILE?.trim() || "/app/data/avatar-recents.json",
    contextUsageFile: process.env.CONTEXT_USAGE_FILE?.trim() || "/app/data/context-usage.json",
    contextSizeFile: process.env.CONTEXT_SIZE_FILE?.trim() || "/app/data/context-size.json",
    // 0.9 = earlier than letta-code's own trigger; 0 turns it off. See
    // session/context-watchdog.ts.
    contextWatchdogRatio: optionalShare("CONTEXT_WATCHDOG_RATIO", 0.9),
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
      envClientId: googleEnvClientId,
      envClientSecret: googleEnvClientSecret,
      allowInsecureSignin: process.env.GOOGLE_ALLOW_INSECURE_SIGNIN?.trim() === "true",
    },
    features: readFeatures(),
    pinVersions: {
      searxng: process.env.SEARXNG_VERSION?.trim() ?? "",
      googleMcp: process.env.WORKSPACE_MCP_VERSION?.trim() ?? "",
      cloudflared: process.env.CLOUDFLARED_VERSION?.trim() ?? "",
      ddgMcp: process.env.DDG_MCP_VERSION?.trim() ?? "",
    },
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
