/**
 * Which agent a worker run belongs to, derived from the file the worker wrote.
 *
 * Neither Codex nor Claude records a launching agent, and letta-code's synthetic
 * `codex_<thread>` / `claude_<session>` ids are not agents and carry no parent,
 * so nothing on the run says who started it. What does say it is the working
 * directory: a coding worker runs in its parent runtime's cwd, and a UI
 * conversation's runtime runs in `/work/<agent-id>` (docker/compose.yml;
 * `lettuce-coding-workers`). So the workspace IS the attribution — which, unlike
 * a capture at launch time, also works for runs recorded before this existed and
 * for runs the BFF never saw start.
 *
 * What it cannot say: a runtime started without a workspace — cron- and
 * channel-fired ones run in `/work` itself — has no agent to name, and neither
 * has a run from outside `/work`. Those read as unowned rather than being
 * guessed at, and the row's own cwd line stays the proof of where it came from.
 */

import { isAgentId } from "../agents/id-list.ts";

/** The workspace bind mount, and the level above every agent's own directory. */
export const WORKSPACE_ROOT = "/work";

/**
 * The agent whose workspace `cwd` is, or null when it names none.
 *
 * Only the workspace's FIRST segment counts: a worker may `cd` deeper, and the
 * agent that owns the directory above is still the one that started it. `/work`
 * itself, a path elsewhere, a missing cwd, and a first segment that is not a
 * well-formed agent id are all "no agent", not a guess.
 */
export function agentIdFromCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== "string" || cwd === "") return null;
  if (!cwd.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  const [first] = cwd.slice(WORKSPACE_ROOT.length + 1).split("/");
  // A traversal is not a workspace. `isAgentId` refuses the separators and
  // whitespace a segment could carry, but not a bare dot-dot, which is exactly
  // what a browser reaching for something else looks like.
  if (!first || first === "." || first === "..") return null;
  return isAgentId(first) ? first : null;
}

/**
 * Splits a listing into the runs of one agent and the ones the filter dropped.
 *
 * `other` counts what was *scanned* and dropped, not everything on disk: a
 * listing stops after `limit` matches, so the number behind "N other runs" is
 * how much this view hides, which is what the browser can honestly say.
 */
export function splitRunsByAgent<T extends { agentId: string | null }>(
  runs: readonly T[],
  agentId: string,
  limit: number,
): { runs: T[]; other: number } {
  const mine = runs.filter((run) => run.agentId === agentId);
  return { runs: mine.slice(0, limit), other: runs.length - mine.length };
}

/**
 * The same answer from a Claude project directory name, for a transcript that
 * recorded no cwd. Claude Code slugs the absolute path with every
 * non-alphanumeric replaced by `-`, so `/work/<agent-id>` is `-work-<agent-id>`
 * — and since agent ids are themselves alphanumeric-with-dashes, the remainder
 * after the prefix is the id unchanged. Anything else (a nested path, a slug for
 * `/work` itself) names no agent.
 *
 * A slug has no separators left to cut on, so a deeper workspace cannot be told
 * from an id: `/work/agent-1/apps/api` slugs to `-work-agent-1-apps-api`, whose
 * remainder is a well-formed id belonging to nothing. So a claim needs a second
 * opinion — `workspaces` is the directory names actually under the workspace root
 * (the BFF mounts it read-only), and an id absent from it names no agent. Pass an
 * empty set when the root could not be read: no evidence, no claim.
 */
export function agentIdFromWorkspaceSlug(
  slug: string | null | undefined,
  workspaces: ReadonlySet<string> = new Set(),
): string | null {
  if (typeof slug !== "string" || !slug.startsWith(`${WORKSPACE_ROOT.replace(/\//g, "-")}-`)) {
    return null;
  }
  const first = slug.slice(WORKSPACE_ROOT.length + 1);
  return first && isAgentId(first) && workspaces.has(first) ? first : null;
}

/** The workspace directory names to match a slug against: the agent-owned ones. */
export function workspaceAgentIds(names: readonly string[] | null): Set<string> {
  return new Set((names ?? []).filter(isAgentId));
}

/**
 * The `?agent=` query, parsed the same way for all three run listings.
 * A missing or empty value means "everything"; a present one has to be an agent
 * id, so a typo is a 400 rather than a quietly empty list.
 */
export function parseAgentScope(raw: string | undefined | null): { agentId: string | null } | null {
  if (raw === undefined || raw === "") return { agentId: null };
  return isAgentId(raw) ? { agentId: raw } : null;
}

/**
 * How many candidate files a filtered listing may read before it stops looking.
 *
 * A filtered listing has to read past the runs it shows to know what it is
 * hiding, and each read of a Codex rollout is the whole file — so the scan is
 * bounded rather than exhaustive. Unfiltered listings never see this: they stop
 * at `limit` exactly as they always did.
 */
export function scanBudget(limit: number): number {
  return limit * 4;
}
