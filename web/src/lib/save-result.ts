/**
 * The whole "stored, and here is when it bites" vocabulary. The same fact used to
 * be said nine ways across Settings, and a reader cannot tell nine near-synonyms
 * apart, so there are four phrases and each means exactly one thing.
 */

/** The app-server took the change and reloaded its mods. The common case. */
export const SAVED_NOW = "Saved — agents see it on their next turn";

/** Saved here, but the app-server could not be told; say so, and it self-heals. */
export const SAVED_ON_RECONNECT = "Saved — it applies on reconnect";

/** Saved, and there is no agent yet for the reload to reach. */
export const SAVED_NO_AGENT = "Saved — it applies once an agent exists";

/** A worker already started keeps its old settings; only the next one is affected. */
export const SAVED_NEXT_WORKER = "Saved — the next worker uses it";
