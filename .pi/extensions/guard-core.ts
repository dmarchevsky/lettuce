/**
 * The lettuce guard rules, as pure functions.
 *
 * Split out of `guard.ts` (the pi glue) so the matching logic is unit-testable
 * without a harness: `tests/guard-core.test.ts` runs under `bun test`.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface Rule {
  /** Matched against one command segment (split on `&&`, `||`, `;`, `|`, newline). */
  pattern: RegExp;
  title: string;
  message: string;
  /** True = never allowed; no confirmation is offered. */
  hard?: boolean;
}

export interface ProtectedFile {
  /** Repo-root-relative path; a directory protects its subtree. */
  path: string;
  title: string;
  message: string;
  hard?: boolean;
}

/** Every entry is a rule `AGENTS.md` already states in prose. */
export const RULES: Rule[] = [
  {
    // Landing work on a branch is routine; landing it on `main` is the release. The PR flow made
    // every push a confirmation, which meant a human was asked to approve nothing that matters and
    // became the thing they clicked through — so the gate moved to where the risk is.
    pattern: /\bgit\b[^\n]*\bpush\b(?!\w)[^\n]*(?:\bmain\b|--tags\b|--follow-tags\b)/,
    title: "git push to main or tags",
    message:
      "AGENTS.md: pushing `main` or a tag IS the release — never without the operator's " +
      "confirmation for this specific change. Show them the commits first. A feature-branch push " +
      "needs nothing.",
  },
  {
    // A bare `git push` sends whatever branch this checkout is on, and on the main checkout that
    // is `main`. Name the branch and it is free.
    pattern:
      /\bgit\b[^\n]*\bpush\b(?!\w)(?![^\n]*(?:origin|upstream)\s+[\w/.-]+)(?![^\n]*(?:-n\b|--dry-run))/,
    title: "git push with no refspec",
    message:
      "AGENTS.md: a bare push sends the branch you are standing on — on the main checkout that is " +
      "`main`. Name it: `git push origin <branch>`.",
  },
  {
    pattern: /\bgh\b[^\n]*\bpr\s+merge\b/,
    title: "gh pr merge",
    message:
      "AGENTS.md: the operator merges, or authorizes the merge of this specific PR after testing " +
      "it in the container. A general 'continue' is not that authorization.",
  },
  {
    pattern: /\bgh\b[^\n]*\bpr\s+review\b[^\n]*(?:--approve|\bapprove\b)/,
    title: "gh pr review --approve",
    message:
      "AGENTS.md: an approval is the human's statement that they ran it in the container. Never " +
      "approve the PR you authored.",
  },
  {
    pattern: /\bgit\b[^\n]*--force(?!\w)/,
    title: "git --force",
    message:
      "Force operations are not part of this repo's workflow: history stays linear because PRs " +
      "squash-merge, so a PR branch is updated by merging `main` into it, never by force-pushing.",
    hard: true,
  },
  {
    pattern: /\bgit\b[^\n]*\btag\b[^\n]*-a(?!\w)/,
    title: "git tag -a",
    message:
      "AGENTS.md: a tag is created only after the prod deploy is verified (definition of done 7b).",
  },
  {
    pattern: /\bgit\b[^\n]*\bworktree remove\b/,
    title: "git worktree remove",
    message:
      "AGENTS.md: report a merged worktree as safe to remove and let the operator decide. Confirm " +
      "only because they asked for this specific one — another session may be sitting in it " +
      "with uncommitted work.",
  },
  {
    pattern: /\bgit\b[^\n]*\bworktree\s+prune\b/,
    title: "git worktree prune",
    message:
      "AGENTS.md: worktree lifecycle is the operator's; pruning cleans up other peoples' stale entries.",
    hard: true,
  },
  {
    pattern: /\bgit\b[^\n]*\bbranch\s+(?:-d\b|--delete\b)/,
    title: "git branch -d",
    message:
      "AGENTS.md: report the branch instead of deleting it. Confirm only because the operator " +
      "asked for this specific branch.",
  },
  {
    pattern: /\bgit\b[^\n]*\bbranch\s+(?:-D\b|--delete\s+--force|--force\s+--delete)/,
    title: "git branch -D",
    message: "Unmerged branch deletion is not part of this repo's workflow.",
    hard: true,
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\b(?:rm|down|stop|kill)\b/,
    title: "docker compose (destructive)",
    message:
      "This stops or removes running containers. AGENTS.md: prod containers are Dockhand's " +
      "business, and the app-server namespace also holds bff and channel-gateway.",
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b/,
    title: "docker compose restart",
    message:
      "Restarting a service drops the BFF's permanent upstream connection and any turn in flight.",
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$)/,
    title: "recreate app-server",
    message:
      "AGENTS.md: never recreate `app-server` on its own — bff and channel-gateway share its " +
      "network namespace and will be left exited. Prefer the unscoped `up -d`.",
  },
];

/** Files an agent must never touch silently. */
export const PROTECTED_FILES: ProtectedFile[] = [
  {
    path: "docker/.env",
    title: "docker/.env",
    message:
      "docker/.env is gitignored and holds live secrets (SESSION_SECRET, tokens). Confirm only " +
      "if you are intentionally configuring this host, and never echo its values.",
  },
  {
    path: "docker/secrets",
    title: "docker/secrets/",
    message: "docker/secrets/ is gitignored secret storage.",
    hard: true,
  },
  {
    path: "VERSION",
    title: "VERSION",
    message:
      "AGENTS.md: VERSION is bumped by the release commit on main (`bun run release`), never by " +
      "an edit on a feature branch.",
  },
];

/**
 * Commands that only read. Quoting a forbidden command inside a grep or a doc
 * must not trip a gate, so only the "doing" segments of a command line are
 * inspected.
 */
const READ_ONLY =
  /^(?:grep|rg|egrep|fgrep|cat|bat|head|tail|less|more|sed|awk|jq|find|fd|ls|tree|wc|sort|uniq|column|cut|diff|cmp|stat|file|du|echo|printf|which|whereis|man|git\s+(?:log|show|diff|status|blame|cat-file|ls-files|rev-parse))\b/;

export function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;\n|])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !READ_ONLY.test(segment));
}

/** Every rule a single segment trips — a force-push trips two. */
export function rulesForSegment(segment: string): Rule[] {
  return RULES.filter((rule) => rule.pattern.test(segment));
}

/** Every (segment, rule) pair that a command line trips, in order. */
export function reviewCommand(command: string): Array<{ segment: string; rule: Rule }> {
  const hits: Array<{ segment: string; rule: Rule }> = [];
  for (const segment of commandSegments(command)) {
    for (const rule of rulesForSegment(segment)) hits.push({ segment, rule });
  }
  return hits;
}

/** Resolve a tool-supplied path to its real absolute location. */
export function normalizePath(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  // The file may not exist yet (a write); resolve the deepest existing ancestor.
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const base = probe.split(sep).pop();
    if (!base) break;
    tail.unshift(base);
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real = probe;
  try {
    real = realpathSync(probe);
  } catch {
    /* keep the unresolved path */
  }
  return tail.length > 0 ? resolve(real, ...tail) : real;
}

export function relativeToRoot(absPath: string, root: string): string {
  return relative(root, absPath).split(sep).join("/");
}

export function protectedFileFor(repoRelative: string): ProtectedFile | null {
  return (
    PROTECTED_FILES.find(
      (file) => repoRelative === file.path || repoRelative.startsWith(`${file.path}/`),
    ) ?? null
  );
}

/** The protected file a tool path targets, if any. */
export function reviewPath(path: string, cwd: string, root: string): ProtectedFile | null {
  return protectedFileFor(relativeToRoot(normalizePath(path, cwd), root));
}
