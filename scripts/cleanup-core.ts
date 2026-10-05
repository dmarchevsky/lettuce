/**
 * Pure decision logic for `bun run cleanup` — kept free of IO so the rules are testable
 * (`tests/cleanup-core.test.ts`) exactly the way `guard-core.ts` keeps the guard's rules
 * testable. The script that uses this is `scripts/cleanup-merged.ts`.
 *
 * The policy these functions encode (see the `lettuce-pr-and-ci` skill):
 *
 *   - A merged PR is what makes a branch removable. Not git ancestry: this repo squash-merges,
 *     so a merged branch is never an ancestor of `main` and `git branch --merged` is meaningless
 *     here. Anything that decides deletion from ancestry is wrong forever.
 *   - A dirty tree, a detached HEAD, the main checkout, an unmerged PR, or a live process with
 *     its cwd inside the worktree stops removal dead. Those are the ways cleanup would eat
 *     someone's work, so they are refusals rather than warnings, and there is no `--force`.
 *   - Staleness that a merge never triggers on — an abandoned branch with no PR, or an open one —
 *     is reported, never removed.
 */

export type PrState = "merged" | "open" | "closed" | "none" | "unknown";

export type WorktreeCandidate = {
  /** Absolute path of the worktree. */
  path: string;
  /** Branch checked out there, or null for a detached HEAD. */
  branch: string | null;
  /** True for the checkout that holds `main`; it is never a candidate. */
  isMainCheckout: boolean;
  prState: PrState;
  /** `git status --porcelain` was empty. */
  clean: boolean;
  /**
   * Processes whose cwd is inside the worktree. `null` means the platform could not tell us,
   * which is a refusal by itself — "unknown" is not "none".
   */
  liveSessions: number | null;
};

export type BranchCandidate = {
  branch: string;
  prState: PrState;
  /** Worktree path that has it checked out, or null when no worktree does. */
  checkedOutIn: string | null;
};

export type Verdict = { action: "remove" | "keep"; reason: string };

const PROTECTED_BRANCHES = new Set(["main"]);

/** The main checkout is never a candidate, and neither is a branch that owns it. */
export function isProtectedBranch(branch: string | null): boolean {
  return branch === null || PROTECTED_BRANCHES.has(branch);
}

/**
 * Decide one worktree. Order matters: the cheapest and most absolute reasons come first, and
 * the first refusal wins, because the operator only needs the one thing that must be fixed.
 */
export function decideWorktree(c: WorktreeCandidate): Verdict {
  if (c.isMainCheckout) return { action: "keep", reason: "main checkout" };
  if (c.branch === null) return { action: "keep", reason: "detached HEAD" };
  if (isProtectedBranch(c.branch)) return { action: "keep", reason: `${c.branch} is protected` };
  if (c.prState !== "merged") {
    const label =
      c.prState === "none"
        ? "no PR"
        : c.prState === "unknown"
          ? "PR state unknown"
          : `PR ${c.prState}`;
    return { action: "keep", reason: `${label} — only a merged PR makes a branch removable` };
  }
  if (!c.clean) return { action: "keep", reason: "uncommitted changes" };
  if (c.liveSessions === null) {
    return { action: "keep", reason: "live sessions unknown on this platform" };
  }
  if (c.liveSessions > 0) {
    return { action: "keep", reason: `${c.liveSessions} live process(es) with cwd inside` };
  }
  return { action: "remove", reason: "PR merged, tree clean, nothing running inside" };
}

/**
 * Decide one local branch that is not checked out anywhere. A branch some worktree holds is
 * that worktree's decision (`decideWorktree`), never this one's — so the two never delete the
 * same thing twice, and a branch in a worktree is never removed from under it.
 */
export function decideBranch(c: BranchCandidate): Verdict {
  if (isProtectedBranch(c.branch)) return { action: "keep", reason: "protected branch" };
  if (c.checkedOutIn !== null)
    return { action: "keep", reason: `checked out in ${c.checkedOutIn}` };
  if (c.prState !== "merged") {
    const label =
      c.prState === "none"
        ? "no PR"
        : c.prState === "unknown"
          ? "PR state unknown"
          : `PR ${c.prState}`;
    return { action: "keep", reason: `${label} — never delete a branch that did not merge` };
  }
  return { action: "remove", reason: "PR merged, no worktree holds it" };
}

/** What a report line should say about a thing that will not be removed. */
export function reportRows<T extends { verdict: Verdict }>(rows: T[]): { remove: T[]; keep: T[] } {
  return {
    remove: rows.filter((r) => r.verdict.action === "remove"),
    keep: rows.filter((r) => r.verdict.action === "keep"),
  };
}

/**
 * The exact phrase a non-interactive run must supply to go through (`CLEANUP_CONFIRM`), so an
 * automation cannot delete anything by accident. Keeping it derived from the counts means the
 * confirmation is tied to the plan that was printed.
 */
export function confirmPhrase(worktrees: number, branches: number): string {
  return `delete ${worktrees} worktrees and ${branches} branches`;
}
