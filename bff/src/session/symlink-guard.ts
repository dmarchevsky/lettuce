import { lstatSync } from "node:fs";

/**
 * The workspace clamp in `protocol.ts` is lexical: it normalises `.` and `..`
 * and checks the result is under `/work`. That closes traversal, but a symlink
 * is not traversal — `/work/agent-1/link/settings.json` is lexically inside
 * the workspace and resolves anywhere the link points.
 *
 * The app-server does not resolve links either. `read_file` calls `readFile`
 * directly and `write_file` writes through, with no `realpath` or `lstat`
 * anywhere in `websocket/listener/file-commands.ts`. So an agent — which can
 * create symlinks, and whose `skill_enable` symlinks directories into
 * `/root/.letta/skills` by design — can plant
 * `/work/<id>/link -> /root/.letta` and read or write through it from a
 * browser request that passes every lexical check.
 *
 * The fix is to check each component on the way down rather than the whole
 * path at the end. If no component of a path is a symlink, then every
 * component is a real directory and the resolved path IS the path, so a
 * component-wise `lstat` is sufficient — no `realpath` needed, and nothing
 * follows a link in the process of checking it.
 *
 * This runs in the BFF against its own bind of the same host directory
 * (`docker/compose.yml`), so it sees exactly the tree the app-server will write
 * to. The BFF can write that tree now — one route, `POST /api/files/delete` —
 * which is precisely why that route re-runs this guard on the path it was handed
 * rather than trusting the mount to hold it still.
 */

export type Lstat = (path: string) => { isSymbolicLink(): boolean };

/**
 * Why this path escapes through a symlink, or null when it does not.
 *
 * A component that does not exist is NOT a violation: `write_file` creates
 * parents, so the tail of a legitimate new-file path is routinely absent.
 * Only a component that exists and is a symlink refuses. Anything else the
 * `lstat` throws for (permissions, ELOOP) is treated as a refusal too —
 * being unable to prove a path safe is not the same as proving it safe, and
 * `ELOOP` in particular is a symlink cycle saying exactly that.
 */
export function symlinkViolation(
  path: string,
  root: string,
  lstat: Lstat = lstatSync,
): string | null {
  // Walk from the root down, one component at a time, so the first link
  // encountered is named in the refusal.
  const relative = path === root ? "" : path.slice(root.length + 1);
  let current = root;
  for (const component of relative.split("/")) {
    if (!component) continue;
    current = `${current === "/" ? "" : current}/${component}`;
    let stats: { isSymbolicLink(): boolean };
    try {
      stats = lstat(current);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return `Cannot verify ${current} is free of symlinks: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
    }
    if (stats.isSymbolicLink()) {
      return `Path component ${current} is a symlink; refusing to follow it out of ${root}`;
    }
  }
  return null;
}
