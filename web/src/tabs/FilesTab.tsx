import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BranchSheet } from "../components/BranchSheet.tsx";
import { FileViewer } from "../components/FileViewer.tsx";
import { GitHistorySheet } from "../components/GitHistorySheet.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { shortDate } from "../lib/conversation-groups.ts";
import { deleteWorkspacePath } from "../lib/delete.ts";
import { downloadUrl, formatBytes, triggerDownload } from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import { fetchGitRepo } from "../lib/git.ts";
import { formatEntryTimeFull } from "../lib/timestamps.ts";
import { MAX_UPLOAD_BYTES, uploadWorkspaceFile } from "../lib/upload.ts";
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
  if (!isPlainFileName(trimmed)) return null;
  return resolve(root, trimmed);
}

/** A name a file in this folder may have: not empty, not traversal, no separators. */
export function isPlainFileName(name: string): boolean {
  return !(
    name === "" ||
    name === "." ||
    name === ".." ||
    name.startsWith("/") ||
    name.includes("/") ||
    name.includes("\\")
  );
}

/**
 * Whether `path` names `ancestor` or anything under it — the test the delete
 * confirmation applies to the file viewer: a deleted ancestor takes the open
 * file with it, and leaving the viewer up on a path that no longer exists is a
 * pane that can only fail on its next save.
 */
export function isSameOrInside(path: string, ancestor: string): boolean {
  const base = ancestor.replace(/\/+$/, "");
  const candidate = path.replace(/\/+$/, "");
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * Why this upload cannot go under `name`, or null when it can. A collision is
 * refused rather than auto-suffixed: Files has no rename, so the name field is
 * where a clash has to be resolved — and a silent ` (1)` would hide that the
 * file you meant to replace is still there.
 *
 * The check is against the listing on screen. A file the agent wrote a moment
 * ago is not in it and would be overwritten: upstream's base64 write has no
 * create-only mode, and this is a UX guard, not a guarantee.
 */
export function uploadNameProblem(name: string, existing: string[]): string | null {
  const trimmed = name.trim();
  if (!isPlainFileName(trimmed)) return "Enter a plain filename — no path separators.";
  if (existing.includes(trimmed)) return `${trimmed} already exists here — type a different name.`;
  return null;
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
  /**
   * The entry a trash button was pressed on, waiting for the confirm. Held as
   * `{path, type}` rather than a boolean because the sheet says both what it is
   * and where it lives, and a folder's sentence is different (“and everything
   * inside it”).
   */
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    type: "file" | "dir";
  } | null>(null);
  /** The picked file is what keeps the Upload sheet open; null closes it. */
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
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

  // Another agent is a different directory, not a folder you navigated to, so the
  // switch has to clear what the last agent's directory was: `root` is set once below
  // and held across everything else, and a kept-open pane now changes agent under it.
  const lastAgent = useRef(agentId);
  useEffect(() => {
    if (lastAgent.current === agentId) return;
    lastAgent.current = agentId;
    // Set the new root, do not clear it: a child's effects run before its parent's, so
    // clearing here would let the init effect below capture the previous agent's
    // conversation `cwd` before anything had a chance to clear it. The agent's own
    // directory is the honest answer until a runtime of the new agent reports its own.
    setRoot(agentId ? agentWorkspace(agentId) : null);
    setEntries([]);
    setSelected(null);
    setQuery("");
    setMatches(null);
    setStatus("");
    setProgress("");
    setRepoProbe(null);
    // The load guard is per folder, and this folder is gone.
    loadedPath.current = null;
  }, [agentId]);

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
      <div className="pane-bar wrap">
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
        {/* The picker is invisible and the button is its label — the composer's
            paperclip pattern (`attach-input`). No `accept`: any file type is
            allowed, since the workspace is the user's own and inline serving is
            allowlisted to PDFs and rasters. One file at a time, because a
            collision is resolved by typing a new name. */}
        <input
          ref={fileInput}
          type="file"
          className="attach-input"
          tabIndex={-1}
          onChange={(event) => {
            const [picked] = Array.from(event.target.files ?? []);
            // Clear it so picking the same file twice re-opens the sheet.
            event.target.value = "";
            if (picked) setUploadFile(picked);
          }}
        />
        <button
          type="button"
          className="link"
          onClick={() => fileInput.current?.click()}
          title="Upload a file here"
        >
          <Icon name="upload" /> Upload
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
            {/* Matches the body row's two action slots exactly (same classes) so
                this header row is exactly as wide as a body row — see styles.css. */}
            <span className="icon-button ghost file-download-placeholder" aria-hidden="true" />
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
                      hidden — so Size/Date line up with file rows either way.
                      They are deletable, though: a folder is what `rm -r` is for,
                      and the confirm is where the cost of that gets said. */}
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
                  {/* At the workspace root every row is an agent's own directory,
                      which the route refuses by the same floor the panel refuses
                      to climb — so no trash is offered there. A placeholder holds
                      the column, and the row stays clickable to open it. */}
                  {root === WORKSPACE_ROOT ? (
                    <span
                      className="icon-button ghost file-delete-placeholder"
                      aria-hidden="true"
                    />
                  ) : (
                    <button
                      type="button"
                      className="icon-button ghost"
                      title={`Delete ${entry.path}`}
                      aria-label={`Delete ${entry.path}`}
                      onClick={() => setDeleteTarget({ path: absolute, type: entry.type })}
                    >
                      <Icon name="trash" />
                    </button>
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

      {deleteTarget ? (
        <DeleteEntrySheet
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(path, type) => {
            setDeleteTarget(null);
            // The listing is the truth about this folder and we have just changed
            // it; the viewer only if the path it is showing is gone with it.
            void load(root);
            if (selected && isSameOrInside(selected, path)) setSelected(null);
            toast(`${type === "dir" ? "Folder" : "File"} deleted: ${path.split("/").pop()}`);
          }}
        />
      ) : null}

      {uploadFile ? (
        <UploadSheet
          file={uploadFile}
          root={root}
          existing={entries.filter((entry) => entry.type === "file").map((entry) => entry.path)}
          onClose={() => setUploadFile(null)}
          onUploaded={(name) => {
            setUploadFile(null);
            void load(root);
            toast(`${name} uploaded`);
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

/**
 * The one confirm between a row's trash button and an undoable removal.
 *
 * It names the entry, prints the full path, and for a folder says plainly that
 * everything inside it goes too. There is no trash to restore from and no undo,
 * so the sheet's job is not to explain a feature — it is to make the cost of the
 * press legible before it lands. A workspace is also where an agent may be
 * working right now, which is the other sentence.
 */
function DeleteEntrySheet({
  target,
  onClose,
  onDeleted,
}: {
  target: { path: string; type: "file" | "dir" };
  onClose: () => void;
  onDeleted: (path: string, type: "file" | "dir") => void;
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const name = target.path.split("/").filter(Boolean).pop() ?? target.path;
  const folder = target.type === "dir";

  const remove = async () => {
    setBusy(true);
    setStatus("");
    try {
      const result = await deleteWorkspacePath(target.path);
      onDeleted(result.deleted, result.type);
    } catch (cause) {
      // The BFF said why; keep the sheet open so the path stays on screen while
      // a person reads it.
      setStatus(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={folder ? "Delete folder" : "Delete file"}
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <button type="button" className="button ghost" onClick={busy ? undefined : onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p>
        <strong>{name}</strong>
        {folder
          ? " and everything inside it will be removed from the workspace."
          : " will be removed from the workspace."}
      </p>
      <p className="muted small">
        <code>{target.path}</code>
      </p>
      <p className="muted small">
        This is not the archive — there is no trash to restore from, and an agent may be working in
        this folder right now.
      </p>
      {status ? (
        <p className="small bad" role="alert">
          {status}
        </p>
      ) : null}
    </Sheet>
  );
}

/**
 * Put the picked file into the current directory. The name arrives prefilled
 * and is editable, because a collision is refused rather than auto-suffixed (see
 * `uploadNameProblem`); Cancel during an upload aborts the request, which leaves
 * nothing behind — the BFF only builds the write frame once the whole body is
 * in. Percent lives in the button because that is the only thing changing.
 */
function UploadSheet({
  file,
  root,
  existing,
  onClose,
  onUploaded,
}: {
  file: File;
  root: string;
  existing: string[];
  onClose: () => void;
  onUploaded: (name: string) => void;
}) {
  const [name, setName] = useState(file.name);
  /** null while idle, otherwise the percent handed up by the request. */
  const [percent, setPercent] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const controller = useRef<AbortController | null>(null);
  /** Set once the sheet is going away, so a late abort is not an error. */
  const settled = useRef(false);

  const uploading = percent !== null;
  const tooLarge =
    file.size > MAX_UPLOAD_BYTES
      ? `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`
      : null;
  const problem = tooLarge ?? uploadNameProblem(name, existing);

  const close = () => {
    settled.current = true;
    controller.current?.abort();
    onClose();
  };

  const upload = async () => {
    const path = newFilePath(root, name);
    if (!path || problem) return;
    const abort = new AbortController();
    controller.current = abort;
    setPercent(0);
    setStatus("");
    try {
      await uploadWorkspaceFile(path, file, setPercent, abort.signal);
      if (settled.current) return;
      settled.current = true;
      onUploaded(path.split("/").pop() ?? name);
    } catch (cause) {
      if (settled.current) return;
      setPercent(null);
      setStatus(errorMessage(cause));
    }
  };

  return (
    <Sheet
      title="Upload file"
      onClose={close}
      actions={
        <>
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={uploading || problem !== null}
            onClick={() => void upload()}
          >
            {uploading ? `Uploading ${percent}%` : "Upload"}
          </button>
        </>
      }
    >
      <label className="field">
        File name
        <input
          value={name}
          disabled={uploading}
          onChange={(event) => {
            setName(event.target.value);
            setStatus("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void upload();
          }}
        />
      </label>
      {problem || status ? (
        <p className="small bad" role="alert">
          {problem ?? status}
        </p>
      ) : null}
      <p className="muted small">
        {[file.name, formatBytes(file.size), file.type || null].filter(Boolean).join(" · ")}
      </p>
      <p className="muted small">Uploading to {root}</p>
    </Sheet>
  );
}

/** The active column's direction; nothing on the others. */
function SortMark({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return <Icon name={dir === "asc" ? "up" : "arrow-down"} className="sort-mark" />;
}
