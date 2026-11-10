/**
 * The console surface of a page, as an assertion.
 *
 * `ui-check` failed to catch a render loop that shipped green: geometry cannot see
 * a loop, and the only thing that said so — an uncaught `Maximum update depth
 * exceeded` — landed in a browser console nobody was reading. So the console is an
 * assertion surface now, and this module is the part of it that can be tested
 * without an app to drive (see `tests/page-console.test.ts`).
 *
 * What it catches is a failure that *says* something: an uncaught exception of any
 * kind, or a `console.error` outside the allowlist. A loop that only churns state
 * against the production bundle stays silent here — that one needs a render-budget
 * probe, not a console listener.
 */
import type { Page } from "playwright";

/**
 * Console noise that is true of a local harness, not broken about the app: the
 * headless browser fetches a `/favicon.ico` we never ship (and Chromium reports
 * every failed load under one prefix, so a missing icon only counts when the URL
 * says it is the icon), service-worker registration fails in a context that
 * cannot serve it, a torn-down socket reports its close, and Chromium complains
 * about a layout observer rather than about the component that overflowed it.
 */
export const BENIGN_CONSOLE =
  /service worker|ResizeObserver|AbortError|WebSocket is closed|EventSource/i;
const BENIGN_RESOURCE = /favicon|\.ico$|manifest/i;

/** Errors one page is allowed to produce before the run is failed; older ones are dropped. */
export type PageTrouble = { label: string; errors: string[]; fatal: number };

export function newTrouble(label: string): PageTrouble {
  return { label, errors: [], fatal: 0 };
}

/**
 * One console line, decided. A `Failed to load resource` line is Chromium's prefix
 * for ANY failed request — a 5xx off `/api/` arrives under it — so it is only
 * noise when the URL names the one thing this harness really has no business
 * serving. Returns the line to record, or `null` for benign noise.
 */
export function classifyConsoleError(text: string, url = ""): string | null {
  const one = text.replace(/\s+/g, " ").slice(0, 200);
  if (BENIGN_CONSOLE.test(one)) return null;
  if (/Failed to load resource/.test(one) && BENIGN_RESOURCE.test(url)) return null;
  // The browser's own line names no endpoint, and "which request failed" is the
  // whole question, so the page's URL rides along when there is one.
  return `console: ${one}${url && !one.includes(url) ? ` [${url}]` : ""}`;
}

/** Count a line into the page's tally, keeping at most three samples of it. */
export function record(entry: PageTrouble, line: string): void {
  entry.fatal += 1;
  // Cap what is kept: a render loop prints one line per frame and the run must
  // still be able to finish, while the count it reports stays the true one.
  if (entry.errors.length < 3) entry.errors.push(line);
}

/**
 * Pages whose deliberate failure a section is about to raise, so the browser's own
 * line about it is not counted. Some assertions can only be made by asking for a
 * request that must fail — testing an endpoint that is not there, and reading the
 * toast back — and Chromium logs every failed load whether the app handled it
 * gracefully or not. The mute forgives that line alone: a thrown error or a
 * `console.error` on a muted page is still a failure.
 */
const mutedPages = new WeakSet<Page>();

export function expectNetworkNoise(page: Page): void {
  mutedPages.add(page);
}

/** A section owes this after its deliberate failure, so the mute is not permanent. */
export function expectClean(page: Page): void {
  mutedPages.delete(page);
}

/** Attach the listeners. Idempotent per page; a closed page keeps its count. */
export function watchPage(page: Page, entry: PageTrouble): void {
  page.on("pageerror", (error) =>
    record(entry, `uncaught: ${error.message.replace(/\s+/g, " ").slice(0, 200)}`),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (mutedPages.has(page) && /Failed to load resource/.test(text)) return;
    const line = classifyConsoleError(text, message.location().url ?? "");
    if (line) record(entry, line);
  });
}
