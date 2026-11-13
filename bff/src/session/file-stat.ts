import { stat } from "node:fs/promises";

/**
 * Augments `get_tree` entries with real modification times and file sizes, read
 * directly off the BFF's own mount of the workspace (`docker/compose.yml`).
 *
 * `get_tree` reports only `{path, type}` — no mtime, no size — and the fork
 * that owns the protocol cannot be patched (see CLAUDE.md's zero-fork-delta
 * rule). This never changes which entries are returned, only adds fields to
 * ones the app-server already decided to return, so it cannot show anything
 * `get_tree` itself would have filtered out (symlinks, `.lettaignore`
 * matches, etc.).
 *
 * A stat failure (file removed between the list and this call) just omits
 * both fields for that entry rather than failing the whole response.
 * `size` is omitted for directories on purpose: a directory inode's own
 * size is not a measure of what it contains, so showing one would be
 * actively misleading rather than merely absent.
 */
export async function withModifiedTimes<T extends { path: string; type: "file" | "dir" }>(
  root: string,
  entries: T[],
): Promise<(T & { modified?: number; size?: number })[]> {
  const result: (T & { modified?: number; size?: number })[] = new Array(entries.length);
  let next = 0;
  // Async on purpose, and bounded: a tree is thousands of entries, and the
  // synchronous version held the event loop — every browser's stream with it —
  // for the whole walk. A few at a time keeps the thread pool for other work.
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      // SAFETY: `index` is below `entries.length`, checked on the line above.
      const entry = entries[index] as T;
      try {
        const stats = await stat(resolveEntryPath(root, entry.path));
        result[index] = {
          ...entry,
          modified: stats.mtimeMs,
          ...(entry.type === "file" ? { size: stats.size } : {}),
        };
      } catch {
        result[index] = entry;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, entries.length) }, worker));
  return result;
}

/** How many `stat` calls are in flight at once for one tree. */
const STAT_CONCURRENCY = 16;

/**
 * `get_tree` reports paths relative to the root it was given (see
 * `web/src/tabs/FilesTab.tsx`'s own `resolve()`, which this mirrors) — every
 * other file command wants absolute, so the client and this join the same way.
 */
function resolveEntryPath(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  return `${base}/${relative}`.replace(/\/{2,}/g, "/");
}
