import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isLoopbackHostname } from "../auth/origin.ts";

/** Per-device opt-in for each push trigger. All default true — see `mergePreferences`. */
export interface PushPreferences {
  completed: boolean;
  failed: boolean;
  approval: boolean;
}

const DEFAULT_PREFERENCES: PushPreferences = { completed: true, failed: true, approval: true };

/**
 * Fills in a preferences object from a partial (or absent) patch, falling
 * back to `base` per-key rather than all-or-nothing — so updating just
 * `completed` never resets `failed`/`approval` to whatever `base` wasn't.
 */
function mergePreferences(base: PushPreferences, patch: unknown): PushPreferences {
  const raw = (patch && typeof patch === "object" ? patch : {}) as Partial<PushPreferences>;
  return {
    completed: typeof raw.completed === "boolean" ? raw.completed : base.completed,
    failed: typeof raw.failed === "boolean" ? raw.failed : base.failed,
    approval: typeof raw.approval === "boolean" ? raw.approval : base.approval,
  };
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The signed-in identity that created this subscription. Not filtered on
   * yet (the app is single-user), but keeping it means a future multi-user
   * filter is a one-line addition instead of a data migration. */
  email: string;
  createdAt: string;
  /** Per-device — a phone and a laptop subscribed to the same instance may
   * want different triggers. */
  preferences: PushPreferences;
}

/**
 * A push service is a public HTTPS endpoint, always: that is what every browser
 * hands out. The BFF later POSTs to whatever is stored here, from inside the
 * stack's network, so anything else — plain http, a sidecar's name, a loopback
 * port — is a request the browser never asked for.
 */
function isPushServiceUrl(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isValidSubscription(
  value: unknown,
): value is Omit<PushSubscriptionRecord, "email" | "createdAt" | "preferences"> {
  if (!value || typeof value !== "object") return false;
  const sub = value as { endpoint?: unknown; keys?: unknown };
  if (typeof sub.endpoint !== "string" || !isPushServiceUrl(sub.endpoint)) return false;
  if (!sub.keys || typeof sub.keys !== "object") return false;
  const keys = sub.keys as { p256dh?: unknown; auth?: unknown };
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

/**
 * A small JSON-file-backed store for push subscriptions. This app has no
 * database anywhere and doesn't need one here either — a handful of devices
 * for a single user. Writes are rare (subscribe/unsubscribe only), so a full
 * rewrite on every mutation, serialized through an in-process promise chain,
 * is plenty; no file locking library needed.
 */
export class PushSubscriptionStore {
  private readonly records = new Map<string, PushSubscriptionRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    /** Surfaced rather than swallowed: a store that cannot persist is degraded,
     * and silently so is worse than a noisy one. */
    private readonly onWriteError: (error: unknown) => void = (error) => {
      console.error(
        `[push] failed to persist subscriptions to ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  ) {
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as { endpoint?: unknown }).endpoint === "string"
            ) {
              const record = entry as PushSubscriptionRecord & { preferences?: unknown };
              this.records.set(record.endpoint, {
                ...record,
                // Records written before preferences existed default to
                // today's always-on behaviour, not to everything disabled.
                preferences: mergePreferences(DEFAULT_PREFERENCES, record.preferences),
              });
            }
          }
        }
      } catch {
        // A corrupt or empty file is treated as "no subscriptions yet" rather
        // than a startup failure — push is not load-bearing for the rest of
        // the app.
      }
    }
  }

  /**
   * Resolves once every queued write has settled.
   *
   * Exposed so a test can await persistence, and so a shutdown path can flush
   * rather than exit mid-write. Never rejects: a failed write is reported
   * through `onWriteError`, not through the chain.
   */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  all(): PushSubscriptionRecord[] {
    return [...this.records.values()];
  }

  getPreferences(endpoint: string): PushPreferences | null {
    return this.records.get(endpoint)?.preferences ?? null;
  }

  /**
   * `preferences` is optional so the existing subscribe flow (no per-type UI
   * yet) keeps working unchanged. Omitting it on a re-subscribe of an
   * already-known endpoint (e.g. after a browser key rotation) preserves
   * whatever that device had chosen, rather than resetting it to all-on.
   */
  add(subscription: unknown, email: string, preferences?: unknown): PushSubscriptionRecord {
    if (!isValidSubscription(subscription)) {
      throw new Error("Malformed push subscription");
    }
    const existing = this.records.get(subscription.endpoint);
    const record: PushSubscriptionRecord = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      email,
      createdAt: new Date().toISOString(),
      preferences: mergePreferences(existing?.preferences ?? DEFAULT_PREFERENCES, preferences),
    };
    this.records.set(record.endpoint, record);
    this.persist();
    return record;
  }

  /** Partial update — only the keys present in `preferences` change. */
  updatePreferences(endpoint: string, preferences: unknown): PushSubscriptionRecord {
    const existing = this.records.get(endpoint);
    if (!existing) throw new Error("Unknown push subscription");
    const record: PushSubscriptionRecord = {
      ...existing,
      preferences: mergePreferences(existing.preferences, preferences),
    };
    this.records.set(endpoint, record);
    this.persist();
    return record;
  }

  remove(endpoint: string): void {
    if (this.records.delete(endpoint)) this.persist();
  }

  /**
   * Serialise a snapshot to disk behind whatever writes are already queued.
   *
   * The failure this guards: chaining with a bare `then` means a throwing write
   * leaves `writeQueue` permanently REJECTED. Every later `persist()` then
   * attaches to a rejected promise and its callback never runs, so from the
   * first disk error onwards subscriptions silently stop being saved while the
   * in-memory map keeps working — invisible until the process restarts and
   * every device has vanished. The `catch` keeps the chain alive and logs.
   */
  private persist(): void {
    const snapshot = this.all();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2));
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}
