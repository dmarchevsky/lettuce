import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { SAVED_NOW } from "../lib/save-result.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

/**
 * One MCP server list shared by every agent. It is not in the app-server
 * protocol, and not in upstream's per-agent settings either (the app-server
 * overwrote those — see bff/src/mcp/settings.ts): the BFF keeps it in a file of
 * its own and tells agents about it through the `mcp-servers` skill. Reads and
 * writes go through /api/mcp; the browser never touches the file, since an
 * entry is a command line agent shells will exec.
 */
type Transport = "stdio" | "http" | "sse";

interface McpServer {
  name: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const BLANK: McpServer = { name: "", transport: "stdio", command: "", args: [] };

export function McpEditor({ session }: { session: SessionApi }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [argsText, setArgsText] = useState("");
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
      const body = (await response.json()) as { servers?: McpServer[] };
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

  const persist = async (next: McpServer[]) => {
    try {
      const response = await fetch("/api/mcp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ servers: next }),
      });
      if (!response.ok) {
        toast((await response.text()) || "Could not save the MCP servers", "bad");
        return;
      }
      const body = (await response.json()) as { servers?: McpServer[] };
      setServers(Array.isArray(body.servers) ? body.servers : next);
      toast(SAVED_NOW);
    } catch (cause) {
      toast(`Could not save the MCP servers: ${errorMessage(cause)}`, "bad");
    }
  };

  const openEditor = (server: McpServer | null, index: number | null) => {
    const value = server ?? { ...BLANK };
    setDraft(value);
    setDraftIndex(index);
    setArgsText((value.args ?? []).join(" "));
  };

  const commit = async () => {
    if (!draft?.name.trim()) return;
    const value: McpServer = {
      name: draft.name.trim(),
      transport: draft.transport ?? "stdio",
    };
    if (value.transport === "stdio") {
      value.command = draft.command?.trim() ?? "";
      const args = argsText.trim();
      if (args) value.args = args.split(/\s+/);
    } else {
      value.url = draft.url?.trim() ?? "";
    }

    const next = [...servers];
    if (draftIndex === null) next.push(value);
    else next[draftIndex] = value;

    setDraft(null);
    setDraftIndex(null);
    await persist(next);
  };

  const remove = async (index: number) => {
    const server = servers[index];
    if (!server || !confirm(`Remove MCP server "${server.name}"?`)) return;
    await persist(servers.filter((_, i) => i !== index));
  };

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
        <code>mcp-servers</code> skill.
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
        {servers.map((server, index) => (
          <li key={server.name}>
            <div className="row static">
              <span className="grow-text">
                <strong>{server.name}</strong>
                <div className="muted small">
                  <code>
                    {server.transport ?? "stdio"}
                    {server.transport === "http" || server.transport === "sse"
                      ? ` · ${server.url ?? ""}`
                      : ` · ${server.command ?? ""} ${(server.args ?? []).join(" ")}`}
                  </code>
                </div>
              </span>
              <button type="button" className="link" onClick={() => openEditor(server, index)}>
                Edit
              </button>
              <button type="button" className="link danger" onClick={() => void remove(index)}>
                Remove
              </button>
            </div>
          </li>
        ))}
        {servers.length === 0 ? <li className="muted pad">No MCP servers configured</li> : null}
      </ul>

      <p className="section-note">Example — the bundled DuckDuckGo web search</p>
      <pre className="tool-args pad-x">{`name: duckduckgo
transport: http
url: http://ddg-mcp:8000/mcp`}</pre>

      {draft ? (
        <Sheet
          title={draftIndex === null ? "Add MCP server" : `Edit ${draft.name}`}
          size="compact"
          onClose={closeDraft}
          actions={
            <>
              <button type="button" className="button ghost" onClick={closeDraft}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!draft.name.trim()}
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
              placeholder="duckduckgo"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="field">
            Transport
            <select
              value={draft.transport ?? "stdio"}
              onChange={(event) =>
                setDraft({ ...draft, transport: event.target.value as Transport })
              }
            >
              <option value="stdio">stdio (local process)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>

          {(draft.transport ?? "stdio") === "stdio" ? (
            <>
              <label className="field">
                Command
                <input
                  value={draft.command ?? ""}
                  placeholder="uvx"
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </label>
              <label className="field">
                Arguments
                <input
                  value={argsText}
                  placeholder="mcp-searxng"
                  onChange={(event) => setArgsText(event.target.value)}
                />
                <span className="muted small">Space separated</span>
              </label>
            </>
          ) : (
            <label className="field">
              URL
              <input
                value={draft.url ?? ""}
                placeholder="https://example.com/mcp"
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </label>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
