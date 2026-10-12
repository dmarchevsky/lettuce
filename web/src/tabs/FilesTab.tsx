import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BranchSheet } from "../components/BranchSheet.tsx";
import { FileViewer } from "../components/FileViewer.tsx";
import { GitHistorySheet } from "../components/GitHistorySheet.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { shortDate } from "../lib/conversation-groups.ts";
import { downloadUrl, formatBytes, triggerDownload } from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import { fetchGitRepo } from "../lib/git.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { agentWorkspace, WORKSPACE_ROOT } from "../lib/workspace.ts";
import type { SessionApi } from "../state/use-session.ts";

interface TreeEntry {
  /** Relative to the requested root, not absolute. */
  path: string;
  type: "file" | "dir";
  /** Epoch ms, merged in by the BFF via a direct stat() — see file-stat.ts. */
  modified?: number;
  /** Bytes, merged in the same way. Directories don't get one — see file-stat.ts. */
  size?: number;
}

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * get_tree returns paths relative to its root; every other command wants
 * absolute. Normalising here matters: the previous version stripped a trailing
 * slash, which turned a root of "/" into "" and produced root-relative paths
 * like "/agent-local-…" that the workspace clamp then (correctly) refused.
 */
export function resolve(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  return `${base}/${relative}`.replace(/\/{2,}/g, "/");
}

/**
 * The directory above `path`, or null at the workspace root.
 *
 * Clamped deliberately: without a floor this walked to "/", which the BFF
 * refuses — leaving the previous listing on screen with no way back down.
 */
export function parentDirectory(path: string): string | null {
  if (path === WORKSPACE_ROOT || !path.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  const parent = path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return parent.length >= WORKSPACE_ROOT.length ? parent : WORKSPACE_ROOT;
}

/**
 * The absolute path for a "New file" name typed into the sheet, or null when
 * the name is not a plain filename. The sheet creates a file in the CURRENT
 * directory — nested paths are made by navigating first — so any separator,
 * traversal component or absolute path is refused here rather than silently
 * creating directories the user did not ask for. (`write_file` does `mkdir -p`
 * on the parent, so an unchecked `a/b` would happily build `a`.)
 */
export function newFilePath(root: string, name: string): string | null {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("/") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  return resolve(root, trimmed);
}

/**
 * Whether the pane bar offers Branch and History. The BFF decides repo-ness
 * (git is not in the app-server image, and upstream has only branch
 * commands), so the answer is per-folder and arrives a moment after the
 * listing.
 *
 * Hidden while unknown: in flight, a failed request, or any answer that is not
 * `repo: true`. A git folder therefore gains the buttons a beat after its
 * files appear; a plain one never shows buttons whose sheets could only say
 * "this folder isn't a git repository". An answer for another path is not an
 * answer about this one — that is the race guard for a slow probe racing a
 * navigation.
 */
export function gitActionsVisible(
  probe: { path: string; repo: boolean } | null,
  root: string,
): boolean {
  return !!probe?.repo && probe.path === root;
}

interface Props {
  session: SessionApi;
  /** Working directory of the active runtime; the tree is rooted here. */
  cwd: string | null;
  /** Fallback root before the first device status arrives. */
  agentId: string | null;
}

export function FilesTab({ session, cwd, agentId }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GrepMatch[] | null>(null);
  /** A failed list or search: the amber box. Progress is `progress`, below. */
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  /** The last git answer we trust, tagged with the folder it was about. */
  const [repoProbe, setRepoProbe] = useState<{ path: string; repo: boolean } | null>(null);
  /** The folder the last `load` asked for — what a probe answer must match. */
  const loadedPath = useRef<string | null>(null);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedEntries = useMemo(() => {
    const factor = sortDir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (sortKey === "modified") {
        return ((a.modified ?? 0) - (b.modified ?? 0)) * factor;
      }
      if (sortKey === "size") {
        return ((a.size ?? 0) - (b.size ?? 0)) * factor;
      }
      return a.path.localeCompare(b.path) * factor;
    });
  }, [entries, sortKey, sortDir]);

  useEffect(() => {
    if (root) return;
    // Prefer the runtime's reported cwd, but fall back to the agent's own
    // directory so the tab is usable before the first device status frame.
    const initial = cwd ?? (agentId ? agentWorkspace(agentId) : null);
    if (initial) setRoot(initial);
  }, [cwd, agentId, root]);

  /**
   * Drop everything tied to the directory we failed to open. Entries are
   * RELATIVE names; leaving them on screen after a failure meant the next click
   * joined them onto a root they never belonged to.
   */
  const failed = useCallback((message: string) => {
    setStatus(message);
    setEntries([]);
    setMatches(null);
    setSelected(null);
  }, []);

  /**
   * Ask the BFF whether `path` is inside a repository, in parallel with the
   * listing. No cache: a folder the agent `git init`s while you watch it gains
   * the buttons on the next load, and a stale cache is the only way a plain
   * folder ends up with two dead buttons. An answer that raced a navigation is
   * dropped — the ref holds the folder actually on screen.
   */
  const probeGitRepo = useCallback(async (path: string) => {
    let repo = false;
    try {
      repo = (await fetchGitRepo(path)).repo;
    } catch {
      repo = false;
    }
    if (loadedPath.current !== path) return;
    setRepoProbe({ path, repo });
  }, []);

  const load = useCallback(
    async (path: string) => {
      loadedPath.current = path;
      void probeGitRepo(path);
      setProgress("Loading…");
      try {
        const response = await session.request<{
          entries?: TreeEntry[];
          success?: boolean;
          error?: string;
        }>("get_tree", { path, depth: 1 });
        if (response?.success === false) {
          failed(response.error ?? "Could not list the directory");
          return;
        }
        setEntries(response?.entries ?? []);
        setStatus("");
        setProgress("");
      } catch (cause) {
        failed(errorMessage(cause));
      }
    },
    [session, failed, probeGitRepo],
  );

  useEffect(() => {
    if (root) void load(root);
  }, [root, load]);

  /**
   * Git controls follow the folder, not the last folder that happened to be a
   * repository: navigating from a repo to a plain directory closes a sheet
   * that can no longer say anything true about what is on screen.
   */
  const showGitActions = gitActionsVisible(repoProbe, root ?? "");
  useEffect(() => {
    if (showGitActions) return;
    setBranchesOpen(false);
    setHistoryOpen(false);
  }, [showGitActions]);

  /** Hand the file to the browser's download manager via the BFF's HTTP route. */
  const downloadFile = (path: string) => {
    triggerDownload(downloadUrl(path));
  };

  const search = async () => {
    if (!root || !query.trim()) {
      setMatches(null);
      return;
    }
    setStatus("");
    setProgress("Searching…");
    try {
      // The parameter is `query`; sending `pattern` fails validation silently.
      const response = await session.request<{
        matches?: GrepMatch[];
        total_matches?: number;
        success?: boolean;
        error?: string;
      }>("grep_in_files", { query, cwd: root, max_results: 200 });
      if (response?.success === false) {
        setStatus(response.error ?? `Could not search ${root}`);
        return;
      }
      setMatches(response?.matches ?? []);
      setStatus("");
      setProgress("");
    } catch (cause) {
      setStatus(`Could not search ${root}: ${errorMessage(cause)}`);
    } finally {
      setProgress("");
    }
  };

  const parent = root ? parentDirectory(root) : null;

  if (!root) {
    return (
      <div className="pane">
        <p className="muted">Start a conversation to browse its working directory.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        <button
          type="button"
          className="link"
          disabled={!parent}
          onClick={() => parent && setRoot(parent)}
        >
          <Icon name="up" /> Up
        </button>
        <code className="path">{root}</code>
        <span className="spacer" />
        {/* Only in a folder that git says is a repository — see
            `gitActionsVisible`. Both sheets keep their own "isn't a git
            repository" state as the fallback for a repo vanishing between
            this probe and the click. */}
        {showGitActions ? (
          <>
            <button
              type="button"
              className="link"
              onClick={() => setHistoryOpen(true)}
              title="Browse git history"
            >
              <Icon name="history" /> History
            </button>
            <button
              type="button"
              className="link"
              onClick={() => setBranchesOpen(true)}
              title="Switch git branch"
            >
              <Icon name="branch" /> Branch
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="link"
          onClick={() => setNewFileOpen(true)}
          title="Create a text file here"
        >
          <Icon name="plus" /> New file
        </button>
      </div>

      <div className="pane-bar">
        <input
          value={query}
          placeholder="Search file contents…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
        />
        <button type="button" className="link" onClick={() => void search()}>
          Find
        </button>
        {matches ? (
          <button type="button" className="link" onClick={() => setMatches(null)}>
            Clear
          </button>
        ) : null}
      </div>

      {progress && !status ? <p className="muted small pad">{progress}</p> : null}
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button
            type="button"
            className="link"
            onClick={() => (query.trim() ? void search() : root ? void load(root) : null)}
          >
            Try again
          </button>
        </p>
      ) : null}

      {matches ? (
        <ul className="list">
          {matches.length === 0 ? <li className="muted pad">No matches</li> : null}
          {matches.map((match, index) => (
            // A search can hit the same line of the same file twice; the result
            // list is replaced whole, never reordered in place.
            // biome-ignore lint/suspicious/noArrayIndexKey: path and line alone are not unique
            <li key={`${match.path}:${match.line}:${index}`}>
              <button
                type="button"
                className="row"
                onClick={() => setSelected(resolve(root, match.path))}
              >
                <span className="grow-text">
                  <code className="small">
                    {match.path}:{match.line}
                  </code>
                  <div className="muted small match-text">{match.text.trim()}</div>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="file-row file-row-head">
            <span className="file-sort-label muted small">Sort by</span>
            <button type="button" className="link grow-row" onClick={() => toggleSort("name")}>
              Name
              <SortMark active={sortKey === "name"} dir={sortDir} />
            </button>
            <button type="button" className="link file-size" onClick={() => toggleSort("size")}>
              Size
              <SortMark active={sortKey === "size"} dir={sortDir} />
            </button>
            <button
              type="button"
              className="link file-modified"
              onClick={() => toggleSort("modified")}
            >
              Modified
              <SortMark active={sortKey === "modified"} dir={sortDir} />
            </button>
            {/* Matches the download slot's box exactly (same classes) so this
                header row is exactly as wide as a body row — see styles.css. */}
            <span className="icon-button ghost file-download-placeholder" aria-hidden="true" />
          </div>
          <ul className="list">
            {sortedEntries.map((entry) => {
              const absolute = resolve(root, entry.path);
              return (
                <li key={entry.path} className="file-row">
                  {/* Name and download are siblings, not nested: a button cannot
                      contain a button, which is why the whole row used to be one. */}
                  <button
                    type="button"
                    className="row grow-row"
                    onClick={() => {
                      if (entry.type === "dir") setRoot(absolute);
                      else setSelected(absolute);
                    }}
                  >
                    <Icon name={entry.type === "dir" ? "folder" : "file"} />
                    <span className="file-name">
                      <span className="file-name-text">{entry.path}</span>
                      {/* The size and date columns, folded under the name where
                          there is no room for columns (a phone). */}
                      <span className="file-meta muted small">
                        {[
                          entry.type === "dir"
                            ? "Folder"
                            : entry.size !== undefined
                              ? formatBytes(entry.size)
                              : null,
                          entry.modified ? shortDate(entry.modified) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                  <span className="muted small file-size">
                    {entry.size !== undefined ? formatBytes(entry.size) : "—"}
                  </span>
                  <span
                    className="muted small file-modified"
                    title={
                      entry.modified
                        ? formatEntryTimeFull(new Date(entry.modified).toISOString())
                        : undefined
                    }
                  >
                    {entry.modified ? shortDate(entry.modified) : "—"}
                  </span>
                  {/* Directories have nothing to hand over: there is no archive
                      command in the protocol, so ask the agent to tar one. A
                      placeholder still renders in their slot — same classes,
                      hidden — so Size/Modified line up with file rows either way. */}
                  {entry.type === "file" ? (
                    <button
                      type="button"
                      className="icon-button ghost"
                      title={`Download ${entry.path}`}
                      aria-label={`Download ${entry.path}`}
                      onClick={() => downloadFile(absolute)}
                    >
                      <Icon name="download" />
                    </button>
                  ) : (
                    <span
                      className="icon-button ghost file-download-placeholder"
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })}
            {entries.length === 0 && !status && !progress ? (
              <li className="muted pad">Empty</li>
            ) : null}
          </ul>
        </>
      )}

      {selected ? (
        <FileViewer
          session={session}
          path={selected}
          onClose={() => setSelected(null)}
          onSaved={() => void load(root)}
          key={selected}
        />
      ) : null}

      {newFileOpen ? (
        <NewFileSheet
          root={root}
          existing={entries.filter((entry) => entry.type === "file").map((entry) => entry.path)}
          session={session}
          onClose={() => setNewFileOpen(false)}
          onCreated={(path) => {
            setNewFileOpen(false);
            void load(root);
            setSelected(path);
          }}
        />
      ) : null}

      {branchesOpen && showGitActions ? (
        <BranchSheet session={session} cwd={root} onClose={() => setBranchesOpen(false)} />
      ) : null}

      {historyOpen && showGitActions ? (
        <GitHistorySheet cwd={root} onClose={() => setHistoryOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * Create one text file in the current directory. `write_file` overwrites, so
 * an existing name is refused client-side before the request — the sheet is
 * not the place to lose a file by accident.
 */
function NewFileSheet({
  root,
  existing,
  session,
  onClose,
  onCreated,
}: {
  root: string;
  existing: string[];
  session: SessionApi;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const path = newFilePath(root, name);
    if (!path) {
      setStatus("Enter a plain filename — no path separators.");
      return;
    }
    if (existing.includes(name.trim())) {
      setStatus(`${name.trim()} already exists here.`);
      return;
    }
    setStatus("");
    setSaving(true);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>("write_file", {
        path,
        content,
      });
      if (response?.success === false) {
        toast(response.error ?? `Could not create ${name.trim()}`, "bad");
        return;
      }
      onCreated(path);
    } catch (cause) {
      toast(`Could not create ${name.trim()}: ${errorMessage(cause)}`, "bad");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="New file"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={saving || !name.trim()}
            onClick={() => void create()}
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        File name
        <input
          value={name}
          placeholder="notes.md"
          onChange={(event) => {
            setName(event.target.value);
            setStatus("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
      </label>
      {status ? (
        <p className="small bad" role="alert">
          {status}
        </p>
      ) : null}
      <p className="muted small">Created in {root}</p>
      <textarea
        className="file-editor"
        placeholder="(empty file)"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
      />
    </Sheet>
  );
}

/** The active column's direction; nothing on the others. */
function SortMark({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return <Icon name={dir === "asc" ? "up" : "arrow-down"} className="sort-mark" />;
}
