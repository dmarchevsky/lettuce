/**
 * Files → Download, read off the BFF's own mount of the workspace.
 *
 * The download used to go through the app-server: one `read_file` asking for
 * base64, the whole file as a JSON string on the single upstream socket, then
 * decoded into a second copy here — about 60 MB of heap for a 25 MB file, and
 * a frame that size on the connection every agent's stream shares. The bytes
 * are on a mount this process already has (`docker/compose.yml`), so they are
 * streamed from there instead and never enter the heap.
 *
 * Reading the mount directly means the guard is ours alone, with nothing
 * upstream to lean on. Same order as `files/delete.ts` and `git/routes.ts`, and
 * for the same reason — the order is the security property:
 *
 * 1. lexical clamp to the workspace root, before any filesystem call;
 * 2. the component-wise symlink walk, so nothing is followed while deciding;
 * 3. `realpath`, re-clamped, so what is opened is what was checked;
 * 4. a regular file, within the size cap.
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { normalizePosixPath, WORKSPACE_ROOT } from "../session/protocol.ts";
import { symlinkViolation } from "../session/symlink-guard.ts";

export interface DownloadGuardDeps {
  root?: string;
  maxBytes: number;
  /** Injectable for tests. */
  realpath?: (path: string) => string;
  lstat?: (path: string) => Stats;
}

export type DownloadGuard =
  | { ok: true; real: string; size: number; filename: string }
  | { ok: false; status: number; text: string };

export function guardDownload(deps: DownloadGuardDeps, rawPath: string | undefined): DownloadGuard {
  const root = deps.root ?? WORKSPACE_ROOT;
  const realpath = deps.realpath ?? realpathSync;
  const lstat = deps.lstat ?? lstatSync;
  const fail = (status: number, text: string): DownloadGuard => ({ ok: false, status, text });

  if (!rawPath) return fail(400, "Missing path");
  if (!rawPath.startsWith("/")) {
    return fail(400, `path must be an absolute path inside ${root}`);
  }
  const resolved = normalizePosixPath(rawPath);
  if (!resolved.startsWith(`${root}/`)) {
    return fail(400, `Path is outside the workspace: ${resolved} is not under ${root}`);
  }

  const symlink = symlinkViolation(resolved, root, lstat);
  if (symlink) return fail(400, symlink);

  let real: string;
  try {
    real = normalizePosixPath(realpath(resolved));
  } catch {
    return fail(404, "No such file");
  }
  if (!real.startsWith(`${root}/`)) {
    return fail(400, `Path is outside the workspace: ${real} is not under ${root}`);
  }

  let stats: Stats;
  try {
    stats = lstat(real);
  } catch {
    return fail(404, "No such file");
  }
  // Not a directory, and not a device, socket or FIFO either: reading one of
  // those from this process is not a download.
  if (!stats.isFile()) return fail(404, "Not a file");
  if (stats.size > deps.maxBytes) {
    return fail(
      413,
      `File is too large to download (${Math.floor(deps.maxBytes / (1024 * 1024))} MB max)`,
    );
  }

  return { ok: true, real, size: stats.size, filename: real.split("/").pop() || "download" };
}
