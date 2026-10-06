/**
 * This build's identity: the release tag plus the commit it was built from.
 *
 * `VERSION` holds the last *released* tag and only changes at release time (see the
 * `lettuce-releasing` skill), so between two releases every build — prod, a
 * worktree, a CI artifact — reported the same string and nothing could tell them
 * apart without ssh-ing somewhere. This appends the commit as SemVer build
 * metadata, which leaves the tag shape `check-version-pin` and `deploy-check`
 * parse untouched:
 *
 *   a normal commit         v0.6.1-letta_0.34.1+9400080
 *   that commit, dirty      v0.6.1-letta_0.34.1+9400080-dirty
 *   no build info at all    v0.6.1-letta_0.34.1+unknown
 *   no VERSION file         dev
 *
 * The commit is reported even when a tag points at it, for two reasons: it is the
 * answer you actually want ("which commit is running"), and "is HEAD tagged" is
 * not knowable from the metadata an image build can see — an annotated tag ref
 * points at a tag object, and objects are deliberately not in the build context.
 *
 * The SHA has to be decided at *build* time: `.dockerignore` keeps git objects out
 * of the image context and the runtime image has no repository to ask. A builder
 * that has git metadata in its context — a checkout, a CI runner — gets its commit
 * with no `git` binary and no cooperation from whoever runs the build, because what
 * is copied is metadata (`HEAD`, `refs/`, `packed-refs`), which is enough to resolve
 * it. A builder that has none is a supported case, not a failure: a deploy manager
 * builds from a copy of the tree that carries no `.git` at all, so `+unknown` is the
 * honest answer and the deployed commit lives in that manager's own record rather
 * than in the image. See docs/upstream-notes.md#dockhand-builds-without-git.
 *
 * The CLI that prints or bakes this lives in `scripts/build-info.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** The `VERSION` file's tag, e.g. `v0.6.1-letta_0.34.1`. Empty means no file. */
  base: string;
  /** Eight hex characters — enough to be unambiguous here and short enough to read in the UI. Null when nothing could tell us. */
  sha: string | null;
  /** The tree had uncommitted changes when it was built. */
  dirty: boolean;
}

/** The composed version string — the one format every consumer shows. */
export function versionString(info: BuildInfo): string {
  if (info.base === "") return "dev";
  if (!info.sha) return `${info.base}+unknown`;
  return `${info.base}+${info.sha}${info.dirty ? "-dirty" : ""}`;
}

/** The `BUILD_INFO` file a build bakes and the BFF reads back. */
export function encodeBuildInfo(info: BuildInfo): string {
  return `sha=${info.sha ?? ""}\ndirty=${info.dirty ? 1 : 0}\n`;
}

export function decodeBuildInfo(text: string): BuildInfo | null {
  const field = (name: string) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  const sha = field("sha");
  if (sha === undefined) return null;
  return { base: "", sha: sha === "" ? null : sha, dirty: field("dirty") === "1" };
}

/**
 * Resolve HEAD from *copied git metadata* — no objects, no `git` binary. `HEAD` is
 * either a SHA (detached checkout) or a `ref:` pointer into a loose ref or
 * `packed-refs`.
 *
 * Everything it cannot resolve answers `null`, which is what makes an unstamped
 * build a supported outcome rather than a broken one: a tree with no `.git`, an
 * empty `HEAD`, or a linked worktree's `.git` *file* (which points outside any
 * build context) all mean "this builder could not know", and the version says
 * `+unknown`.
 */
export function resolveFromGitMeta(gitDir: string): { sha: string | null } {
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return { sha: null };
  }
  if (head === "") return { sha: null };

  let full: string | null = null;
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (refMatch) {
    const refPath = (refMatch[1] ?? "").trim();
    try {
      full = readFileSync(join(gitDir, refPath), "utf8").trim();
    } catch {
      full = packedRef(join(gitDir, "packed-refs"), refPath);
    }
  } else if (/^[0-9a-f]{7,40}$/.test(head)) {
    full = head;
  }
  return { sha: full ? full.slice(0, 8) : null };
}

function packedRef(path: string, ref: string): string | null {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha) return sha;
    }
  } catch {
    /* no packed-refs */
  }
  return null;
}

/** Resolve from a real checkout with the `git` binary — a dev box or a CI job. */
export function resolveFromGit(repoRoot: string): { sha: string | null; dirty: boolean } {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
  if (run(["rev-parse", "--git-dir"]) === null) return { sha: null, dirty: false };
  const full = run(["rev-parse", "HEAD"]);
  return { sha: full ? full.slice(0, 8) : null, dirty: run(["status", "--porcelain"]) !== "" };
}

/**
 * The build info for a checkout or an image: the baked `BUILD_INFO` wins (it is the
 * builder's answer), then a live `git`, then nothing.
 */
export function readBuildInfo(root: string): BuildInfo {
  const base = readBase(root);
  try {
    const baked = decodeBuildInfo(readFileSync(join(root, "BUILD_INFO"), "utf8"));
    if (baked) return { ...baked, base };
  } catch {
    /* not baked */
  }
  const git = resolveFromGit(root);
  return { base, sha: git.sha, dirty: git.dirty };
}

export function readBase(root: string): string {
  try {
    return readFileSync(join(root, "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}
