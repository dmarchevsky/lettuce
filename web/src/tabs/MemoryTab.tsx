import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { FilterField } from "../components/FilterField.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { shortDate } from "../lib/conversation-groups.ts";
import { formatBytes, formatChars } from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import {
  buildMemoryTree,
  filterMemoryPaths,
  isRowVisible,
  memoryTreeCounts,
  memoryTreeDirs,
} from "../lib/memory-tree.ts";
import type { SessionApi } from "../state/use-session.ts";

interface MemoryEntry {
  relative_path: string;
  is_system: boolean;
  description: string | null;
  content: string;
  size: number;
}

interface Commit {
  sha: string;
  message: string;
  timestamp: string;
  author_name: string | null;
}

interface Props {
  session: SessionApi;
  agentId: string | null;
}

/** The indent: 14px per level on top of the row's own gutter. */
function depthStyle(depth: number): CSSProperties {
  return { "--d": depth } as CSSProperties;
}

export function MemoryTab({ session, agentId }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [open, setOpen] = useState<MemoryEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Commit[] | null>(null);
  /** Only a failed list — a save result is a toast, and progress is a spinner's job. */
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** A failed history read is the sheet's own content, not a toast that leaves. */
  const [historyError, setHistoryError] = useState("");
  const [memfs, setMemfs] = useState<boolean | null>(null);
  /** Which folders are open. Held here rather than derived, so reloading memory —
      which happens every time the agent writes one — does not fold the tree back
      shut under someone reading it. */
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const response = await session.request<{
        entries?: MemoryEntry[];
        success?: boolean;
        error?: string;
        memfs_enabled?: boolean;
      }>("list_memory", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Could not list memory");
        return;
      }
      setEntries(response?.entries ?? []);
      setMemfs(response?.memfs_enabled ?? null);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, session.request]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  // Memory changes as the agent works; refresh when it says so.
  useEffect(
    () =>
      session.onFrame((frame) => {
        if ((frame as { type?: unknown }).type === "memory_updated") void load();
      }),
    [session.onFrame, load],
  );

  // Upstream sends a flat list of paths; the tree is derived from them. See
  // lib/memory-tree.ts for why no command is needed to get the structure.
  const rows = useMemo(() => buildMemoryTree(entries), [entries]);
  const counts = useMemo(() => memoryTreeCounts(entries), [entries]);
  const dirs = useMemo(() => memoryTreeDirs(rows), [rows]);
  const searching = query.trim() !== "";
  const matches = useMemo(() => filterMemoryPaths(entries, query), [entries, query]);
  const visible = useMemo(
    () => rows.filter((row) => isRowVisible(row, openDirs)),
    [rows, openDirs],
  );
  const allOpen = dirs.length > 0 && dirs.every((dir) => openDirs.has(dir));

  const toggleDir = (path: string) =>
    setOpenDirs((current) => {
      const next = new Set(current);
      if (next.delete(path)) return next;
      next.add(path);
      return next;
    });

  const toggleAll = () => setOpenDirs(allOpen ? new Set() : new Set(dirs));

  const save = async () => {
    if (!agentId || !open) return;
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "write_memory_file",
        { agent_id: agentId, path: open.relative_path, content: draft },
      );
      if (response?.success === false) {
        toast(response.error ?? `Could not save ${open.relative_path}`, "bad");
        return;
      }
      toast(`Saved ${open.relative_path}.`);
      setOpen(null);
      await load();
    } catch (cause) {
      toast(`Could not save ${open.relative_path}: ${errorMessage(cause)}`, "bad");
    }
  };

  const loadHistory = async (path: string) => {
    if (!agentId) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await session.request<{ commits?: Commit[]; error?: string }>(
        "memory_history",
        { agent_id: agentId, file_path: path, limit: 30 },
      );
      setHistory(response?.commits ?? []);
    } catch (cause) {
      setHistoryError(`Could not read the history: ${errorMessage(cause)}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  /** A file row, shared by the tree and by a flat list of matches. */
  const fileRow = (args: {
    key: string;
    name: string;
    entry: MemoryEntry;
    depth: number;
    /** The folder line: nothing inside the tree, the folder in a match list. */
    folder?: string;
  }) => (
    <li key={args.key}>
      <button
        type="button"
        className="row"
        style={depthStyle(args.depth)}
        onClick={() => {
          setOpen(args.entry);
          setDraft(args.entry.content);
          setHistory(null);
        }}
      >
        {/* The slot every row reserves for a chevron: without it a file inside a folder
            starts left of its own folder's name and the indent reads backwards. */}
        <span className="slot" />
        <Icon name={args.entry.is_system ? "settings" : "memory"} />
        <span className="grow-text memory-row-text">
          <span className="memory-row-title">
            <strong>{args.name}</strong>
            {/* The fact a per-row control used to hint at, said once in
                words: system blocks are composed into the agent's context
                on every turn. */}
            {args.entry.is_system ? <span className="tag">In context</span> : null}
          </span>
          {/* Inside the tree the folder is already on screen above it; in a match list the
              folder is the only thing telling two same-named files apart. */}
          {args.folder ? <span className="memory-row-path">{args.folder}</span> : null}
          {args.entry.description ? (
            <span className="muted small">{args.entry.description}</span>
          ) : null}
        </span>
        <span className="muted small memory-size">
          {/* Upstream reports a text block's length and an image's bytes. */}
          {args.entry.content === "" && args.entry.size > 0
            ? formatBytes(args.entry.size)
            : formatChars(args.entry.size)}
        </span>
      </button>
    </li>
  );

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">Select an agent.</p>
      </div>
    );
  }

  const hasMemory = entries.length > 0;

  return (
    <div className="pane">
      <div className="pane-bar">
        {memfs === false ? <span className="tag">MemFS off</span> : null}
        {hasMemory ? (
          <>
            <span className="muted small">
              {searching
                ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}`
                : `${counts.files} files · ${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`}
            </span>
            <span className="memory-bar-links">
              {searching ? (
                <button type="button" className="link" onClick={() => setQuery("")}>
                  Clear
                </button>
              ) : (
                <button type="button" className="link" onClick={toggleAll}>
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
              )}
            </span>
          </>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => void load()}
          title="Reload memory"
          aria-label="Reload memory"
        >
          <Icon name="refresh" />
        </button>
      </div>

      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {hasMemory ? (
        <div className="memory-filter">
          <FilterField placeholder="Filter memory…" value={query} onChange={setQuery} />
        </div>
      ) : null}

      {searching ? (
        matches.length === 0 ? (
          <p className="muted pad">No memory files match “{query.trim()}”.</p>
        ) : (
          <ul className="list memory-tree">
            {matches.map((match) =>
              fileRow({
                key: `m:${match.path}`,
                name: match.name,
                entry: match.entry,
                depth: 0,
                folder: match.parent,
              }),
            )}
          </ul>
        )
      ) : (
        <ul className="list memory-tree">
          {visible.map((row) =>
            row.kind === "dir" ? (
              <li key={`d:${row.path}`}>
                <button
                  type="button"
                  className="row"
                  style={depthStyle(row.depth)}
                  aria-expanded={openDirs.has(row.path)}
                  onClick={() => toggleDir(row.path)}
                >
                  <Icon
                    name={openDirs.has(row.path) ? "chevron-down" : "chevron-right"}
                    className="chevron"
                  />
                  <Icon name="folder" />
                  <span className="grow-text">
                    <strong>{row.name}</strong>
                  </span>
                  <span className="muted small">{row.count}</span>
                </button>
              </li>
            ) : (
              fileRow({ key: `f:${row.path}`, name: row.name, entry: row.entry, depth: row.depth })
            ),
          )}
        </ul>
      )}

      {hasMemory || status || loading ? null : <p className="muted pad">No memory files yet.</p>}

      {open ? (
        <Sheet
          title={open.relative_path}
          fill
          size="spacious"
          onClose={() => setOpen(null)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setOpen(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={draft === open.content}
                onClick={() => void save()}
              >
                Save
              </button>
            </>
          }
        >
          {open.is_system ? <p className="muted small">System block — edit with care.</p> : null}

          <textarea
            className="memory-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          <button
            type="button"
            className="link"
            onClick={() => void loadHistory(open.relative_path)}
          >
            History
          </button>

          {history ? (
            <ul className="list compact">
              {history.map((commit) => (
                <li key={commit.sha}>
                  <span className="muted small">
                    {shortDate(commit.timestamp)} · {commit.sha.slice(0, 7)}
                  </span>
                  <div>{commit.message}</div>
                </li>
              ))}
              {history.length === 0 ? <li className="muted pad">No history</li> : null}
            </ul>
          ) : historyLoading ? (
            <p className="muted small">Loading history…</p>
          ) : null}
          {historyError ? (
            <p className="warning small" role="alert">
              <span>{historyError}</span>
              <button
                type="button"
                className="link"
                onClick={() => open && void loadHistory(open.relative_path)}
              >
                Try again
              </button>
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}
