/**
 * The password behind `SIGNIN=password`, and the pause that follows a wrong one.
 *
 * Only the hash is ever stored: scrypt with a per-instance salt, compared in
 * constant time. It lives on the `bff-auth` volume (`config.signinDir`) and
 * nowhere else — deliberately not under `LETTA_STATE_DIR`, which the app-server
 * (where agent shells run, as uid 0) mounts read-write.
 *
 * The file doubles as the claim on this instance: no file means nobody has chosen
 * a password yet and the setup route is open, and that window closes the first
 * time it is used.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Short enough to be a typo of a password, so both setters refuse it. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Interactive scrypt: ~16 MiB and tens of milliseconds, which is the point — the
 * BFF verifies this on a request path, and the hash is not defending a vault.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;
const LOCKOUT_BASE_SECONDS = 60;
const LOCKOUT_MAX_SECONDS = 15 * 60;

class PasswordError extends Error {}

interface StoredHash {
  kdf: "scrypt";
  salt: string;
  hash: string;
  /** ISO timestamp, shown in Settings → Sign-in. */
  updatedAt: string;
}

function hash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT, (error, derived) => {
      if (error) reject(error);
      else resolve(derived.toString("hex"));
    });
  });
}

export function assertPasswordIsUsable(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

export class PasswordStore {
  private claimedCache: boolean | null = null;
  private updatedAtCache: string | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, "signin.json");
  }

  /**
   * Whether a password exists, memoised: `/api/status` is polled, and the only
   * thing that changes the answer is this process writing it. An unreadable file
   * counts as claimed — "I cannot read the credential" must not reopen the door
   * that only an absent credential unlocks.
   */
  async claimed(): Promise<boolean> {
    if (this.claimedCache === null) {
      this.claimedCache = await this.current()
        .then((stored) => {
          this.updatedAtCache = stored?.updatedAt ?? null;
          return stored !== null;
        })
        .catch(() => true);
    }
    return this.claimedCache;
  }

  /**
   * When the password was last set, from the same read as `claimed()` — shown in
   * Settings → Sign-in, where "did I change this after the breach" matters. Null
   * only when the file could not be read at all.
   */
  updatedAt(): string | null {
    return this.updatedAtCache;
  }

  /** The stored hash, or null when nobody has claimed this instance yet. */
  async current(): Promise<StoredHash | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A file we cannot read is not "no password" — that would reopen setup.
      throw new PasswordError("The stored sign-in credential is unreadable.");
    }
    const stored = parsed as Partial<StoredHash>;
    if (stored?.kdf !== "scrypt" || !stored.salt || !stored.hash) {
      throw new PasswordError("The stored sign-in credential is unreadable.");
    }
    return stored as StoredHash;
  }

  /** Writes the password, replacing any existing one. Callers gate who may. */
  async setPassword(password: string): Promise<{ updatedAt: string }> {
    assertPasswordIsUsable(password);
    const salt = randomBytes(16).toString("hex");
    const updatedAt = new Date().toISOString();
    const stored: StoredHash = { kdf: "scrypt", salt, hash: await hash(password, salt), updatedAt };
    // Write-then-rename, so a crash mid-write cannot leave a half-written file
    // that reads as "the credential is unreadable" and locks the owner out. The
    // temp name is unique because two first-run posts (phone and laptop, or a
    // retried submit) share this path: with a fixed name the second rename can
    // move the first writer's half-written file into place.
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
    this.claimedCache = true;
    this.updatedAtCache = updatedAt;
    return { updatedAt };
  }

  /** False on a wrong password; throws only when the store itself is unusable. */
  async verify(password: string): Promise<boolean> {
    const stored = await this.current();
    if (!stored || typeof password !== "string") return false;
    const derived = Buffer.from(await hash(password, stored.salt), "hex");
    const expected = Buffer.from(stored.hash, "hex");
    // Equal length first: `timingSafeEqual` throws rather than comparing when the
    // lengths differ, and a truncated file would otherwise be an error page.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}

/**
 * The slower half of the brute-force story: the HTTP rate limiter
 * (`http-rate-limit.ts`) bounds request *volume* for everyone, this bounds
 * *guessing* at one credential, and reports a wait the browser can show.
 *
 * shortcut: counts live in memory, so any restart clears them — including the
 * one every deploy does. Persisting them means keeping `failures` and
 * `lockedUntilMs` beside the hash in `signin.json`, which is not worth the extra
 * file writes while a restart needs host access: that is already past what this
 * pause defends.
 */
export class AttemptLockout {
  private failures = 0;
  private locks = 0;
  private lockedUntilMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds until an attempt is allowed again; 0 means try now. */
  waitSeconds(): number {
    const left = this.lockedUntilMs - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Attempts left before the next pause, for the error message. */
  attemptsLeft(): number {
    return MAX_ATTEMPTS_BEFORE_LOCKOUT - (this.failures % MAX_ATTEMPTS_BEFORE_LOCKOUT);
  }

  /** The pause just applied — 0 when this failure only cost an attempt. */
  recordFailure(): number {
    this.failures += 1;
    if (this.failures % MAX_ATTEMPTS_BEFORE_LOCKOUT !== 0) return 0;
    this.locks += 1;
    const seconds = Math.min(LOCKOUT_BASE_SECONDS * 2 ** (this.locks - 1), LOCKOUT_MAX_SECONDS);
    this.lockedUntilMs = this.now() + seconds * 1000;
    return seconds;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.locks = 0;
    this.lockedUntilMs = 0;
  }
}
