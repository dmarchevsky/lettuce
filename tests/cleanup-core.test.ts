import { describe, expect, test } from "bun:test";
import {
  type BranchCandidate,
  confirmPhrase,
  decideBranch,
  decideWorktree,
  isProtectedBranch,
  reportRows,
  type WorktreeCandidate,
} from "../scripts/cleanup-core.ts";

function wt(over: Partial<WorktreeCandidate> = {}): WorktreeCandidate {
  return {
    path: "/repo/.worktrees/thing",
    branch: "feat/thing",
    isMainCheckout: false,
    prState: "merged",
    clean: true,
    liveSessions: 0,
    ...over,
  };
}

function br(over: Partial<BranchCandidate> = {}): BranchCandidate {
  return {
    branch: "feat/thing",
    prState: "merged",
    checkedOutIn: null,
    holderRemoval: false,
    ...over,
  };
}

describe("a merged PR is what makes a worktree removable", () => {
  test("merged, clean, nothing running inside — remove", () => {
    expect(decideWorktree(wt()).action).toBe("remove");
  });

  test("an open or closed PR is never removable", () => {
    for (const prState of ["open", "closed", "none", "unknown"] as const) {
      const v = decideWorktree(wt({ prState }));
      expect(v.action).toBe("keep");
      expect(v.reason).toContain(prState === "none" ? "no PR" : prState);
    }
  });

  test("uncommitted work stops removal — this is the case the rule exists for", () => {
    const v = decideWorktree(wt({ clean: false }));
    expect(v.action).toBe("keep");
    expect(v.reason).toContain("uncommitted");
  });

  test("a live process inside is a refusal, and unknown is not zero", () => {
    expect(decideWorktree(wt({ liveSessions: 2 })).reason).toContain("2 live process");
    expect(decideWorktree(wt({ liveSessions: null })).reason).toContain("unknown");
    expect(decideWorktree(wt({ liveSessions: null })).action).toBe("keep");
  });

  test("the main checkout and a detached HEAD are untouchable", () => {
    expect(decideWorktree(wt({ isMainCheckout: true, branch: "main" })).reason).toContain(
      "main checkout",
    );
    expect(decideWorktree(wt({ branch: null })).reason).toContain("detached");
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch(null)).toBe(true);
    expect(isProtectedBranch("feat/x")).toBe(false);
  });

  test("the first refusal wins, cheapest reason first", () => {
    // Unmerged *and* dirty: the PR is the fact that matters, because it is what makes the
    // branch deletable at all.
    expect(decideWorktree(wt({ prState: "open", clean: false })).reason).toContain("PR open");
  });
});

describe("local branches not held by a worktree", () => {
  test("merged and idle — remove", () => {
    expect(decideBranch(br()).action).toBe("remove");
  });

  test("a branch a worktree holds is that worktree's decision", () => {
    const v = decideBranch(br({ checkedOutIn: "/repo/.worktrees/thing" }));
    expect(v.action).toBe("keep");
    expect(v.reason).toContain("checked out in");
  });

  test("…but a worktree being removed in the same pass is not a reason to keep it", () => {
    const v = decideBranch(br({ checkedOutIn: "/repo/.worktrees/thing", holderRemoval: true }));
    expect(v.action).toBe("remove");
    expect(v.reason).toContain("worktree is being removed");
    // An unmerged branch stays protected even when its worktree goes: the holder is not what
    // makes deletion safe, the merged PR is.
    expect(
      decideBranch(br({ prState: "open", checkedOutIn: "/w", holderRemoval: true })).action,
    ).toBe("keep");
  });

  test("main and unmerged branches are never deleted", () => {
    expect(decideBranch(br({ branch: "main" })).action).toBe("keep");
    expect(decideBranch(br({ prState: "open" })).action).toBe("keep");
    expect(decideBranch(br({ prState: "none" })).reason).toContain("no PR");
  });
});

describe("reporting and confirmation", () => {
  test("reportRows splits on the verdict", () => {
    const rows = [
      { verdict: decideWorktree(wt()) },
      { verdict: decideWorktree(wt({ clean: false })) },
    ];
    const split = reportRows(rows);
    expect(split.remove.length).toBe(1);
    expect(split.keep.length).toBe(1);
  });

  test("the confirmation phrase is tied to the plan", () => {
    expect(confirmPhrase(2, 5)).toBe("delete 2 worktrees and 5 branches");
    expect(confirmPhrase(1, 1)).toBe("delete 1 worktree and 1 branch");
    expect(confirmPhrase(0, 1)).toBe("delete 0 worktrees and 1 branch");
    // A plan changed after the phrase was printed must not be confirmed by the old phrase.
    expect(confirmPhrase(2, 5)).not.toBe(confirmPhrase(2, 6));
  });
});
