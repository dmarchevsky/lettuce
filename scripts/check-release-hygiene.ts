/**
 * The release contract, as a gate instead of prose.
 *
 * `AGENTS.md` and the `lettuce-releasing` skill state three rules that nothing
 * used to enforce: a user-visible change carries a `CHANGELOG.md` `[Unreleased]`
 * entry in the same commit; the bump type follows from what that entry says; and
 * `VERSION` agrees with the changelog's newest released section. `deploy-check`
 * asserts the third one, but only at release time and only on a machine with a
 * running stack — so a PR could land with no changelog entry at all and the first
 * anyone heard was a red `deploy-check` weeks later. This runs the same rules
 * where they belong: on the change, in CI, and inside `bun run verify`.
 *
 * Two modes:
 *
 *   bun scripts/check-release-hygiene.ts                          # repo state only
 *   bun scripts/check-release-hygiene.ts --pr [--base <ref>] [--labels a,b] [--subject "..."]
 *
 * Repo-state mode checks `VERSION`/`CHANGELOG.md` as they stand in the checkout.
 * PR mode additionally checks the change: whether a PR that touches `bff/`,
 * `web/` or `docker/` actually added the changelog entry, and whether its declared
 * bump (a `bump:*` label, else the Conventional Commit subject, else the sections
 * it added under `[Unreleased]`) is self-consistent. Labels arrive as `--labels` or
 * the `PR_LABELS` environment variable, and the squash-commit subject as `--subject`,
 * so this script needs no GitHub token — CI passes what `gh pr view` already fetched.
 * On a PR head the local HEAD is not the squash commit, so `--subject` (the PR title)
 * beats `git log` there.
 *
 * An unknown bump type is a warning, not a failure: the release command takes
 * `--minor`/`--patch` from a human, and a wrong label is worth printing rather
 * than worth blocking a green build for. A *missing changelog entry* is fatal.
 *
 * Usage: bun scripts/check-release-hygiene.ts
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** Directories whose changes are user-visible by definition. */
export const APP_DIRS = ["bff/", "web/", "docker/"] as const;

export type Bump = "minor" | "patch" | "none";

export interface PrInput {
  /** Repo-root-relative paths changed by the PR. */
  changedFiles: string[];
  /** Label names on the PR. */
  labels?: string[];
  /** Squash-commit subject, used as the bump fallback. */
  commitSubject?: string;
  /** `### Added` / `### Changed` / `### Fixed` headings this PR added to the changelog. */
  changelogSections?: string[];
}

export interface Findings {
  errors: string[];
  warnings: string[];
  bump: Bump | "unknown";
  bumpWhy: string;
}

/** `v0.6.1-letta_0.34.1` — the exact shape of a release tag (see the `lettuce-releasing` skill). */
export const VERSION_RE = /^v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+$/;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return new TextDecoder().decode(result.stdout).trim();
}

/** Which of the user-visible directories a set of paths touches. */
export function appDirsTouched(files: string[]): string[] {
  const hit = new Set<string>();
  for (const file of files) {
    for (const dir of APP_DIRS) if (file.startsWith(dir)) hit.add(dir.slice(0, -1));
  }
  return [...hit].sort();
}

/**
 * The bump, decided by label first (a PR's author knows what it changed), then by
 * the Conventional Commit subject, then by the changelog headings the PR added.
 * Labels win because squash titles are auto-filled and routinely stale.
 */
export function decideBump(input: PrInput): { bump: Bump | "unknown"; why: string } {
  const labels = input.labels ?? [];
  const declared = labels.filter((l) => l.startsWith("bump:")).map((l) => l.slice(5));
  const bad = declared.filter((d) => d !== "minor" && d !== "patch" && d !== "none");
  if (bad.length) return { bump: "unknown", why: `unknown bump label(s): ${bad.join(", ")}` };
  if (declared.length > 1)
    return { bump: "unknown", why: `conflicting labels: ${declared.join(", ")}` };
  if (declared.length === 1) {
    const bump = declared[0] as Bump;
    const sections = input.changelogSections ?? [];
    const wantsMinor = sections.some((s) => /^(added|changed)$/i.test(s));
    if (wantsMinor && bump === "patch")
      return {
        bump: "unknown",
        why: `bump:patch but the changelog adds an "${sections.find((s) => /^(added|changed)$/i.test(s))}" section — that is a MINOR`,
      };
    return { bump, why: `label bump:${bump}` };
  }

  const subject = (input.commitSubject ?? "").trim();
  const match = subject.match(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)\b/i);
  if (match) {
    const kind = match[1].toLowerCase();
    if (kind === "feat") return { bump: "minor", why: `commit subject "${kind}"` };
    if (kind === "docs") return { bump: "none", why: `commit subject "${kind}"` };
    return { bump: "patch", why: `commit subject "${kind}"` };
  }

  const sections = input.changelogSections ?? [];
  if (sections.some((s) => /^(added|changed)$/i.test(s)))
    return { bump: "minor", why: "changelog adds Added/Changed" };
  if (sections.some((s) => /^fixed$/i.test(s)))
    return { bump: "patch", why: "changelog adds Fixed" };

  return {
    bump: "unknown",
    why: `no bump: label and no Conventional Commit subject ("${subject}")`,
  };
}

/**
 * Everything the release contract says about one change.
 */
export function reviewPr(input: PrInput): Findings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const touched = appDirsTouched(input.changedFiles);
  const labels = input.labels ?? [];
  const changelogEdited = input.changedFiles.includes("CHANGELOG.md");
  const declaredNone = labels.includes("bump:none");

  if (touched.length > 0 && !changelogEdited && !declaredNone) {
    errors.push(
      `touches ${touched.join(", ")} but CHANGELOG.md is untouched. Add an ` +
        "`## [Unreleased]` entry in this PR, or label it bump:none if users " +
        "cannot notice it (see AGENTS.md → Definition of done).",
    );
  }
  if (declaredNone && changelogEdited)
    warnings.push("labeled bump:none yet edits CHANGELOG.md — is it user-visible after all?");
  const { bump, why } = decideBump(input);
  if (touched.length === 0 && !declaredNone && !changelogEdited && bump !== "none")
    warnings.push("touches no user-visible directory; consider labeling it bump:none");
  if (bump === "unknown") warnings.push(`cannot derive the bump: ${why}`);
  return { errors, warnings, bump, bumpWhy: why };
}

/** `VERSION` against `CHANGELOG.md`, exactly as `deploy-check` asserts them at release. */
export function reviewReleaseState(versionText: string, changelogText: string): string[] {
  const errors: string[] = [];
  const version = versionText.trim();
  if (!VERSION_RE.test(version))
    errors.push(`VERSION is not a well-formed release tag: "${version || "(missing)"}"`);
  if (!changelogText.includes("## [Unreleased]"))
    errors.push("CHANGELOG.md has no `## [Unreleased]` section");
  const newest = changelogText.match(/^## \[(v[^\]]+)\]/m)?.[1];
  if (version && newest !== version)
    errors.push(`newest CHANGELOG section is ${newest ?? "none"}, VERSION is ${version}`);
  return errors;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(flag: string): string | null {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

if (import.meta.main) {
  const versionText = await Bun.file(`${ROOT}VERSION`)
    .text()
    .catch(() => "");
  const changelogText = await Bun.file(`${ROOT}CHANGELOG.md`)
    .text()
    .catch(() => "");

  let failures = 0;
  for (const error of reviewReleaseState(versionText, changelogText)) {
    console.error(`  FAIL  ${error}`);
    failures += 1;
  }
  if (failures === 0)
    console.log(`  PASS  VERSION ${versionText.trim()} matches CHANGELOG's newest section`);

  if (process.argv.includes("--pr")) {
    const base = arg("--base") || process.env.PR_BASE || "origin/main";
    const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
    if (changed.length === 0) {
      console.log(`  PR mode: no changes against ${base} — nothing to check`);
    } else {
      // The headings this PR added under [Unreleased], read straight out of the diff.
      const sections = git("diff", "--unified=0", `${base}...HEAD`, "--", "CHANGELOG.md")
        .split("\n")
        .map((line) => line.match(/^\+### (\w+)/)?.[1])
        .filter((s): s is string => Boolean(s));
      const labels = (arg("--labels") || process.env.PR_LABELS || "")
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      const findings = reviewPr({
        changedFiles: changed,
        labels,
        commitSubject: arg("--subject") || git("log", "-1", "--format=%s"),
        changelogSections: sections,
      });
      for (const error of findings.errors) {
        console.error(`  FAIL  ${error}`);
        failures += 1;
      }
      for (const warning of findings.warnings) console.warn(`  WARN  ${warning}`);
      if (failures === 0)
        console.log(
          `  PASS  PR hygiene: ${changed.length} file(s), bump ${findings.bump} (${findings.bumpWhy})`,
        );
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}
