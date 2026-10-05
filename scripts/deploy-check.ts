/**
 * The "is it actually live" half of the definition of done (see AGENTS.md).
 *
 * `web/dist` is baked into the bff image at build time and is NOT mounted, so
 * `docker compose up -d` without a preceding `build bff` silently keeps serving
 * the previous SPA. That is exactly how a change was once reported as shipped
 * while the browser still had the old bundle. This asserts otherwise.
 *
 * Usage: bun run deploy-check [bffOrigin]
 */

import { readFileSync } from "node:fs";
import { readBuildInfo, versionString } from "../bff/src/build-info.ts";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return new TextDecoder().decode(result.stdout).trim();
}

/** The hashed entry bundle, e.g. "assets/index-uBL3eADi.js". */
function bundleName(html: string): string | null {
  return html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

// ── 1. Release preconditions ───────────────────────────────────────────────
section("Release preconditions");

const dirty = git("status", "--porcelain");
check("working tree is clean", dirty === "", dirty.split("\n").slice(0, 5).join(" | "));

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
check("on main", branch === "main", `on "${branch}"`);

// No worktree-count precondition here on purpose. The deploy builds from the
// main checkout, whose correctness is already asserted by "working tree is
// clean" and "on main" above; other worktrees do not affect what the container
// serves. Kilo Code Agent Manager owns worktree lifecycle and runs concurrent
// agents, so more than one worktree is the normal state — an earlier version
// that failed on `worktrees.length > 1` forced whoever ran the gate to delete
// every other agent's live worktree (observed 2026-09-29).

/**
 * `VERSION` carries the release tag this checkout claims (see the
 * `lettuce-releasing` skill): it is bumped in the commit that gets tagged, and the
 * bff image bakes it in for Settings → About. Before tagging it only has to be
 * well-formed; once HEAD is tagged, the two must agree — that is what catches a
 * release tagged without bumping the file.
 */
const versionText = await Bun.file(`${ROOT}VERSION`)
  .text()
  .catch(() => "");
const version = versionText.trim();
check(
  "VERSION is a well-formed release tag",
  /^v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+$/.test(version),
  versionText || "missing — see the lettuce-releasing skill",
);
const headTag = git("tag", "--points-at", "HEAD");
if (headTag) {
  check(
    "VERSION matches the tag on HEAD",
    version === headTag,
    `tag ${headTag}, VERSION ${version}`,
  );
}

/**
 * `CHANGELOG.md` carries the user-facing entries for each release (see the
 * `lettuce-releasing` skill's changelog rules): the release commit that bumps
 * `VERSION` renames `## [Unreleased]` to `## [v<new-tag>] - <date>`, so the
 * newest released section must equal `VERSION` by construction — before tagging
 * this is the VERSION↔changelog check, after tagging it transitively matches
 * the tag. It catches a bump that renamed the changelog without bumping the
 * file, or a bump that forgot to rename it.
 */
const changelogText = await Bun.file(`${ROOT}CHANGELOG.md`)
  .text()
  .catch(() => "");
check(
  "CHANGELOG.md exists and has an [Unreleased] section",
  changelogText.includes("## [Unreleased]"),
  changelogText === ""
    ? "missing — see the lettuce-releasing skill"
    : 'no "## [Unreleased]" heading',
);
const newestRelease = changelogText.match(/^## \[(v[^\]]+)\]/m)?.[1];
check(
  "newest CHANGELOG.md release section matches VERSION",
  newestRelease === version,
  `changelog newest is ${newestRelease ?? "none"}, VERSION is ${version}`,
);

/**
 * LETTA_STATE_DIR anchors every bind mount, and compose defaults it to `../..`
 * relative to the compose file. That default is a trap: from a worktree at
 * `lettuce-worktrees/<feature>/docker/` it resolves to the worktrees
 * directory rather than the real state, so the stack comes up healthy against
 * an empty (or wrong) set of agent memory, conversations and settings.
 *
 * Read the same two sources compose would, in the same precedence order.
 */
function declaredStateDir(): string | null {
  if (process.env.LETTA_STATE_DIR?.trim()) return process.env.LETTA_STATE_DIR.trim();
  let text: string;
  try {
    text = readFileSync(`${ROOT}docker/.env`, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?LETTA_STATE_DIR\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[1]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    if (value) return value;
  }
  return null;
}

const stateDir = declaredStateDir();
const stateDirIsAbsolute = stateDir?.startsWith("/") ?? false;
check(
  "LETTA_STATE_DIR is set to an absolute path",
  stateDirIsAbsolute,
  stateDir === null
    ? "unset — compose will default to `../..` relative to docker/, which resolves " +
        "into the wrong directory from a worktree. Set it absolutely in docker/.env."
    : `relative: ${stateDir}`,
);

// ── 2. The running image matches the built bundle ──────────────────────────
section("Deployed bundle");

const localHtml = await Bun.file(`${ROOT}web/dist/index.html`)
  .text()
  .catch(() => "");
const localBundle = bundleName(localHtml);
check("web/dist exists and names a bundle", localBundle !== null, "run: bun run build");

let servedBundle: string | null = null;
try {
  const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(5000) });
  servedBundle = bundleName(await response.text());
} catch (cause) {
  check(`${ORIGIN} is reachable`, false, cause instanceof Error ? cause.message : cause);
}

if (localBundle && servedBundle) {
  check(
    "served bundle matches web/dist",
    servedBundle === localBundle,
    `serving ${servedBundle}, local web/dist is ${localBundle} — these must match. ` +
      "Either side can be the stale one: run `bun run build` if web/dist predates " +
      "your last source change, or `docker compose -f docker/compose.yml build bff " +
      "&& ... up -d bff` if the image does.",
  );
}

// ── 3. Which commit this build is ─────────────────────────────────────────────
section("Build identity");

/**
 * `/versionz` answers with what the image was built from (`vX.Y.Z-letta_A.B.C+sha`);
 * the local side resolves it the same way from this checkout. The `-dirty` suffix
 * is ignored on both sides: an image build cannot see a dirty working tree, so only
 * a `bun run build:bff` of a dirty checkout can produce it.
 */
const expectedBuild = versionString(readBuildInfo(ROOT)).replace(/-dirty$/, "");
let servedVersion: string | null = null;
try {
  const response = await fetch(`${ORIGIN}/versionz`, { signal: AbortSignal.timeout(5000) });
  servedVersion = response.ok ? (await response.text()).trim() : `HTTP ${response.status}`;
} catch (cause) {
  check(`${ORIGIN}/versionz is reachable`, false, cause instanceof Error ? cause.message : cause);
}
if (servedVersion !== null) {
  const matches = servedVersion.replace(/-dirty$/, "") === expectedBuild;
  check(
    `served build matches this checkout (${expectedBuild})`,
    matches,
    matches
      ? undefined
      : `serving ${servedVersion}. "+unknown" or an older sha means the image predates your last ` +
          "commit: `bun run build:bff` then `docker compose -f docker/compose.yml up -d bff`. " +
          "An HTTP 404 means the running image predates /versionz.",
  );
}

// ── 4. The stack is healthy ─────────────────────────────────────────────────
section("Stack health");

try {
  const response = await fetch(`${ORIGIN}/readyz`, { signal: AbortSignal.timeout(5000) });
  const ready = (await response.text()).trim();
  // /readyz is the whole health signal: 200 "ok" when the BFF's permanent
  // upstream connection is live, 503 "app-server <state>" otherwise. It is
  // deliberately unauthenticated, unlike /api/status, which no longer reports
  // upstream state to an anonymous caller.
  check(
    "upstream app-server is connected",
    response.ok && ready === "ok",
    `${response.status} ${ready}`,
  );
} catch (cause) {
  check("stack responds", false, cause instanceof Error ? cause.message : cause);
}

console.log(
  failures === 0
    ? "\n✓ deploy-check passed — the merged code is what is running."
    : `\n✗ deploy-check FAILED (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
