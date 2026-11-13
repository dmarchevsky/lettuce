/**
 * The Memory pane's directory tree, built from the paths `list_memory` already sent.
 *
 * Upstream hands the pane a FLAT array — every file with its `relative_path` — because that
 * is what a memory on disk is: a git repo of markdown files, arbitrarily deep. A flat list
 * of 300 `projects/lettuce/notes/deploy.md` strings is neither scannable nor navigable, so
 * the structure is derived here rather than fetched: no command returns a memory tree, and
 * none needs to, because the paths say everything there is to know about it.
 *
 * The output is a FLAT list of rows in tree order with a `depth` and the directory chain
 * each row sits under, rather than a nested object tree. A pane renders rows, and a flat
 * list with a depth is what the CSS indent consumes, so the caller filters on the open set
 * instead of walking children — one loop, no recursion at render time.
 *
 * Rows are keyed by kind + path: a file `notes` and a directory `notes` in the same folder
 * are both legal on disk, and they must not collide.
 */

/** All the tree needs from a memory entry is its path; the caller keeps the rest. */
export interface MemoryPathEntry {
  relative_path: string;
}

export interface MemoryTreeDir {
  kind: "dir";
  /** Full relative path of the directory, no leading or trailing slash. */
  path: string;
  /** The last segment, which is what the row prints. */
  name: string;
  /** Files at any depth below it — a folder's row answers "how much is in there". */
  count: number;
  depth: number;
  /** Directory paths from the root down to this one's parent. */
  ancestors: readonly string[];
}

export interface MemoryTreeFile<T extends MemoryPathEntry = MemoryPathEntry> {
  kind: "file";
  /** The entry's path, which is what opens it. */
  path: string;
  name: string;
  /** Its folder, or "" at the memory root. */
  parent: string;
  depth: number;
  /** Directory paths from the root down to its folder. */
  ancestors: readonly string[];
  /** The caller's own entry, handed back so a row needs no lookup of its own. */
  entry: T;
}

export type MemoryTreeNode<T extends MemoryPathEntry = MemoryPathEntry> =
  | MemoryTreeDir
  | MemoryTreeFile<T>;

/** A filter hit: the file, and the folder that tells it apart from a same-named file. */
export interface MemoryMatch<T extends MemoryPathEntry = MemoryPathEntry> {
  path: string;
  name: string;
  parent: string;
  entry: T;
}

/** A path read as a place in the tree. */
interface ParsedPath {
  /** Normalized: forward slashes, no `.`, no `..` walked past the root, no empty segments. */
  path: string;
  /** The last segment. */
  name: string;
  /** Directory paths from the root down to the file's folder. */
  dirs: string[];
}

/**
 * One pass over a path, because three callers used to read the same string three ways and a
 * memory is exactly the place a hand-written `../` shows up. `..` pops a segment and `.`
 * vanishes, so a path cannot invent a folder that no file lives under — a tree with a
 * phantom level in it is a folder you can open and find nothing in.
 *
 * Backslash is a separator, not a letter: upstream's own listing can arrive with Windows
 * separators (`commands/memory.ts` tests `system\\` beside `system/`), and it normalizes
 * `\\` the same way when it resolves `[[links]]`. A path that walks above the memory root
 * is no file at all — rendering it as a root file would put a click one `write_memory_file`
 * away from a path outside the memory.
 */
function parseMemoryPath(raw: string): ParsedPath | null {
  // Upstream's entries reach the pane through the BFF unvalidated, and there is no error
  // boundary in web/ — so a non-string here would blank the app over one odd entry.
  if (typeof raw !== "string") return null;
  const stack: string[] = [];
  for (const segment of raw.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(segment);
  }
  if (stack.length === 0) return null;
  const name = stack[stack.length - 1] as string;
  const dirs: string[] = [];
  for (const segment of stack.slice(0, -1)) {
    dirs.push(dirs.length ? `${dirs[dirs.length - 1]}/${segment}` : segment);
  }
  return { path: stack.join("/"), name, dirs };
}

/** Names sort case-insensitively and with numbers honoured, so notes2 precedes notes10. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export interface MemoryTreeCounts {
  files: number;
  folders: number;
}

/**
 * Group the listing into rows in tree order: folders first, then files, each alphabetical.
 *
 * Empty directories cannot appear — a directory only exists because a file lives under it —
 * so every directory row has a non-zero count, and a memory with no files renders no rows.
 */
export function buildMemoryTree<T extends MemoryPathEntry>(
  entries: readonly T[],
): MemoryTreeNode<T>[] {
  const filesByParent = new Map<string, MemoryTreeFile<T>[]>();
  const dirsByParent = new Map<string, string[]>();
  const fileCountUnder = new Map<string, number>();

  for (const entry of entries) {
    const parsed = parseMemoryPath(entry.relative_path);
    if (!parsed) continue;
    const parent = parsed.dirs[parsed.dirs.length - 1] ?? "";
    const file: MemoryTreeFile<T> = {
      kind: "file",
      path: parsed.path,
      name: parsed.name,
      parent,
      depth: parsed.dirs.length,
      ancestors: parsed.dirs,
      entry,
    };
    const siblings = filesByParent.get(parent);
    if (siblings) siblings.push(file);
    else filesByParent.set(parent, [file]);
    // Every directory above the file counts it, so a top folder's number is its whole subtree.
    for (const dir of parsed.dirs) {
      fileCountUnder.set(dir, (fileCountUnder.get(dir) ?? 0) + 1);
    }
  }

  for (const dir of fileCountUnder.keys()) {
    const slash = dir.lastIndexOf("/");
    const parent = slash === -1 ? "" : dir.slice(0, slash);
    const name = slash === -1 ? dir : dir.slice(slash + 1);
    const children = dirsByParent.get(parent);
    if (children) children.push(name);
    else dirsByParent.set(parent, [name]);
  }

  const rows: MemoryTreeNode<T>[] = [];
  const emit = (parent: string, depth: number, ancestors: readonly string[]): void => {
    const names = (dirsByParent.get(parent) ?? []).slice().sort(compareNames);
    for (const name of names) {
      const path = parent ? `${parent}/${name}` : name;
      rows.push({
        kind: "dir",
        path,
        name,
        count: fileCountUnder.get(path) ?? 0,
        depth,
        ancestors,
      });
      emit(path, depth + 1, [...ancestors, name]);
    }
    const files = filesByParent.get(parent);
    if (files) rows.push(...files.slice().sort((a, b) => compareNames(a.name, b.name)));
  };
  emit("", 0, []);
  return rows;
}

/** Every directory path in the tree — what expand-all opens, and the bar's folder count. */
export function memoryTreeDirs(rows: readonly MemoryTreeNode[]): string[] {
  return rows.filter((row): row is MemoryTreeDir => row.kind === "dir").map((row) => row.path);
}

/**
 * Whether a row's whole directory chain is open. A directory checks its own ancestors and
 * not itself, so a closed folder still shows itself — it just shows nothing under it.
 */
export function isRowVisible(row: MemoryTreeNode, open: ReadonlySet<string>): boolean {
  return row.ancestors.every((dir) => open.has(dir));
}

/**
 * Files whose name or folder matches, alphabetically.
 *
 * Names and folder paths only: the pane holds every file's content already, so a body
 * search is possible, but a filter box that reads as instant should not wait on scoring
 * 300 documents. `parent` comes back because a match list is flat and two files can share
 * a name in different folders.
 */
export function filterMemoryPaths<T extends MemoryPathEntry>(
  entries: readonly T[],
  query: string,
): MemoryMatch<T>[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: MemoryMatch<T>[] = [];
  for (const entry of entries) {
    const parsed = parseMemoryPath(entry.relative_path);
    if (!parsed) continue;
    const parent = parsed.dirs[parsed.dirs.length - 1] ?? "";
    if (
      parsed.name.toLocaleLowerCase().includes(needle) ||
      parent.toLocaleLowerCase().includes(needle)
    ) {
      matches.push({ path: parsed.path, name: parsed.name, parent, entry });
    }
  }
  return matches.sort((a, b) => compareNames(a.name, b.name) || compareNames(a.path, b.path));
}

/** What the pane's bar says: how much memory there is, in the two nouns a tree shows. */
export function memoryTreeCounts(entries: readonly MemoryPathEntry[]): MemoryTreeCounts {
  const folders = new Set<string>();
  let files = 0;
  for (const entry of entries) {
    const parsed = parseMemoryPath(entry.relative_path);
    if (!parsed) continue;
    files += 1;
    for (const dir of parsed.dirs) folders.add(dir);
  }
  return { files, folders: folders.size };
}
