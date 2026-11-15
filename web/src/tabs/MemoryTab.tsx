import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { FilterField } from "../components/FilterField.tsx";
import { Icon } from "../components/Icon.tsx";
import { MemoryGraph } from "../components/MemoryGraph.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { shortDate } from "../lib/conversation-groups.ts";
import { formatBytes, formatChars } from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import { deriveGraph } from "../lib/memory-graph.ts";
import {
  buildMemoryTree,
  filterMemoryPaths,
  isRowVisible,
  memoryTreeCounts,
  memoryTreeDirs,
} from "../lib/memory-tree.ts";
import { defaultStorage, readStored } from "../lib/storage.ts";
import type { SessionApi } from "../state/use-session.ts";

/** Which of the two views the Memory pane opens in, remembered per browser. */
const VIEW_KEY = "lettuce:memory-view";
type MemoryView = "tree" | "graph";

function readView(): MemoryView {
  return readStored(defaultStorage(), VIEW_KEY) === "graph" ? "graph" : "tree";
}

function storeView(view: MemoryView): void {
  try {
    defaultStorage()?.setItem(VIEW_KEY, view);
  } catch {
    // A browser that will not store it is a browser that opens in the tree.
  }
}

interface MemoryEntry {
  relative_path: string;
  is_system: boolean;
  description: string | null;
  content: string;
  size: number;
  /**
   * The files this one links to with `[[wiki links]]`, resolved by upstream to
   * paths that exist (letta-code `websocket/listener/commands/memory.ts`). Only
   * present because the request below asks for it; a link whose target is gone
   * is simply absent, not flagged.
   */
  references?: string[];
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
  const [view, setView] = useState<MemoryView>(readView);
  const [showUnlinked, setShowUnlinked] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const response = await session.request<{
        entries?: MemoryEntry[];
        success?: boolean;
        error?: string;
        memfs_enabled?: boolean;
      }>("list_memory", { agent_id: agentId, include_references: true });
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
  // The same entries, seen as links instead of as folders. Upstream resolves the
  // [[wiki links]] per file, so this is a re-shape of data already on hand.
  const graph = useMemo(() => deriveGraph(entries), [entries]);
  const unlinked = useMemo(() => {
    const linked = new Set(graph.nodes.map((node) => node.path));
    return entries
      .map((entry) => entry.relative_path)
      .filter((path) => !linked.has(path))
      .sort();
  }, [entries, graph]);
  const entryByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.relative_path, entry])),
    [entries],
  );

  const switchView = (next: MemoryView) => {
    setView(next);
    storeView(next);
  };

  /** A node tap opens the same sheet a tree row opens. */
  const openFile = (path: string) => {
    const entry = entryByPath.get(path);
    if (!entry) return;
    setOpen(entry);
    setDraft(entry.content);
    setHistory(null);
  };

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
        // The path, not just the name — inside a collapsed tree the folder is the part a
        // screen reader would otherwise never hear. An aria-label replaces the row's whole
        // visible name, so it says everything the eye gets: path, the in-context fact, the
        // description.
        aria-label={[
          args.entry.relative_path,
          args.entry.is_system ? "in context" : "",
          args.entry.description ?? "",
        ]
          .filter(Boolean)
          .join(", ")}
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
                words: a system file is composed into the agent's context
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

  const hasMemory = counts.files > 0;

  return (
    <div className="pane">
      {/* `wrap`, like the Files bar: this bar carries the counts, the unlinked
          switch and the view toggle, which is more than a phone row can hold. */}
      <div className="pane-bar wrap">
        {memfs === false ? <span className="tag">MemFS off</span> : null}
        {hasMemory && view === "graph" ? (
          <>
            <span className="muted small">
              {graph.linked === 0
                ? `0 of ${graph.total} files linked`
                : `${graph.linked} of ${graph.total} files · ${graph.edges.length} ${
                    graph.edges.length === 1 ? "link" : "links"
                  }`}
            </span>
            {graph.linked > 0 && unlinked.length > 0 ? (
              <button type="button" className="link" onClick={() => setShowUnlinked((v) => !v)}>
                {showUnlinked ? "Hide unlinked" : "Show unlinked"}
              </button>
            ) : null}
          </>
        ) : hasMemory ? (
          <>
            <span className="muted small">
              {searching
                ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}`
                : `${counts.files} files · ${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`}
            </span>
            {searching ? (
              <button type="button" className="link" onClick={() => setQuery("")}>
                Clear
              </button>
            ) : (
              <button type="button" className="link" onClick={toggleAll}>
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            )}
          </>
        ) : null}
        <span className="spacer" />
        {hasMemory ? (
          <span className="memory-view-toggle">
            {view === "tree" ? (
              <strong>Tree</strong>
            ) : (
              <button type="button" className="link" onClick={() => switchView("tree")}>
                Tree
              </button>
            )}
            <span aria-hidden="true" className="muted small">
              |
            </span>
            {view === "graph" ? (
              <strong>Graph</strong>
            ) : (
              <button type="button" className="link" onClick={() => switchView("graph")}>
                Graph
              </button>
            )}
          </span>
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

      {hasMemory && view === "graph" ? (
        graph.linked > 0 ? (
          <MemoryGraph
            graph={graph}
            unlinked={unlinked}
            showUnlinked={showUnlinked}
            openPath={open?.relative_path ?? null}
            onOpen={openFile}
          />
        ) : (
          <div className="pad">
            <p className="muted">No links yet.</p>
            <p className="muted small">
              Files link to each other by writing <code>[[people/ana]]</code>, and the graph draws
              those links — 0 of {graph.total} files are linked. Use the tree until there are more.
            </p>
          </div>
        )
      ) : null}

      {hasMemory && view === "tree" ? (
        <div className="memory-filter">
          <FilterField placeholder="Filter memory…" value={query} onChange={setQuery} />
        </div>
      ) : null}

      {view === "tree" &&
        (searching ? (
          matches.length === 0 ? (
            <p className="muted pad">No memory files match “{query.trim()}”.</p>
          ) : (
            <ul className="list memory-tree">
              {matches.map((match, index) =>
                fileRow({
                  key: `m:${match.path}:${index}`,
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
            {visible.map((row, index) =>
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
                fileRow({
                  key: `f:${row.path}:${index}`,
                  name: row.name,
                  entry: row.entry,
                  depth: row.depth,
                })
              ),
            )}
          </ul>
        ))}

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
          {open.is_system ? <p className="muted small">System file — edit with care.</p> : null}

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
