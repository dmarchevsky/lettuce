/**
 * Settings → Google Workspace, end to end: saving the policy, running the consent,
 * keeping the token file and the sidecar's config in step.
 *
 * The invariant everything here maintains: **the token never carries a scope
 * the current policy does not want.** Narrowing a level therefore revokes the
 * token outright (Google would otherwise keep honouring the wider grant for as
 * long as the refresh token lives) and a fresh consent is needed. Widening
 * keeps the token; the sidecar stays at what it covers until reconnected.
 *
 * **Google revokes a grant, not a token.** A revoke removes the app's access to
 * that account, so every refresh token the account issued to this client dies
 * with it — including one minted a moment ago. Never revoke one token of an
 * account while keeping another of the same account.
 */

import {
  buildAuthUrl,
  exchangeCode,
  type Fetch,
  fetchAccountEmail,
  GoogleGrantRevokedError,
  newPkce,
  newState,
  refreshGrant,
  revokeToken,
} from "./oauth.ts";
import { type GooglePermissions, hasAnyService, scopesForPermissions } from "./policy.ts";
import {
  applyGoogleSettingsUpdate,
  credentialFileName,
  GOOGLE_SETTINGS_FILE,
  GOOGLE_SIDECAR_FILE,
  type GoogleSettings,
  isServing,
  type PublicGoogleSettings,
  parseStoredGoogleSettings,
  renderCredentialFile,
  renderSidecarConfig,
  renderStoredGoogleSettings,
  toPublicGoogleSettings,
} from "./settings.ts";

export interface GoogleIo {
  /** A file in the policy directory; null when absent. */
  readPolicy(name: string): Promise<string | null>;
  /** Atomically replace a file in the policy directory. */
  writePolicy(name: string, content: string): Promise<void>;
  /** File names in the credentials directory. */
  listCreds(): Promise<string[]>;
  readCred(name: string): Promise<string | null>;
  /** Atomically replace a credentials file, readable by its owner only. */
  writeCred(name: string, content: string): Promise<void>;
  deleteCred(name: string): Promise<void>;
}

export interface GoogleServiceDeps {
  io: GoogleIo;
  fetch: Fetch;
  /** Where Google sends the browser back to — must match the OAuth client exactly. */
  redirectUri: string;
  /** Put the sidecar into the shared MCP list while it serves; take it out when not. */
  syncMcpEntry: (serving: boolean) => Promise<void>;
  /**
   * Whether the `google` profile token is on. When it is not, the effective
   * settings are `enabled: false` no matter what the stored switch says: no
   * sidecar config on, no MCP-list entry — while the stored settings keep the
   * switch, the client and the grant, so re-adding the token restores the
   * setup with one flip of the switch.
   */
  profileEnabled?: () => boolean;
  /**
   * The Google client from the environment (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
   * When set it is the live client for everything here *and* for `SIGNIN=google` —
   * one client, one console entry, one place to look — and the pair stored in
   * Settings becomes the fallback for an install that predates the variables.
   */
  envClient?: { clientId: string; clientSecret: string };
  log: (message: string) => void;
  now?: () => number;
}

/** A consent in flight, keyed by its `state`. */
interface PendingConsent {
  verifier: string;
  requested: GooglePermissions;
  expiresAt: number;
}

const CONSENT_TTL_MS = 10 * 60 * 1000;

/** A request we refuse, with a message fit for the user. */
export class GoogleAccessError extends Error {}

export class GoogleService {
  private readonly pending = new Map<string, PendingConsent>();
  /** Mutations read, decide, then write several files: one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GoogleServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The env pair, but only when it is complete — a half-set pair is not a client. */
  private envClient(): { clientId: string; clientSecret: string } | null {
    const env = this.deps.envClient;
    return env && env.clientId && env.clientSecret ? env : null;
  }

  /**
   * The client that takes effect: the environment's when it is set, what Settings
   * holds otherwise. Consent, sidecar config and token refresh must all agree on
   * this answer — a refresh token is only good for the client that was issued it —
   * while the file keeps whatever the operator typed, so removing the variables
   * later falls back to it instead of to nothing.
   */
  private clientOf(settings: GoogleSettings): {
    clientId: string;
    clientSecret: string | null;
  } {
    const env = this.envClient();
    return env
      ? { clientId: env.clientId, clientSecret: env.clientSecret }
      : { clientId: settings.clientId, clientSecret: settings.clientSecret };
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<GoogleSettings> {
    return parseStoredGoogleSettings(await this.deps.io.readPolicy(GOOGLE_SETTINGS_FILE));
  }

  /** What the browser sees, with where the live client came from. */
  private publicOf(settings: GoogleSettings): PublicGoogleSettings {
    return toPublicGoogleSettings(this.effective(settings), this.envClient() ? "env" : "stored");
  }

  /**
   * The settings as they take effect: with the `google` profile token off,
   * `enabled` is false whatever the stored switch says, and the environment's
   * client replaces the stored one. Everything that renders the sidecar's config,
   * decides serving, or answers the browser runs on this; everything that writes
   * stored state runs on the raw settings, so a token that comes back finds the
   * previous setup intact.
   */
  private effective(settings: GoogleSettings): GoogleSettings {
    const withClient = this.envClient() ? { ...settings, ...this.clientOf(settings) } : settings;
    const gate = this.deps.profileEnabled;
    return gate && !gate() && withClient.enabled ? { ...withClient, enabled: false } : withClient;
  }

  async status(): Promise<PublicGoogleSettings> {
    return toPublicGoogleSettings(
      this.effective(await this.load()),
      this.envClient() ? "env" : "stored",
    );
  }

  /** When `checkIfDue` last asked Google; in memory, so a restart checks again. */
  private lastCheckedAt = 0;

  /**
   * Record that Google no longer accepts the token. Called when a tool call
   * comes back with an auth failure — Google's own `invalid_grant`, so no
   * second round trip is needed to believe it. Returns the account, for the
   * message the agent gets; null when nothing is connected.
   */
  markLost(why: string): Promise<{ email: string } | null> {
    return this.serialized(async () => {
      const settings = await this.load();
      if (!settings.grant) return null;
      if (!settings.grant.lostAt) {
        settings.grant = { ...settings.grant, lostAt: new Date(this.now()).toISOString() };
        await this.persist(settings);
        this.deps.log(`Google: access lost for ${settings.grant.email} (${why})`);
      }
      return { email: settings.grant.email };
    });
  }

  /**
   * Ask Google whether the token still works, at most every `maxAgeMs`: run
   * when Settings → Google Workspace is opened, so it shows the truth rather than what
   * Google said at consent. A network failure is not a verdict and changes
   * nothing.
   */
  async checkIfDue(maxAgeMs: number): Promise<void> {
    const settings = await this.load();
    // A grant marked lost is asked about too: a refresh that works clears it,
    // so a loss recorded by mistake does not outlive the next visit here.
    if (!settings.grant) return;
    if (this.now() - this.lastCheckedAt < maxAgeMs) return;
    this.lastCheckedAt = this.now();
    try {
      await this.verify();
    } catch {
      // Unreachable Google, or no client saved: keep what is stored.
    }
  }

  /** Settings first, then the sidecar's config, then the MCP list. */
  private async persist(settings: GoogleSettings): Promise<void> {
    await this.deps.io.writePolicy(GOOGLE_SETTINGS_FILE, renderStoredGoogleSettings(settings));
    // The sidecar and the MCP list answer to the effective settings: with the
    // profile token off they go off too, even while the stored switch stays on.
    const effective = this.effective(settings);
    await this.deps.io.writePolicy(GOOGLE_SIDECAR_FILE, renderSidecarConfig(effective));
    try {
      await this.deps.syncMcpEntry(isServing(effective));
    } catch (error) {
      // The list is only discovery; access is decided in the sidecar. A failed
      // sync is retried on the next upstream connect.
      this.deps.log(`Google: could not update the MCP list: ${String(error)}`);
    }
  }

  /** On boot and every upstream connect: re-render from what is stored. */
  reapply(): Promise<void> {
    return this.serialized(async () => this.persist(await this.load()));
  }

  /** The stored token, with its file — named for its account (`credentialFileName`). */
  private async readStoredCred(): Promise<{ name: string; refreshToken: string } | null> {
    for (const name of await this.deps.io.listCreds()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse((await this.deps.io.readCred(name)) ?? "") as {
          refresh_token?: unknown;
        };
        if (typeof parsed.refresh_token === "string") {
          return { name, refreshToken: parsed.refresh_token };
        }
      } catch {
        // An unreadable file holds no token we can revoke.
      }
    }
    return null;
  }

  private async readRefreshToken(): Promise<string | null> {
    return (await this.readStoredCred())?.refreshToken ?? null;
  }

  private async clearCreds(): Promise<void> {
    for (const name of await this.deps.io.listCreds()) await this.deps.io.deleteCred(name);
  }

  /**
   * Revoke the stored token at Google and delete every credential file. A
   * revoke that fails still clears the files: the sidecar must stop using the
   * token either way, and the user is told to remove access by hand.
   */
  private async dropGrant(settings: GoogleSettings, why: string): Promise<string | null> {
    let warning: string | null = null;
    const token = await this.readRefreshToken();
    if (token) {
      try {
        await revokeToken(this.deps.fetch, token);
        this.deps.log(`Google: revoked the token (${why})`);
      } catch (error) {
        warning =
          "Google did not confirm the revoke. Remove access by hand at " +
          "https://myaccount.google.com/permissions.";
        this.deps.log(`Google: revoke failed (${why}): ${String(error)}`);
      }
    }
    await this.clearCreds();
    settings.grant = null;
    return warning;
  }

  /** Scopes the token has that the policy does not want. */
  private excessScopes(settings: GoogleSettings, scopes: readonly string[]): string[] {
    const wanted = new Set(scopesForPermissions(settings.permissions));
    return scopes.filter((scope) => !wanted.has(scope));
  }

  async save(body: unknown): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const current = await this.load();
      const next = applyGoogleSettingsUpdate(current, body);
      let warning: string | null = null;

      if (next.grant) {
        // Compare the client that *takes effect*. With the env pair in force the
        // stored one is inert, and revoking a working token because someone typed
        // into an inert field is a worse surprise than leaving the grant alone.
        const before = this.clientOf(current);
        const after = this.clientOf(next);
        const clientChanged =
          after.clientId !== before.clientId || after.clientSecret !== before.clientSecret;
        if (clientChanged) {
          warning = await this.dropGrant(next, "OAuth client changed");
        } else if (this.excessScopes(next, next.grant.scopes).length > 0) {
          warning = await this.dropGrant(next, "access narrowed");
        }
      }

      await this.persist(next);
      return { settings: this.publicOf(next), warning };
    });
  }

  /** Begin a consent for the current policy. Returns Google's URL. */
  async startConnect(): Promise<string> {
    const settings = await this.load();
    const client = this.clientOf(settings);
    if (!client.clientId || !client.clientSecret) {
      throw new GoogleAccessError("Save an OAuth client ID and secret first");
    }
    if (!hasAnyService(settings.permissions)) {
      throw new GoogleAccessError("Choose at least one service first");
    }
    const now = this.now();
    for (const [state, consent] of this.pending) {
      if (consent.expiresAt < now) this.pending.delete(state);
    }
    const state = newState();
    const pkce = newPkce();
    this.pending.set(state, {
      verifier: pkce.verifier,
      requested: { ...settings.permissions },
      expiresAt: now + CONSENT_TTL_MS,
    });
    return buildAuthUrl({
      clientId: client.clientId,
      redirectUri: this.deps.redirectUri,
      scopes: scopesForPermissions(settings.permissions),
      state,
      codeChallenge: pkce.challenge,
      loginHint: settings.grant?.email,
    });
  }

  /**
   * Google's redirect back. The `state` is what authorises this: it is
   * single-use, expires, and only `startConnect` — behind a signed-in session
   * that may change settings — mints one. Returns the connected account.
   */
  async finishConnect(query: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ email: string; settings: PublicGoogleSettings }> {
    const consent = query.state ? this.pending.get(query.state) : undefined;
    if (!query.state || !consent || consent.expiresAt < this.now()) {
      throw new GoogleAccessError("This sign-in link has expired. Start again from Settings.");
    }
    this.pending.delete(query.state);
    if (query.error) throw new GoogleAccessError(`Google said: ${query.error}`);
    if (!query.code) throw new GoogleAccessError("Google sent no authorisation code");
    const code = query.code;

    return this.serialized(async () => {
      const settings = await this.load();
      const client = this.clientOf(settings);
      if (!client.clientId || !client.clientSecret) {
        throw new GoogleAccessError("The OAuth client was removed while signing in");
      }
      const tokens = await exchangeCode(this.deps.fetch, {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: this.deps.redirectUri,
        codeVerifier: consent.verifier,
      });

      const email = await fetchAccountEmail(this.deps.fetch, tokens.accessToken);
      const previous = await this.readStoredCred();
      const sameAccount = previous?.name === credentialFileName(email);

      // The policy may have been narrowed while the consent screen was open,
      // or Google may have folded in an older grant: either way this token can
      // do more than is wanted now, so it is not kept. Revoking it revokes the
      // account's grant, so a stored token of the same account is dead too and
      // must not be left looking connected.
      const excess = this.excessScopes(settings, tokens.scopes);
      if (excess.length > 0) {
        await revokeToken(this.deps.fetch, tokens.refreshToken).catch(() => undefined);
        if (sameAccount) {
          await this.clearCreds();
          settings.grant = null;
          await this.persist(settings);
        }
        throw new GoogleAccessError(
          `Google granted more than the current settings allow (${excess.join(", ")}); ` +
            "the token was revoked. Connect again.",
        );
      }

      // Another account's token belongs to another grant: revoke it. The same
      // account's is simply replaced — revoking it would revoke the grant the
      // new token belongs to (seen on prod 2026-09-28: a reconnect to widen
      // access left a token that failed its first refresh with invalid_grant).
      if (previous && !sameAccount) {
        await revokeToken(this.deps.fetch, previous.refreshToken).catch((error) =>
          this.deps.log(`Google: could not revoke the replaced token: ${String(error)}`),
        );
      }
      // workspace-mcp's single-user mode takes the first credential file it
      // finds, so there must never be more than one.
      await this.clearCreds();
      await this.deps.io.writeCred(
        credentialFileName(email),
        renderCredentialFile(this.effective(settings), tokens),
      );

      settings.grant = {
        email,
        scopes: tokens.scopes,
        requested: consent.requested,
        grantedAt: new Date(this.now()).toISOString(),
      };
      await this.persist(settings);
      this.deps.log(`Google: connected ${email} (${tokens.scopes.length} scopes)`);
      return { email, settings: this.publicOf(settings) };
    });
  }

  /** Revoke and forget the token. The policy and client stay. */
  async disconnect(): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const settings = await this.load();
      const warning = await this.dropGrant(settings, "disconnected");
      await this.persist(settings);
      return { settings: this.publicOf(settings), warning };
    });
  }

  /**
   * Ask Google, now, what the token can do. The grant's scopes are otherwise
   * only what Google said at consent, and the account owner can revoke access
   * from their Google account at any time.
   */
  async verify(): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const settings = await this.load();
      if (!settings.grant) throw new GoogleAccessError("Not connected");
      const client = this.clientOf(settings);
      if (!client.clientId || !client.clientSecret) {
        throw new GoogleAccessError("No OAuth client is saved");
      }
      const refreshToken = await this.readRefreshToken();
      let warning: string | null = null;
      if (!refreshToken) {
        settings.grant = null;
        warning = "The token file is gone. Connect again.";
      } else {
        try {
          const live = await refreshGrant(this.deps.fetch, {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            refreshToken,
          });
          // It works: whatever was recorded as lost is no longer true.
          const { lostAt: _, ...grant } = settings.grant;
          settings.grant = { ...grant, scopes: live.scopes };
          if (this.excessScopes(settings, live.scopes).length > 0) {
            warning =
              (await this.dropGrant(settings, "token wider than the policy")) ??
              "The token could do more than the settings allow, so it was revoked.";
          }
        } catch (error) {
          if (!(error instanceof GoogleGrantRevokedError)) throw error;
          // Kept, marked lost: Settings names the account to reconnect, and
          // agents are told to send the user there rather than losing the
          // tools without a word. The dead token stays until the reconnect
          // replaces it — it grants nothing.
          settings.grant = {
            ...settings.grant,
            lostAt: settings.grant.lostAt ?? new Date(this.now()).toISOString(),
          };
          warning = `Google no longer accepts the token for ${settings.grant.email} (revoked or expired). Reconnect.`;
        }
      }
      await this.persist(settings);
      return { settings: this.publicOf(settings), warning };
    });
  }
}
