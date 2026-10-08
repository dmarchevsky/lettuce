/**
 * The release, as gated commands (see the `lettuce-releasing` skill and
 * "Stop before releasing to prod").
 *
 * It exists because the release is five manual steps with a human gate in the
 * middle, and two of them were easy to forget: the `VERSION` bump (it belongs on
 * `main` at release time, not on a feature branch — parallel worktrees cannot know
 * the next version, and two MINOR features merged together are one MINOR release)
 * and the tag after the verified deploy. The tag is computed mechanically from
 * `VERSION` + the compose pin, and nothing deploys or tags without the human typing
 * the exact tag.
 *
 * Three modes, in the order the workflow uses them:
 *
 *   bun run release --minor|--patch|--auto --pr
 *       Open the release PR: branch `release/<tag>` off `main` with the `VERSION`
 *       bump and the `[Unreleased]` rename, pushed, PR created. Deploys nothing and
 *       tags nothing. This is the mode a repo with branch protection on `main` needs,
 *       because branch protection will not accept a direct push of the release commit.
 *
 *   bun run release --deploy
 *       After that PR is merged: assert `origin/main`'s tip *is* the release commit,
 *       run `deploy-check`, ask for the one confirmation, then tag that commit and
 *       push `main` (one-shot mode) and the tag. The tag is cut as part of the
 *       release, immediately once the release PR has merged; the prod redeploy from
 *       `origin/main` and its verification are the operator's own, not this script's.
 *
 *   bun run release --minor|--patch|--auto
 *       The original one-shot: the release commit on `main` locally, then push →
 *       tag. Still supported and still correct while `main` accepts
 *       direct pushes; once require-PR is on, this mode fails at the push.
 *
 * What never changes: nothing is pushed or tagged before the confirmation names
 * the exact tag, and nothing is rolled back. On a TTY it is typed; a non-interactive
 * caller (an agent that has asked the human) sets RELEASE_CONFIRM=<the exact tag>.
 *
 * Usage (from the main checkout, on `main`, clean tree):
 *   bun run release --minor | --patch | --auto [--pr | --deploy] [--message "..."]
 */

const ROOT = new URL("..", import.meta.url).pathname;

// ── Arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
}
const bumpMinor = args.includes("--minor");
const bumpPatch = args.includes("--patch");
const bumpAuto = args.includes("--auto");
const modePr = args.includes("--pr");
const modeDeploy = args.includes("--deploy");
const message = flag("--message") || "";

function die(step: string, why: string, next = ""): never {
  console.log(`\n✗ STOPPED at ${step}: ${why}`);
  if (next) console.log(`  ${next}`);
  console.log("  Nothing was rolled back.");
  process.exit(1);
}

const bumpFlags = [bumpMinor, bumpPatch, bumpAuto].filter(Boolean).length;
if (modeDeploy) {
  if (bumpFlags > 0)
    die("arguments", "--deploy takes no bump flag — the version to ship is already in VERSION");
} else if (bumpFlags !== 1) {
  die(
    "arguments",
    "exactly one of --minor, --patch or --auto is required (see the lettuce-releasing skill)",
  );
}
if (modePr && modeDeploy) die("arguments", "--pr and --deploy are two steps, not one run");

// ── Helpers ──────────────────────────────────────────────────────────────────
function git(...cmd: string[]): string {
  const result = Bun.spawnSync(["git", ...cmd], { cwd: ROOT });
  return new TextDecoder().decode(result.stdout).trim();
}

function gitOk(cmd: string[]): boolean {
  return Bun.spawnSync(cmd, { cwd: ROOT }).exitCode === 0;
}

async function run(cmd: string[]): Promise<number> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

async function capture(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  process.stdout.write(out);
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  return out;
}

// ── 1. Preflight ─────────────────────────────────────────────────────────────
console.log("── preflight");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
  die(
    "preflight",
    "not on main — the release commit is made on main, after every merge for this release",
  );
}
if (git("status", "--porcelain") !== "") die("preflight", "working tree is not clean");
git("fetch", "origin", "main");

const versionText = await Bun.file(`${ROOT}VERSION`)
  .text()
  .catch(() => "");
const current = versionText.trim();
const parsed = current.match(/^v(\d+)\.(\d+)\.(\d+)-letta_(\d+\.\d+\.\d+)$/);
if (!parsed) die("preflight", `VERSION is not a well-formed release tag: "${current}"`);

const changelog = await Bun.file(`${ROOT}CHANGELOG.md`)
  .text()
  .catch(() => "");
if (!changelog.includes("## [Unreleased]"))
  die("preflight", "CHANGELOG.md has no [Unreleased] section");
const newest = changelog.match(/^## \[(v[^\]]+)\]/m)?.[1];
if (newest !== current)
  die("preflight", `newest CHANGELOG section ${newest} != VERSION ${current}`);

// The suffix is read from the pin at tag time, never from memory (the lettuce-releasing skill).
// The fenced pattern is check-version-pin's: it stays inside the app-server block.
const compose = await Bun.file(`${ROOT}docker/compose.yml`)
  .text()
  .catch(() => "");
const pin = compose.match(
  /^ {2}app-server:(?:(?!^ {2}\S)[\s\S])*?LETTA_CODE_VERSION:\s*\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/m,
)?.[1];
if (!pin) die("preflight", "could not read LETTA_CODE_VERSION from docker/compose.yml");

/** `### Added` / `### Changed` under [Unreleased] mean MINOR; only `### Fixed` means PATCH. */
function unreleasedSections(): string[] {
  const section = changelog.split(/^## \[Unreleased\]/m)[1]?.split(/^## \[/m)[0] ?? "";
  return [...section.matchAll(/^### (\w+)/gm)].map((m) => m[1]!.toLowerCase());
}

function deriveBump(): { minor: boolean; why: string } {
  const sections = unreleasedSections();
  if (sections.some((s) => s === "added" || s === "changed"))
    return { minor: true, why: `[Unreleased] has ${sections.join(", ")}` };
  if (sections.length) return { minor: false, why: `[Unreleased] has only ${sections.join(", ")}` };
  // No changelog headings to go on: fall back to the commit subjects since the tag.
  const subjects = git("log", `${current}..HEAD`, "--format=%s")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!subjects.length)
    die("auto", `cannot derive a bump: no [Unreleased] sections and no commits since ${current}`);
  return subjects.some((s) => /^feat\b|^feat[(/]/i.test(s))
    ? { minor: true, why: `commit subjects since ${current} include feat` }
    : { minor: false, why: `no feat commit since ${current}` };
}

let minor = bumpMinor;
if (bumpAuto) {
  const derived = deriveBump();
  minor = derived.minor;
  console.log(`  --auto → ${minor ? "minor" : "patch"}: ${derived.why}`);
}
const next = minor
  ? `v${parsed[1]}.${Number(parsed[2]) + 1}.0-letta_${pin}`
  : `v${parsed[1]}.${parsed[2]}.${Number(parsed[3]) + 1}-letta_${pin}`;

// ── 2. `--deploy`: the release PR has been merged ────────────────────────────
if (modeDeploy) {
  const local = git("rev-parse", "HEAD");
  const remote = git("rev-parse", "origin/main");
  if (local !== remote)
    die(
      "preflight",
      "local main is not origin/main",
      `git pull --ff-only (local ${local.slice(0, 8)}, origin ${remote.slice(0, 8)})`,
    );
  if (git("tag", "--points-at", "HEAD") !== "")
    die("preflight", "HEAD is already tagged — this release was cut");
  if (git("tag", "-l", current) !== "")
    die("preflight", `tag ${current} already exists locally — pull tags or this release was cut`);
  const tipSubject = git("log", "-1", "--format=%s");
  if (!tipSubject.startsWith(`chore(release): ${current}`))
    die(
      "preflight",
      `origin/main's tip is "${tipSubject}", not the release commit for ${current}`,
      "Merge the release PR last: anything merged after it would ship unannounced.",
    );
  console.log(`  deploying ${current} (release commit is origin/main's tip)`);
  await deployAndTag(current);
  process.exit(0);
}

// ── 3. The release commit ────────────────────────────────────────────────────
const date = new Date().toISOString().slice(0, 10);
const renamed = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] - ${date}`);
const ahead = git("rev-list", "--count", "origin/main..HEAD");

if (modePr) {
  if (git("tag", "--points-at", "HEAD") !== "")
    die("preflight", "HEAD is already tagged — this release was cut");
  console.log(
    `\n── release PR: ${current} → ${next} (pin letta_${pin}, ${ahead} commit(s) ahead of origin)`,
  );
  const branch = `release/${next}`;
  if (git("rev-parse", "--verify", branch) !== "")
    die("preflight", `branch ${branch} already exists`, `git branch -D ${branch} to start over`);
  await capture(["git", "checkout", "-q", "-b", branch]);
  await Bun.write(`${ROOT}VERSION`, `${next}\n`);
  await Bun.write(`${ROOT}CHANGELOG.md`, renamed);
  await capture(["git", "add", "VERSION", "CHANGELOG.md"]);
  await capture(["git", "commit", "-m", `chore(release): ${next}`]);
  await capture(["git", "push", "-u", "origin", branch]);
  const body = `## What changes, and why

The release commit: \`VERSION\` ${current} → ${next}, and \`CHANGELOG.md\`'s \`[Unreleased]\`
renamed to the released section. It is opened as a PR rather than pushed straight to \`main\`
because branch protection will not take the direct push once require-PR is on.

## Release hygiene

- \`bump:none\` — this commit *is* the bump; the entries it names are already in the changelog

## Notes for the reviewer

Merge this last: anything merged after it would be deployed and tagged with no changelog entry.
After it merges, \`bun run release --deploy\` runs deploy-check → the exact-tag confirmation →
tag and push the tag; the prod redeploy from \`origin/main\` is the operator's own.`;
  await capture([
    "gh",
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    `chore(release): ${next}`,
    "--label",
    "bump:none",
    "--body",
    body,
  ]);
  await capture(["git", "checkout", "-q", "main"]);
  await capture(["git", "branch", "-q", "-D", branch]);
  console.log(`\n✓ release PR opened for ${next}. Next: merge it, then  bun run release --deploy`);
  process.exit(0);
}

console.log(`\n── release commit`);
if (git("tag", "--points-at", "HEAD") !== "")
  die("preflight", "HEAD is already tagged — this release was cut");
if (ahead === "0" && unreleasedSections().length === 0)
  die(
    "preflight",
    `nothing unreleased to ship — [Unreleased] is empty and main is level with origin`,
  );
await Bun.write(`${ROOT}VERSION`, `${next}\n`);
await Bun.write(`${ROOT}CHANGELOG.md`, renamed);
await capture(["git", "add", "VERSION", "CHANGELOG.md"]);
await capture(["git", "commit", "-m", `chore(release): ${next}`]);
console.log(`  committed chore(release): ${next} (${current} → ${next}, pin letta_${pin})`);
await deployAndTag(next, true);

// ── 4. The shared confirm-push-tag chain ─────────────────────────────────────
async function deployAndTag(tag: string, pushMain = false): Promise<void> {
  console.log("\n── deploy-check (the merged code must be what the local container runs)");
  if ((await run(["bun", "run", "deploy-check"])) !== 0) {
    die(
      "deploy-check",
      pushMain
        ? "undo the release commit with: git reset --soft HEAD~1 && git restore VERSION CHANGELOG.md"
        : "fix whatever deploy-check named — nothing has been pushed or tagged",
    );
  }

  console.log(
    `\nReleasing ${tag}: ${pushMain ? "push origin main → " : ""}tag → push tag. The tag is cut` +
      " as part of the release, immediately now that the release PR has merged; the prod" +
      " redeploy from `origin/main` and its verification are the operator's own.",
  );
  let confirmed = false;
  if (process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type ${tag} to release: `);
    rl.close();
    confirmed = answer.trim() === tag;
  } else {
    if (process.env.RELEASE_CONFIRM === undefined) {
      die(
        "confirmation",
        "not a TTY and RELEASE_CONFIRM is not set — a human must confirm this release",
      );
    }
    confirmed = process.env.RELEASE_CONFIRM === tag;
  }
  if (!confirmed)
    die("confirmation", `the exact tag ${tag} was not confirmed — nothing was pushed or tagged`);

  if (pushMain) {
    console.log("\n── git push origin main");
    await capture(["git", "push", "origin", "main"]);
  }

  console.log("\n── tag");
  await capture(["git", "tag", "-a", tag, "-m", message || `release ${tag}`]);
  await capture(["git", "push", "origin", tag]);

  console.log(
    `\n✓ ${tag} released: ${pushMain ? "pushed and " : ""}tagged. ` +
      "Redeploy prod from `origin/main` and verify it there.",
  );
}
