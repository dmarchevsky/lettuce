import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { shortDate } from "../lib/conversation-groups.ts";
import { formatBytes, formatChars } from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
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

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">Select an agent.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        {memfs === false ? <span className="tag">MemFS off</span> : null}
        <span className="spacer" />
        <span className="muted small">{entries.length} blocks</span>
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

      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.relative_path}>
            <button
              type="button"
              className="row"
              onClick={() => {
                setOpen(entry);
                setDraft(entry.content);
                setHistory(null);
              }}
            >
              <Icon name={entry.is_system ? "settings" : "memory"} />
              <span className="grow-text memory-row-text">
                <span className="memory-row-title">
                  <strong>{entry.relative_path}</strong>
                  {/* What the gear icon meant, said once: system blocks are
                      composed into the agent's context on every turn. */}
                  {entry.is_system ? <span className="tag">In context</span> : null}
                </span>
                {entry.description ? (
                  <span className="muted small">{entry.description}</span>
                ) : null}
              </span>
              <span className="muted small memory-size">
                {/* Upstream reports a text block's length and an image's bytes. */}
                {entry.content === "" && entry.size > 0
                  ? formatBytes(entry.size)
                  : formatChars(entry.size)}
              </span>
            </button>
          </li>
        ))}
        {entries.length === 0 && !status && !loading ? (
          <li className="muted pad">No memory blocks</li>
        ) : null}
      </ul>

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
