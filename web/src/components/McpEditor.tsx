import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  blankRow,
  draftOf,
  draftProblem,
  isRemote,
  keepAll,
  type McpDraft,
  type McpServerInput,
  type McpServerView,
  type SecretRow,
  secretTags,
  type Transport,
  wireOf,
} from "../lib/mcp.ts";
import { SAVED_NOW } from "../lib/save-result.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { ToggleRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

/**
 * One MCP server list shared by every agent. It is not in the app-server
 * protocol, and not in upstream's per-agent settings either (the app-server
 * overwrote those — see bff/src/mcp/settings.ts): the BFF keeps it in a file of
 * its own and tells agents about it through the `mcp-servers` skill. Reads and
 * writes go through /api/mcp; the browser never touches the file, since an
 * entry is a command line agent shells will exec.
 *
 * Tokens, headers and env values are write-only (`lib/mcp.ts`): a saved one
 * comes back as its name with a blank value, and a blank sent back keeps it.
 */
export function McpEditor({ session }: { session: SessionApi }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // The dialog's Sheet makes Back, Escape and the ✕ all land here.
  const closeDraft = useCallback(() => {
    setDraft(null);
    setDraftIndex(null);
  }, []);

  const load = useCallback(async () => {
    setProgress("Loading settings…");
    try {
      const response = await fetch("/api/mcp");
      if (!response.ok) {
        setStatus((await response.text()) || "Could not read MCP settings");
        return;
      }
      const body = (await response.json()) as { servers?: McpServerView[] };
      setServers(Array.isArray(body.servers) ? body.servers : []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setProgress("");
    }
  }, []);

  useEffect(() => {
    if (session.ready) void load();
  }, [session.ready, load]);

  /** True when the BFF took the list. A refusal is toasted and leaves the draft open to fix. */
  const persist = async (next: McpServerInput[]): Promise<boolean> => {
    try {
      const response = await fetch("/api/mcp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ servers: next }),
      });
      if (!response.ok) {
        toast((await response.text()) || "Could not save the MCP servers", "bad");
        return false;
      }
      const body = (await response.json()) as { servers?: McpServerView[] };
      if (Array.isArray(body.servers)) setServers(body.servers);
      else await load();
      toast(SAVED_NOW);
      return true;
    } catch (cause) {
      toast(`Could not save the MCP servers: ${errorMessage(cause)}`, "bad");
      return false;
    }
  };

  const openEditor = (server: McpServerView | null, index: number | null) => {
    setDraft(draftOf(server));
    setDraftIndex(index);
  };

  const problem = draft ? draftProblem(draft) : null;

  const commit = async () => {
    if (!draft?.name.trim() || problem) return;
    const edited = wireOf(draft);
    // Every other server goes back as "keep everything": PUT takes the whole list.
    const next = servers.map((server, index) => (index === draftIndex ? edited : keepAll(server)));
    if (draftIndex === null) next.push(edited);
    setSaving(true);
    const ok = await persist(next);
    setSaving(false);
    if (ok) closeDraft();
  };

  const remove = async (index: number) => {
    const server = servers[index];
    if (!server || !confirm(`Remove MCP server "${server.name}"?`)) return;
    await persist(servers.filter((_, i) => i !== index).map(keepAll));
  };

  const set = (patch: Partial<McpDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  return (
    <>
      <div className="pane-bar">
        <button type="button" className="link" onClick={() => openEditor(null, null)}>
          <Icon name="plus" /> Add server
        </button>
        <span className="spacer" />
        <span className="muted small">{servers.length} configured</span>
        <button
          type="button"
          className="link"
          onClick={() => void load()}
          title="Reload MCP servers"
          aria-label="Reload MCP servers"
        >
          <Icon name="refresh" />
        </button>
      </div>

      <p className="muted small pad">
        Agents use http and sse servers through their native <code>mcp_search</code> /{" "}
        <code>mcp_call</code> tools; subagents, and stdio servers, go through the{" "}
        <code>mcp-servers</code> skill. A token or header saved here stays on the Lettuce server and
        is never shown to an agent — so subagents cannot reach a server that needs one.
      </p>

      {progress && !status ? <p className="muted small pad">{progress}</p> : null}
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      <ul className="list">
        {servers.map((server, index) => {
          const tags = secretTags(server);
          return (
            <li key={server.name}>
              <div className="row static">
                <span className="grow-text">
                  <strong>{server.name}</strong>
                  <div className="muted small">
                    <code>
                      {server.transport ?? "stdio"}
                      {isRemote(server.transport)
                        ? ` · ${server.url ?? ""}`
                        : ` · ${server.command ?? ""} ${(server.args ?? []).join(" ")}`}
                    </code>
                  </div>
                  {tags.length > 0 ? (
                    <div className="hdr-stored mcp-tags">
                      {tags.map((tag) => (
                        <span key={tag} className="tag muted">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </span>
                <button type="button" className="link" onClick={() => openEditor(server, index)}>
                  Edit
                </button>
                <button type="button" className="link danger" onClick={() => void remove(index)}>
                  Remove
                </button>
              </div>
            </li>
          );
        })}
        {servers.length === 0 ? <li className="muted pad">No MCP servers configured</li> : null}
      </ul>

      <p className="section-note">Example — the bundled DuckDuckGo web search</p>
      <pre className="tool-args pad-x">{`name: duckduckgo
transport: http
url: http://ddg-mcp:8000/mcp`}</pre>

      {draft ? (
        <Sheet
          title={draftIndex === null ? "Add MCP server" : `Edit ${draft.was ?? draft.name}`}
          size="compact"
          onClose={closeDraft}
          status={problem}
          actions={
            <>
              <button type="button" className="button ghost" onClick={closeDraft}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!draft.name.trim() || problem !== null || saving}
                onClick={() => void commit()}
              >
                Save
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              value={draft.name}
              placeholder="home-assistant"
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>

          <label className="field">
            Transport
            <select
              value={draft.transport}
              onChange={(event) => set({ transport: event.target.value as Transport })}
            >
              <option value="stdio">stdio (local process)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>

          {draft.transport === "stdio" ? (
            <>
              <label className="field">
                Command
                <input
                  value={draft.command}
                  placeholder="uvx"
                  onChange={(event) => set({ command: event.target.value })}
                />
              </label>
              <label className="field">
                Arguments
                <input
                  value={draft.argsText}
                  placeholder="mcp-searxng"
                  onChange={(event) => set({ argsText: event.target.value })}
                />
                <span className="muted small">Space separated</span>
              </label>

              <p className="section-note" style={{ marginLeft: 0 }}>
                Environment
              </p>
              <SecretRows
                rows={draft.env}
                namePlaceholder="API_KEY"
                removeLabel="Remove variable"
                onChange={(env) => set({ env })}
              />
              <div className="field">
                <button
                  type="button"
                  className="link inline mcp-add-row"
                  onClick={() => set({ env: [...draft.env, blankRow()] })}
                >
                  + Add variable
                </button>
                <span className="small">
                  Write-only here, but a stdio server runs beside the agents, so its variables sit
                  in the shared MCP file that agent shells can read.
                </span>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                URL
                <input
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => set({ url: event.target.value })}
                />
              </label>

              <p className="section-note" style={{ marginLeft: 0 }}>
                Authentication
              </p>
              <label className="field">
                Bearer token
                <input
                  type="password"
                  value={draft.bearer}
                  disabled={draft.removeBearer}
                  placeholder={draft.bearerSaved ? "Saved — leave blank to keep" : "None"}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => set({ bearer: event.target.value })}
                />
                <span className="muted small">
                  Sent as an <code>Authorization: Bearer</code> header.
                  {draft.bearerSaved
                    ? " Saved — type to replace, or remove it below."
                    : " Kept on the Lettuce server: agents never see it."}
                </span>
              </label>
              {draft.bearerSaved ? (
                <ToggleRow
                  title="Remove the saved token"
                  checked={draft.removeBearer}
                  onChange={(removeBearer) => set({ removeBearer, bearer: "" })}
                />
              ) : null}

              <p className="section-note" style={{ marginLeft: 0 }}>
                Custom headers
              </p>
              <SecretRows
                rows={draft.headers}
                namePlaceholder="X-API-Key"
                removeLabel="Remove header"
                onChange={(headers) => set({ headers })}
              />
              <div className="field">
                <button
                  type="button"
                  className="link inline mcp-add-row"
                  onClick={() => set({ headers: [...draft.headers, blankRow()] })}
                >
                  + Add header
                </button>
                <span className="small">
                  {draft.headers.some((row) => row.saved)
                    ? "Values are write-only. A saved one shows blank: leave it to keep, type to replace, ✕ to remove."
                    : "For servers that want a key in a header of their own, such as X-API-Key."}
                </span>
              </div>
            </>
          )}
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * Name/value rows with a masked value. A saved row's name is fixed — renaming
 * it would leave its blank value nothing to keep — so changing a name is ✕ and
 * a new row.
 */
function SecretRows({
  rows,
  namePlaceholder,
  removeLabel,
  onChange,
}: {
  rows: SecretRow[];
  namePlaceholder: string;
  removeLabel: string;
  onChange: (rows: SecretRow[]) => void;
}) {
  const update = (id: string, patch: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <>
      {rows.map((row) => (
        <div className="hdr-row stack" key={row.id}>
          <input
            className="hdr-name"
            value={row.name}
            placeholder={namePlaceholder}
            readOnly={row.saved}
            aria-label="Name"
            spellCheck={false}
            onChange={(event) => update(row.id, { name: event.target.value })}
          />
          <input
            className="hdr-value"
            type="password"
            value={row.value}
            placeholder={row.saved ? "Saved" : "value"}
            aria-label={`Value of ${row.name || "new entry"}`}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => update(row.id, { value: event.target.value })}
          />
          <button
            type="button"
            className="hdr-remove"
            aria-label={removeLabel}
            onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
    </>
  );
}
