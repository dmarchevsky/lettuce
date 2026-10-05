/**
 * Asserts feature work happens in a worktree, never in the main checkout.
 *
 * The main checkout must stay on `main` with a clean tree — only merges happen
 * there. Two sessions sharing it collide: one switched the checkout to its
 * branch mid-work and `deploy-check`'s clean-tree and on-`main` assertions then
 * failed on the other's uncommitted changes (observed 2026-09-29). AGENTS.md
 * says worktrees live in `.worktrees/` inside the checkout; this makes the rule
 * a gate instead of a convention — and does not care where the worktree is.
 *
 * A linked worktree is detected the way Git does: its `--git-dir` (the
 * per-worktree dir under `.git/worktrees/…`) differs from its
 * `--git-common-dir` (the shared `.git`). In the main checkout they are the
 * same directory.
 *
 * Detached HEAD passes: it is not a feature branch (merge and bisect states
 * live here), and `main` passes because merges and small fixes land on it.
 *
 * Usage: bun scripts/check-worktree.ts
 */

import { resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// CI checks out a detached HEAD of a branch that exists nowhere else, so there is
// no main checkout to protect and no session to collide with. The gate exists to
// stop an agent from committing feature work in the main checkout on a dev box.
if (process.env.CI === "true") {
  console.log("  CI checkout — worktree rule does not apply");
  process.exit(0);
}

function git(...args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch === null) {
  console.log("  not a git checkout — nothing to check");
  process.exit(0);
}

if (branch === "main" || branch === "HEAD") {
  console.log(`  on ${branch === "main" ? "main" : "detached HEAD"} — allowed`);
  process.exit(0);
}

const gitDir = git("rev-parse", "--absolute-git-dir");
const commonDirRaw = git("rev-parse", "--git-common-dir");
const commonDir = commonDirRaw === null ? null : resolve(ROOT, commonDirRaw);

if (gitDir !== null && commonDir !== null && gitDir !== commonDir) {
  console.log(`  on "${branch}" inside a linked worktree — ${gitDir}`);
  process.exit(0);
}

const name = branch.replaceAll("/", "-");
const dir = `../lettuce-worktrees/${name}`;
console.error(`  on "${branch}" in the MAIN checkout — feature work goes in a worktree.`);
console.error("");
console.error(`  New work:      git worktree add ${dir} -b ${branch}`);
console.error(`  This branch:   git worktree add ${dir} ${branch}`);
console.error(`                 (after the main checkout returns to main: git checkout main)`);
console.error(`  Then cd into the worktree and re-run bun run verify.`);
process.exit(1);
