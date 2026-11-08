/**
 * Removing a file or a folder from an agent's workspace (Files → the trash row).
 *
 * There is no way to do this over the app-server protocol. At this pin the file
 * surface is `get_tree`, `list_in_directory`, `search_files`, `grep_in_files`,
 * `read_file`, `write_file`, `edit_file`, `watch_file`, `unwatch_file` — no
 * delete, no rename, no move. (`write_file`'s `move_to` renames only the file
 * that same command just wrote, so it cannot move an existing path out of the
 * way, let alone remove a directory.) Upstream is not ours to patch, so the
 * removal happens here, against the BFF's own bind of the same host directory,
 * and nothing goes upstream.
 *
 * That is why `docker/compose.yml` mounts `${LETTA_STATE_DIR}/workspaces` into
 * this container read-write. Read-only would be safer and is not enough for a
 * delete. What makes it safe is the order below, not the mount flag: a session,
 * then the lexical clamp, then the floor under it, then the symlink walk, then
 * `realpath` re-check, and only then the filesystem. Same shape as
 * `git/routes.ts`, which reads that tree for the same local reason.
 *
 * The handler is a plain function (deps in, `{status, json|text}` out) so the
 * whole guard chain is testable without a Hono app. `index.ts` mounts it.
 */

import { lstatSync, realpathSync, rmSync, type Stats } from "node:fs";
import { normalizePosixPath, WORKSPACE_ROOT } from "../session/protocol.ts";
import { symlinkViolation } from "../session/symlink-guard.ts";

export interface DeleteRouteDeps {
  /** Whether the request carries a valid session; index.ts passes `!!c.get("session")`. */
  hasSession: boolean;
  /** Workspace root; only tests move it off `/work`. */
  root?: string;
  realpath?: (path: string) => string;
  lstat?: (path: string) => Stats;
  /** The removal itself; tests replace it to prove a guard refused before anything was deleted. */
  remove?: (path: string) => void;
}

export interface DeleteRouteResult {
  status: number;
  json?: unknown;
  text?: string;
}

export interface DeleteQuery {
  path?: string;
}

/**
 * `POST /api/files/delete?path=` — remove one file or folder, recursively.
 *
 * The refusal a caller gets back is the guard's own sentence: the Files sheet
 * shows it, and a refusal is the moment a person needs to know *why* the app
 * said no — outside the workspace, an agent's own directory, a symlink.
 */
export async function deleteWorkspaceEntry(
  deps: DeleteRouteDeps,
  query: DeleteQuery,
): Promise<DeleteRouteResult> {
  if (!deps.hasSession) return { status: 401, text: "Unauthorized" };

  const guard = guardEntry(deps, query.path);
  if (!guard.ok) return guard.result;

  try {
    (deps.remove ?? removeWorkspacePath)(guard.real);
  } catch (error) {
    // A removal that fails after every check passed is a filesystem fact we do
    // not argue with (permission, busy, vanished mid-race) — reported, not retried.
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { status: 404, text: "Nothing there to delete" };
    return {
      status: 500,
      text: `Could not delete ${query.path}: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  return { status: 200, json: { deleted: guard.real, type: guard.type } };
}

interface GuardOk {
  ok: true;
  real: string;
  type: "file" | "dir";
}
interface GuardFail {
  ok: false;
  result: DeleteRouteResult;
}

/**
 * Everything that must be true before anything is removed.
 *
 * Order is the security property: the clamp before any filesystem call, the
 * component-wise symlink walk before `realpath` (so nothing is followed on the
 * way to deciding), the realpath re-check before the removal, and the floor
 * checked twice — once lexically, once against the resolved path, so a link or
 * a `..` cannot land the delete on a directory the floor was meant to protect.
 */
function guardEntry(deps: DeleteRouteDeps, rawPath: string | undefined): GuardOk | GuardFail {
  const root = deps.root ?? WORKSPACE_ROOT;
  const realpath = deps.realpath ?? realpathSync;
  const lstat = deps.lstat ?? lstatSync;

  const fail = (result: DeleteRouteResult): GuardFail => ({ ok: false, result });

  if (!rawPath) return fail({ status: 400, text: "Missing path" });
  // A NUL never reaches the filesystem, and `rmSync` would answer it with Node's
  // own argument error — a 500 for what is simply a bad request.
  if (rawPath.includes("\0")) {
    return fail({ status: 400, text: "path contains a null byte" });
  }
  if (!rawPath.startsWith("/")) {
    return fail({ status: 400, text: `path must be an absolute path inside ${root}` });
  }
  const resolved = normalizePosixPath(rawPath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return fail({
      status: 400,
      text: `Path is outside the workspace: ${resolved} is not under ${root}`,
    });
  }

  // The floor: never the workspace itself, never an agent's own directory. Both
  // are what a live turn is standing in — `/work/agent-…` is a runtime's cwd and
  // the whole listing the Files pane is showing — so removing one is not a verb
  // this UI should offer, whatever the path spelling turns out to be.
  //
  // The floor is drawn by DEPTH, not by identity: it refuses `parent === root`
  // rather than checking the name against the list of agents, because the BFF has
  // no agent list to check and a name is the weaker of the two guarantees. The
  // consequence is that everything at depth 2 or deeper is fair game, including a
  // working directory a future worker might be given under an agent's own
  // directory. None exists today — the coding and channel workers all run inside
  // an agent's directory, never below it — so the line holds; if that changes, the
  // floor has to grow a name check with it.
  if (resolved === root || parentOf(resolved) === root) {
    return fail({
      status: 400,
      text: `Refusing to delete ${resolved} — remove its contents instead of a workspace root or an agent's own directory`,
    });
  }

  const symlink = symlinkViolation(resolved, root, lstat);
  if (symlink) return fail({ status: 400, text: symlink });

  let real: string;
  try {
    real = realpath(resolved);
  } catch {
    return fail({ status: 404, text: "Nothing there to delete" });
  }
  const realNormalized = normalizePosixPath(real);
  if (realNormalized !== root && !realNormalized.startsWith(`${root}/`)) {
    return fail({
      status: 400,
      text: `Path is outside the workspace: ${real} is not under ${root}`,
    });
  }
  if (realNormalized === root || parentOf(realNormalized) === root) {
    return fail({
      status: 400,
      text: `Refusing to delete ${real} — remove its contents instead of a workspace root or an agent's own directory`,
    });
  }

  let isDirectory = false;
  try {
    isDirectory = lstat(real).isDirectory();
  } catch {
    return fail({ status: 404, text: "Nothing there to delete" });
  }

  return { ok: true, real, type: isDirectory ? "dir" : "file" };
}

/** The directory above an absolute path, without a trailing slash. */
function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** The default removal: recursive (a folder takes its contents), never silent. */
export function removeWorkspacePath(path: string): void {
  rmSync(path, { recursive: true, force: false });
}
