/**
 * The human-readable part of anything thrown. `bff/src/errors.ts` is the twin;
 * the two packages cannot import from each other.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one BFF rejection worth translating, because it appears as a UI label
 * (the sidebar/transcript error rows, the dropped-send toast) and its raw
 * wording blames the user's patience. The retry the copy promises is real
 * *at those call sites*: `use-agents` refetches and a failed conversation
 * load restarts when the upstream returns. It is deliberately NOT applied
 * inside `errorMessage` — approval responses and Stop failures also surface
 * this string, and nothing retries those; the user must click again.
 *
 * Keyed by the exact wire string — its source is `bff/src/session/registry.ts`
 * (and the 503 REST guards). If that wording ever changes, this map misses and
 * the raw string shows through: harmless, so no test can be betrayed.
 */
const APP_SERVER_DOWN: Record<string, string> = {
  "App-server is not connected": "App-server is offline — retrying automatically.",
};

export function friendlyServerError(message: string): string {
  return APP_SERVER_DOWN[message] ?? message;
}
