import { useCallback, useEffect, useState } from "react";
import { SAVED_NO_AGENT } from "../lib/save-result.ts";
import {
  describeWebToolsStatus,
  fetchWebToolsEnabled,
  fetchWebToolsStatus,
  saveWebToolsEnabled,
  testWebSearch,
  type WebToolsStatus,
  type WebToolsTestAnswer,
} from "../lib/web-tools.ts";
import { ToggleRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

/**
 * Settings → Web: every agent's native `web_search` and `fetch_webpage`
 * tools — a letta-code mod the BFF installs, backed by the SearXNG and
 * DuckDuckGo sidecars (bff/src/web-tools/). The switch applies from the next
 * turn; a test search proves the backends answer without starting one.
 */
export function WebToolsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WebToolsStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<WebToolsTestAnswer | null>(null);

  const load = useCallback(async () => {
    try {
      const [on, current] = await Promise.all([fetchWebToolsEnabled(), fetchWebToolsStatus()]);
      setEnabled(on);
      setStatus(current);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const saved = await saveWebToolsEnabled(next);
      setEnabled(saved.enabled);
      toast(
        saved.pending
          ? SAVED_NO_AGENT
          : saved.enabled
            ? "On — web_search and fetch_webpage for every agent"
            : "Off — both tools stop from every agent's next turn",
      );
      setStatus(await fetchWebToolsStatus());
    } catch (error) {
      toast(
        `Could not ${next ? "enable" : "disable"} the web tools: ${error instanceof Error ? error.message : String(error)}`,
        "bad",
      );
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setAnswer(null);
    try {
      setAnswer(await testWebSearch(query.trim()));
    } catch (error) {
      setAnswer({ text: error instanceof Error ? error.message : String(error), isError: true });
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return (
      <>
        {message ? (
          <p className="warning small" role="alert">
            <span>{message}</span>
          </p>
        ) : (
          <p className="muted pad">Loading…</p>
        )}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="muted small pad">
        Gives every agent two tools, <code>web_search</code> and <code>fetch_webpage</code>, in
        chats, crons and Telegram alike; subagents do not get them. Searches go to the SearXNG
        sidecar, falling back to DuckDuckGo; pages are read through DuckDuckGo&apos;s fetcher.
        Nothing leaves this server except the searches and page requests themselves.
      </p>

      <div className="pad-x">
        <ToggleRow
          title="Native web search and page reading"
          description="web_search and fetch_webpage, for every agent"
          checked={enabled}
          disabled={busy}
          onChange={(next) => void toggle(next)}
        />
      </div>

      {status ? <p className="small pad">{describeWebToolsStatus(status)}</p> : null}
      {/* One box: "not installed yet" and "the mod refused to load" are the same
          fact seen from the two ends, and two banners stacked read as one long
          panic. */}
      {status && (!status.modInstalled || status.modErrors.length > 0) ? (
        <p className="warning small" role="alert">
          {!status.modInstalled
            ? "The tools are not installed in the app-server yet — they are written on the BFF's next connection to it."
            : `Loading the tools failed: ${status.modErrors.join("; ")}`}
        </p>
      ) : null}

      <p className="section-note">Try a search</p>
      <div className="pad-x">
        <label className="field">
          Query
          <input
            value={query}
            placeholder="weather in Redmond tomorrow"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runTest();
            }}
          />
          <span className="muted small">The same search agents run.</span>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy || !query.trim()}
            onClick={() => void runTest()}
          >
            Search
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh status
          </button>
        </div>
      </div>
      {answer ? (
        <pre className={`tool-args pad-x${answer.isError ? " bad" : ""}`}>{answer.text}</pre>
      ) : null}
    </>
  );
}
