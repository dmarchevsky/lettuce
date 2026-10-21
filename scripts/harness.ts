/**
 * What the dev harness scripts share: where to find a browser, and how to sign
 * in to a stack that has a password.
 *
 * One password variable, not one per script — `ui-check`, `smoke` and the
 * sign-in screens all drive the same local stack, and two names meant exporting
 * the same secret twice to run one check.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `LETTUCE_TEST_PASSWORD` — required exactly when the stack signs in with a password. */
export const TEST_PASSWORD = process.env.LETTUCE_TEST_PASSWORD;

export function requireTestPassword(what: string): string {
  if (!TEST_PASSWORD) {
    throw new Error(`This stack signs in with a password — set LETTUCE_TEST_PASSWORD for ${what}.`);
  }
  return TEST_PASSWORD;
}

/**
 * Playwright's own resolution first, then the newest cached build it has ever
 * downloaded — including the headless shell `npx playwright install --with-deps`
 * leaves behind. `undefined` means "use Playwright's default", i.e. the error it
 * prints when nothing is installed, which names the fix rather than hiding it.
 */
export function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((name) => name.startsWith("chromium"))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const rel of [
      join(build, "chrome-linux64", "chrome"),
      join(build, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ]) {
      const candidate = join(cache, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
