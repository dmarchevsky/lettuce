/**
 * Remove merged worktrees and local branches — the half of the PR lifecycle that used to be
 * manual bookkeeping (see the `lettuce-pr-and-ci` skill and `AGENTS.md` hard rule 8).
 *
 * Default mode is a report. Nothing is deleted without `--apply`, and nothing is deleted that
 * fails a preflight, which is printed as a reason rather than a warning:
 *
 *   bun run cleanup                    # plan only, changes nothing
 *   bun run cleanup --apply            # remove what passed; type the phrase it prints
 *   bun run cleanup --apply --remote   # also delete the merged branches on origin
 *
 * The rules live in `scripts/cleanup-core.ts` and are tested in `tests/cleanup-core.test.ts`.
 * The short version: **a merged PR is what makes a branch removable — not git ancestry**, because
 * this repo squash-merges and a merged branch is never an ancestor of `main`; and removal is
 * refused for a dirty tree, a detached HEAD, `main` itself, or a worktree with a live process
 * inside it. That last check is the reason this is a script and not a `git worktree remove` loop:
 * a session may be sitting in a worktree with uncommitted work, and squash ancestry cannot tell
 * you that.
 *
 * There is deliberately no `--force`. A refusal means go look, not override me.
 *
 * Confirmation is like `release.ts`: on a TTY you type the exact phrase it prints; a
 * non-interactive caller sets CLEANUP_CONFIRM to that phrase.
 *
 * Run it from the main checkout.
 */

import { existsSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type BranchCandidate,
  confirmPhrase,
  decideBranch,
  decideWorktree,
  type PrState,
  reportRows,
  type WorktreeCandidate,
} from "./cleanup-core.ts";

const args = Bun.argv.slice(2);
const APPLY = args.includes("--apply");
const ALSO_REMOTE = args.includes("--remote");
const SKIP_SESSION_CHECK = args.includes("--skip-session-check");

async function git(...a: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...a], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function gitOk(...a: string[]): Promise<boolean> {
  const proc = Bun.spawn(["git", ...a], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode === 0;
}

async function gh(...a: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...a], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

type WorktreeRow = { path: string; branch: string | null; head: string };

async function listWorktrees(): Promise<WorktreeRow[]> {
  const raw = await git("worktree", "list", "--porcelain");
  const rows: WorktreeRow[] = [];
  let cur: Partial<WorktreeRow> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) rows.push(cur as WorktreeRow);
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).slice(0, 8);
    }
  }
  if (cur.path) rows.push(cur as WorktreeRow);
  return rows;
}

/** `MERGED` | `OPEN` | `CLOSED` from the API, or `none` / `unknown` for our decision logic. */
async function prState(branch: string): Promise<PrState> {
  let out: string;
  try {
    out = await gh(
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "state",
      "--jq",
      '.[0].state // ""',
    );
  } catch {
    return "unknown";
  }
  if (out === "MERGED") return "merged";
  if (out === "OPEN") return "open";
  if (out === "CLOSED") return "closed";
  return out === "" ? "none" : "unknown";
}

/**
 * Processes whose cwd is inside `path`, read from /proc. `null` means "cannot tell" — treated as
 * a refusal by `decideWorktree`, because an unknown is not an absence.
 */
async function liveSessionsUnder(path: string): Promise<number | null> {
  if (!existsSync("/proc")) return null;
  const target = resolve(path);
  let selfPid: number | undefined;
  try {
    selfPid = process.pid;
  } catch {
    selfPid = undefined;
  }
  let count = 0;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (selfPid !== undefined && pid === selfPid) continue;
    let cwd: string;
    try {
      cwd = resolve(await readlink(join("/proc", entry, "cwd")));
    } catch {
      continue;
    }
    if (cwd === target || cwd.startsWith(target + "/")) count++;
  }
  return count;
}

const worktrees = await listWorktrees();
// The first row of `git worktree list` is the main checkout — that ordering is documented, and it
// is the only honest way to know which checkout owns `main`. Deriving it from `--git-common-dir`
// gives `…/.git`, which made the report label the main checkout by branch instead and print paths
// relative to a directory that is not a checkout.
const commonDir = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
const mainCheckout = worktrees.length > 0 ? resolve(worktrees[0].path) : resolve(commonDir || ".");
const stateCache = new Map<string, Promise<PrState>>();
const stateOf = (branch: string) => {
  let p = stateCache.get(branch);
  if (!p) {
    p = prState(branch);
    stateCache.set(branch, p);
  }
  return p;
};

const worktreeRows: { row: WorktreeRow; verdict: ReturnType<typeof decideWorktree> }[] = [];
for (const wt of worktrees) {
  const clean = (await git("-C", wt.path, "status", "--porcelain")) === "";
  const live = SKIP_SESSION_CHECK ? 0 : await liveSessionsUnder(wt.path);
  const candidate: WorktreeCandidate = {
    path: wt.path,
    branch: wt.branch ?? null,
    isMainCheckout: resolve(wt.path) === mainCheckout,
    prState: wt.branch ? await stateOf(wt.branch) : "none",
    clean,
    liveSessions: SKIP_SESSION_CHECK ? 0 : live,
  };
  worktreeRows.push({ row: wt, verdict: decideWorktree(candidate) });
}

const heldByWorktree = new Map(worktrees.map((w) => [w.branch, w.path] as const));
const branchNames = (await git("for-each-ref", "--format=%(refname:short)", "refs/heads"))
  .split("\n")
  .filter((b) => b !== "");
const branchRows: { branch: string; verdict: ReturnType<typeof decideBranch> }[] = [];
for (const branch of branchNames) {
  const holder = heldByWorktree.get(branch) ?? null;
  // A worktree this same pass is going away is not a reason to keep the branch: worktrees are
  // removed before branches, so one pass finishes the job.
  const holderRemoval = worktreeRows.some(
    (r) => r.row.path === holder && r.verdict.action === "remove",
  );
  const candidate: BranchCandidate = {
    branch,
    prState: await stateOf(branch),
    checkedOutIn: holder,
    holderRemoval,
  };
  branchRows.push({ branch, verdict: decideBranch(candidate) });
}

const wt = reportRows(worktreeRows);
const br = reportRows(branchRows);

console.log(`\nWorktrees (main checkout: ${mainCheckout})`);
for (const r of wt.keep) {
  console.log(`  KEEP    ${r.row.path.replace(mainCheckout + "/", "")}  — ${r.verdict.reason}`);
}
for (const r of wt.remove) {
  console.log(`  REMOVE  ${r.row.path.replace(mainCheckout + "/", "")}  — ${r.verdict.reason}`);
}

console.log(`\nLocal branches`);
for (const r of br.keep) {
  console.log(`  KEEP    ${r.branch}  — ${r.verdict.reason}`);
}
for (const r of br.remove) {
  console.log(`  REMOVE  ${r.branch}  — ${r.verdict.reason}`);
}

if (wt.remove.length === 0 && br.remove.length === 0) {
  console.log("\nNothing merged-and-idle to clean up.");
  process.exit(0);
}

const phrase = confirmPhrase(wt.remove.length, br.remove.length);
if (!APPLY) {
  console.log(`\nReport only. To apply: bun run cleanup --apply  (confirm: "${phrase}")`);
  process.exit(0);
}

let confirmed = false;
if (process.stdin.isTTY) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType exactly — ${phrase} — : `);
  rl.close();
  confirmed = answer.trim() === phrase;
} else {
  if (process.env.CLEANUP_CONFIRM === undefined) {
    console.error(
      `\nnot a TTY and CLEANUP_CONFIRM is not set — set it to: ${JSON.stringify(phrase)}`,
    );
    process.exit(1);
  }
  confirmed = process.env.CLEANUP_CONFIRM === phrase;
}

if (!confirmed) {
  console.error("\nconfirmation did not match; nothing removed.");
  process.exit(1);
}

let failures = 0;
for (const r of wt.remove) {
  // No --force, ever: a refusal here means the tree changed since the plan was printed, which is
  // exactly the moment to stop rather than push through.
  if (await gitOk("worktree", "remove", r.row.path)) {
    console.log(`  removed worktree ${r.row.path}`);
  } else {
    console.error(`  FAILED worktree remove ${r.row.path} (now dirty? leave it alone)`);
    failures++;
  }
}
for (const r of br.remove) {
  if (await gitOk("branch", "-D", r.branch)) {
    console.log(`  deleted branch ${r.branch}`);
  } else {
    console.error(`  FAILED branch -D ${r.branch}`);
    failures++;
  }
}

if (ALSO_REMOTE) {
  for (const r of br.remove) {
    const remote = await git("ls-remote", "--heads", "origin", r.branch);
    if (remote === "") continue;
    const proc = Bun.spawn(["git", "push", "origin", "--delete", r.branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    console.log(
      proc.exitCode === 0 ? `  deleted origin/${r.branch}` : `  FAILED origin/${r.branch}`,
    );
  }
}

await git("worktree", "prune");
console.log(
  failures === 0
    ? `\nDone. ${wt.remove.length} worktree(s), ${br.remove.length} branch(es) removed.`
    : `\nDone with ${failures} failure(s) — nothing was forced.`,
);
process.exit(failures === 0 ? 0 : 1);
