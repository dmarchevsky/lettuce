/**
 * What the dev harness scripts share: where to find a browser, how to sign in,
 * which build a stack actually serves, and how to move around the app.
 *
 * Everything here exists because a scratch driver kept re-deriving it wrong: an
 * endpoint guessed, a form post where JSON was required, a rail button waited on
 * while it was hidden by CSS, and a whole suite scored green against a bundle that
 * predated the branch. Re-deriving those four is roughly half the time a UI flow
 * spends on tooling rather than on the change.
 *
 * One password source, not one per script — `ui-check`, `smoke` and the sign-in
 * screens all drive the same local stack, and two names meant exporting the same
 * secret twice to run one check.
 *
 * Named entry points, so a driver imports one instead of re-deriving it:
 * `devSignIn` / `signInPage` / `requireTestPassword` (sign-in), `openPane` (rail and
 * bottom-bar navigation), `servedBuild` / `assertServedBuild` / `requireServedBuild`
 * (which bundle a running stack actually serves), `cookieJarLine`, `chromiumExecutable`
 * and `headlessRenderArgs`. `scripts/dev-login.ts` is the shell form of the first group,
 * and `ui-check --list` / `--section <name>` runs one section instead of the suite.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { readBuildInfo, versionString } from "../bff/src/build-info.ts";

/** The checkout this script lives in — the worktree, when run from one. */
export const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The **main** checkout, which is where the per-machine files live.
 *
 * `.pi/local-secrets/` (and `docker/.env`) are gitignored, so a feature worktree
 * has none of them; `git rev-parse --git-common-dir` is how a worktree finds its
 * way back. Falls back to this checkout when git says nothing useful.
 */
export function checkoutRoot(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: ROOT });
  const out = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0 || !out) return ROOT;
  // `.git` in the main checkout, `<main>/.git/worktrees/<name>` in a worktree.
  const common = out.startsWith("/") ? out : join(ROOT, out);
  return out.endsWith(".git")
    ? common.slice(0, -".git".length).replace(/\/$/, "")
    : join(common, "../..");
}

/**
 * `LETTUCE_TEST_PASSWORD`, else the gitignored local file a developer keeps the
 * dev-stack password in.
 *
 * The file is the point: three flows hand-rolled this sign-in, guessed the
 * endpoint and the content type, and one printed the password into its own
 * transcript while looking for it. Nothing here ever echoes a value — the error
 * names where to put one, never what was read.
 */
export const TEST_PASSWORD = process.env.LETTUCE_TEST_PASSWORD;

export function requireTestPassword(what: string): string {
  if (TEST_PASSWORD) return TEST_PASSWORD;
  const file = join(checkoutRoot(), ".pi", "local-secrets", "test-password.md");
  if (existsSync(file)) {
    const line = readFileSync(file, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s !== "" && !s.startsWith("#"));
    if (line) return line;
  }
  throw new Error(
    `This stack signs in with a password and ${what} has none. Set LETTUCE_TEST_PASSWORD, ` +
      `or put the password on its own line in ${file} (gitignored).`,
  );
}

/**
 * The session cookie for a stack, by whatever method it signs in with — no
 * browser involved.
 *
 * `/auth/login` is both the form and the endpoint, and it refuses a form post:
 * the body must be JSON `{"password": …}`. Under `SIGNIN=none` the same URL
 * mints a cookie with no body at all.
 */
export async function devSignIn(origin: string): Promise<string> {
  const status = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}) as Record<string, unknown>);
  const password = (status as { signin?: string }).signin === "password";
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: password ? { "content-type": "application/json" } : undefined,
    body: password
      ? JSON.stringify({ password: requireTestPassword("the dev-login helper") })
      : undefined,
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error(`${origin}/auth/login gave no session cookie (HTTP ${response.status}).`);
  }
  return cookie.split(";")[0] as string;
}

/**
 * Land a page on the app with a session, by whatever method this stack signed in
 * with. A password field on the page is how `SIGNIN=password` shows up here.
 */
export async function signInPage(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "networkidle" });
  if (await page.locator('input[type="password"]').first().count()) {
    const password = requireTestPassword("the browser sign-in");
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // The success path is a reload of the whole app, so wait for the app itself
    // rather than for the load event, which fires on the sign-in page.
    await page.waitForSelector(".app", { timeout: 20_000 });
  }
}

/**
 * Press a pane's door on whichever nav surface this viewport shows.
 *
 * Both the rail and the phone's bottom bar stay mounted at every width and CSS
 * picks one, so existence proves nothing — and the desktop rail's buttons carry
 * no title or aria-label to aim at, only text. A scratch driver that re-derived
 * this lost three Playwright timeouts waiting on a hidden button.
 */
export async function openPane(page: Page, name: string): Promise<void> {
  const rail = page.locator(`.rail button.rail-item:text-is("${name}")`);
  if ((await rail.count()) > 0 && (await rail.first().isVisible())) {
    await rail.first().click();
    return;
  }
  // `has-text`, not `text-is`: a slot carrying a running count reads as "Runs2", and
  // the pane is the same pane with or without one.
  const bar = page.locator(`.bottombar > button:has-text("${name}")`);
  if ((await bar.count()) === 0 || !(await bar.first().isVisible())) {
    throw new Error(`no "${name}" slot on the phone bar`);
  }
  await bar.first().click();
  // On a phone, arriving on Chat also opens the conversation list — the bar's Chat
  // press IS the list's way in — so asking for the pane is only half the ask. A
  // test that wants the list asserts on it itself; every other test wants the pane
  // under it.
  if ((await page.locator(".switcher").count()) > 0) {
    await page.keyboard.press("Escape");
    // Wait for it to be gone AND for its way out of the history to land: the entry
    // retires asynchronously, and a test that reads history.state too early sees a
    // stale overlay entry it did not create.
    await page.waitForSelector(".switcher", { state: "detached", timeout: 5_000 });
    await page.waitForTimeout(500);
  }
}

/**
 * Which commit the running stack was built from, on both sides.
 *
 * `web/dist` is baked into the bff image and never mounted, so an image can be
 * arbitrarily older than the tree asking about it — and on the one-per-machine
 * stack, a parallel flow's `build:bff` can retag the image *under* a run in
 * progress. That is how a suite once scored a stale bundle as the branch and sent
 * the driver chasing its own code for fifteen minutes.
 *
 * The comparison is on the **sha**, not the whole version string: a worktree's
 * `VERSION` carries whatever tag its branch started from, so two checkouts of the
 * same commit legitimately disagree about the tag and honestly agree about the
 * code. `+unknown` means the image's builder had no git metadata to stamp, which
 * is a fact about the builder, not about the branch.
 */
export interface BuildIdentity {
  /** What the stack answers at `/versionz`, or null when it did not answer. */
  served: string | null;
  /** The sha this checkout is at, eight hex, or null when there was none. */
  expectedSha: string | null;
  /** The full string this checkout would stamp, for the message. */
  expected: string;
  ok: boolean;
  why: string;
  /** The served image was built from a dirty tree: it carries code no commit has. */
  dirty: boolean;
}

/**
 * Does the string a stack answers at `/versionz` name this commit?
 *
 * Split out of `servedBuild` because every wrong answer here is a suite that
 * measured the wrong bundle, and the shapes that produce one are all strings: a
 * seven-hex prefix, `dev`, `unknown`, an `HTTP 500` read back as a version, a build
 * stamped from a dirty tree. Pinning the comparison is cheap; giving the live fetch
 * a fake server per case is not.
 */
export function judgeServedBuild(
  served: string,
  expectedSha: string | null,
): { ok: boolean; why: string; dirty: boolean } {
  const dirty = served.endsWith("-dirty");
  const clean = served.replace(/-dirty$/, "");
  const servedSha = clean.includes("+") ? clean.split("+").pop()! : "";
  if (servedSha === "unknown") {
    return {
      ok: false,
      dirty,
      why: "the served image names no commit (+unknown): it was built with no git metadata to read",
    };
  }
  // A sha is eight hex and nothing else. `dev`, a truncated sha, or the text of a
  // failed request all fail here and say "not this build" — the safe direction, so
  // the fix is a rebuild rather than a quiet green.
  if (!/^[0-9a-f]{8}$/.test(servedSha)) {
    return { ok: false, dirty, why: `serving ${served}, which names no eight-hex commit` };
  }
  if (!expectedSha) {
    return {
      ok: false,
      dirty,
      why: `this checkout resolves no commit to compare ${served} against`,
    };
  }
  if (servedSha !== expectedSha) {
    return { ok: false, dirty, why: `serving ${served}, this checkout is ${expectedSha}` };
  }
  return { ok: true, dirty, why: `both at ${expectedSha}` };
}

export async function servedBuild(origin: string): Promise<BuildIdentity> {
  const info = readBuildInfo(ROOT);
  const expected = versionString(info).replace(/-dirty$/, "");
  const expectedSha = info.sha;
  let served: string;
  try {
    const response = await fetch(`${origin}/versionz`, { signal: AbortSignal.timeout(5000) });
    served = response.ok ? (await response.text()).trim() : `HTTP ${response.status}`;
  } catch (cause) {
    return {
      served: null,
      expectedSha,
      expected,
      ok: false,
      dirty: false,
      why: `${origin}/versionz is unreachable: ${cause instanceof Error ? cause.message : cause}`,
    };
  }
  const verdict = judgeServedBuild(served, expectedSha);
  return {
    served,
    expectedSha,
    expected,
    ok: verdict.ok,
    dirty: verdict.dirty,
    why: verdict.why,
  };
}

/**
 * Refuse to measure a build that is not this checkout's.
 *
 * Call it immediately before the measuring, not once per deploy: on the shared
 * stack another flow's `build:bff` can land mid-pass, which is how a probe once
 * "fixed" a stale build that was not stale with a full rebuild.
 *
 * `--allow-stale-build` (or `LETTUCE_ALLOW_STALE_BUILD=1`) prints the mismatch as
 * a warning and carries on — for a scratch probe that only wants a look.
 */
export async function assertServedBuild(
  origin: string,
  allowStale = envAllowStaleBuild(),
): Promise<string> {
  const identity = await servedBuild(origin);
  if (identity.ok) {
    // The one way a green proof can still mislead: a `-dirty` stamp means the
    // bundle carries edits no commit has, so what passed is not what would ship.
    // Loud, because the fix is a commit and a rebuild, not a flag.
    if (identity.dirty) {
      console.log("  NOTE  the served build was stamped -dirty: it carries uncommitted code.");
    }
    return identity.served as string;
  }
  const fix =
    "Run `bun run build:bff` from this checkout, then " +
    "`docker compose -f docker/compose.yml up -d bff`. To measure it anyway, pass " +
    "`--allow-stale-build` or set LETTUCE_ALLOW_STALE_BUILD=1.";
  if (allowStale) {
    console.log(
      `  WARN  served build is not this checkout — ${identity.why}. Measuring it anyway.`,
    );
    return identity.served ?? "unreachable";
  }
  throw new Error(`The stack at ${origin} is not this checkout: ${identity.why}. ${fix}`);
}

/**
 * The gate form of `assertServedBuild`, for a script that has nothing to report
 * but the refusal: one line naming both sides and its exit code, instead of a
 * stack trace the operator has to read past to find the fix.
 */
export async function requireServedBuild(
  origin: string,
  allowStale = envAllowStaleBuild(),
): Promise<string> {
  try {
    return await assertServedBuild(origin, allowStale);
  } catch (error) {
    console.error(`\n\u2717 ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * The flags every harness script takes, parsed the same way.
 *
 * The origin stays the positional argument, because `bun run ui-check 127.0.0.1:9999`
 * already reads that way in the docs — but a flag value must not be mistaken for it,
 * which is why `--section` takes its own argument.
 */
export interface HarnessArgs {
  origin: string;
  /** The first positional argument, whatever it means to the caller. */
  positional: string;
  /** Lowercased `--section` needles; empty means every section. */
  sections: string[];
  list: boolean;
  shots: string[];
  staleBuild: boolean;
}

export function parseArgs(argv: string[], fallbackOrigin = "http://127.0.0.1:8090"): HarnessArgs {
  const args: HarnessArgs = {
    origin: fallbackOrigin,
    positional: "",
    sections: [],
    list: false,
    shots: [],
    staleBuild: envAllowStaleBuild(),
  };
  const list = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      i += 1;
      return (argv[i] ?? "").toLowerCase();
    };
    const split = (value: string): void => {
      args.sections.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
    };
    if (arg === "--section" || arg === "--sections") {
      split(next());
    } else if (arg === "--shot" || arg === "--shots") {
      args.shots.push(
        ...next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
    } else if (arg === "--list") {
      args.list = list;
    } else if (arg === "--allow-stale-build") {
      args.staleBuild = true;
    } else if (!arg.startsWith("--")) {
      args.positional = arg;
      args.origin = arg;
    }
  }
  return args;
}

function envAllowStaleBuild(): boolean {
  return process.env.LETTUCE_ALLOW_STALE_BUILD === "1";
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

/**
 * One line of a Netscape cookie jar — the format `curl -b` and `curl -c` read.
 *
 * Seven tab-separated fields with the cookie name and its value in their own
 * columns. Merging them into field six (the obvious-looking thing to do) makes curl
 * send a garbage cookie and authenticate as nobody, silently — which is exactly how
 * a handle printed green turned out to be worthless. Keeping the formatter here is
 * what lets `tests/harness.test.ts` pin it.
 *
 * The leading `#HttpOnly_` keeps the value out of `document.cookie`, honest for a
 * handle handed to a command line, and an expiry of 0 makes it a session cookie.
 */
export function cookieJarLine(origin: string, cookie: string): string {
  let hostname: string;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    throw new Error(`cookieJarLine needs an origin with a scheme, got "${origin}"`);
  }
  const name = cookie.split("=")[0] as string;
  const value = cookie.slice(name.length + 1);
  return `#HttpOnly_${hostname}\tFALSE\t/\tFALSE\t0\t${name}\t${value}`;
}

/**
 * The headless-chromium recipe for rendering one HTML file to a PNG, shared with
 * `scripts/mockup.ts` because writing mockups means rendering them, and the
 * incantation is five flags long: without the pointer flags the CSS media queries
 * resolve for a coarse pointer and the mock shows the phone layout at 1280px.
 */
export function headlessRenderArgs(
  htmlPath: string,
  pngPath: string,
  width: number,
  height: number,
) {
  return [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    // The flag that cannot be guessed and lies when it is wrong:
    // chrome-headless-shell reports `pointer: none` / `hover: none` unless
    // `--blink-settings` says otherwise, so every `(pointer: fine)` and
    // `(hover: hover)` rule silently does not apply — a desktop mock comes back
    // with the phone composer and looks like a styling bug in the app. The
    // plausible-looking `--primaryPointerType=4` form is ignored by the shell:
    // verified against a `matchMedia` probe with this very binary.
    "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
    `--screenshot=${pngPath}`,
    htmlPath,
  ];
}
