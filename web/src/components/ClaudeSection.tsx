import { useCallback, useEffect, useState } from "react";
import {
  type ClaudeAuthMode,
  type ClaudeSettings,
  type ClaudeSettingsUpdate,
  fetchClaudeSettings,
  saveClaudeSettings,
} from "../lib/claude.ts";
import { ToggleRow } from "./MenuRow.tsx";

interface Draft {
  enabled: boolean;
  mode: ClaudeAuthMode;
  baseUrl: string;
  model: string;
  subscriptionModel: string;
  /** Typed only; the stored token is never sent back. */
  authToken: string;
  clearAuthToken: boolean;
  /** Typed only, like `authToken`. */
  oauthToken: string;
  clearOauthToken: boolean;
}

function draftOf(settings: ClaudeSettings): Draft {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    model: settings.model,
    subscriptionModel: settings.subscriptionModel,
    authToken: "",
    clearAuthToken: false,
    oauthToken: "",
    clearOauthToken: false,
  };
}

/**
 * Settings → Claude Code: what Claude Code subagent workers authenticate with —
 * a Claude subscription (the `claude setup-token` OAuth token) or an
 * Anthropic-compatible endpoint — and the switch that allows them at all.
 * Saved server-side into the file the `claude` shim reads
 * (see bff/src/claude/settings.ts); applies to the next worker started, no
 * restart needed.
 */
export function ClaudeSection() {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchClaudeSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings));
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    // Only the visible mode's fields: whatever was typed or ticked in the
    // other mode's (hidden) section is dropped rather than saved unseen.
    const update: ClaudeSettingsUpdate = { enabled: draft.enabled, mode: draft.mode };
    if (draft.mode === "subscription") {
      update.subscriptionModel = draft.subscriptionModel;
      if (draft.clearOauthToken) update.oauthToken = "";
      else if (draft.oauthToken.trim()) update.oauthToken = draft.oauthToken.trim();
    } else {
      update.baseUrl = draft.baseUrl;
      update.model = draft.model;
      if (draft.clearAuthToken) update.authToken = "";
      else if (draft.authToken.trim()) update.authToken = draft.authToken.trim();
    }
    setSaving(true);
    try {
      const saved = await saveClaudeSettings(update);
      setSettings(saved);
      setDraft(draftOf(saved));
      setStatus("Saved. Applies to the next Claude Code worker started.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !settings) {
    return (
      <>
        {status ? <p className="small bad pad">{status}</p> : <p className="muted pad">Loading…</p>}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <>
      <p className="muted small pad">
        Agents can hand coding work to a Claude Code worker (subagent type <code>claude-code</code>
        ). It runs in the agent&apos;s workspace inside the app-server container, with the same
        access as the agent&apos;s own shell. It signs in with your Claude subscription, or talks to
        any endpoint that serves the Anthropic Messages API.
      </p>
      {status ? <p className="muted small pad">{status}</p> : null}

      <div className="pad-x">
        <ToggleRow
          title="Allow Claude Code workers"
          description="Agents may hand coding work to a Claude Code subagent"
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />

        <label className="field">
          Sign in with
          <select
            value={draft.mode}
            onChange={(event) => set({ mode: event.target.value as ClaudeAuthMode })}
          >
            <option value="subscription">Claude subscription</option>
            <option value="endpoint">Anthropic-compatible endpoint</option>
          </select>
        </label>

        {draft.mode === "subscription" ? (
          <>
            <label className="field">
              OAuth token
              <input
                type="password"
                value={draft.oauthToken}
                disabled={draft.clearOauthToken}
                placeholder={settings.hasOauthToken ? "Saved — type to replace" : "sk-ant-oat01-…"}
                autoComplete="off"
                onChange={(event) => set({ oauthToken: event.target.value })}
              />
              <span className="muted small">
                Run <code>claude setup-token</code> on any computer with a browser and paste the
                token it prints. It lasts a year. Workers count against your subscription&apos;s
                usage limits, shared with your own Claude use.
              </span>
              <span className="muted small">
                The token is stored on the server and handed to each worker, so any agent shell —
                and any command a worker runs — can read it. Treat it like a password for your
                Claude account.
              </span>
            </label>
            {settings.hasOauthToken ? (
              <ToggleRow
                title="Remove the saved token"
                checked={draft.clearOauthToken}
                onChange={(clearOauthToken) => set({ clearOauthToken, oauthToken: "" })}
              />
            ) : null}

            <label className="field">
              Model
              <input
                value={draft.subscriptionModel}
                placeholder="Claude Code's default"
                autoComplete="off"
                onChange={(event) => set({ subscriptionModel: event.target.value })}
              />
              <span className="muted small">
                Optional: an alias such as <code>sonnet</code> or <code>opus</code>, or a full model
                id.
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="field">
              Endpoint URL
              <input
                value={draft.baseUrl}
                placeholder="http://host:4000"
                autoComplete="off"
                onChange={(event) => set({ baseUrl: event.target.value })}
              />
              <span className="muted small">
                An Anthropic-compatible API (a LiteLLM-style proxy or any Anthropic-API gateway).
              </span>
            </label>

            <label className="field">
              Model
              <input
                value={draft.model}
                placeholder="Model id as the endpoint names it"
                autoComplete="off"
                onChange={(event) => set({ model: event.target.value })}
              />
            </label>

            <label className="field">
              Auth token
              <input
                type="password"
                value={draft.authToken}
                disabled={draft.clearAuthToken}
                placeholder={settings.hasAuthToken ? "Saved — type to replace" : "None (optional)"}
                autoComplete="off"
                onChange={(event) => set({ authToken: event.target.value })}
              />
              <span className="muted small">
                Sent to the endpoint as a bearer token. Optional when the endpoint does not check
                it.
              </span>
            </label>
            {settings.hasAuthToken ? (
              <ToggleRow
                title="Remove the saved token"
                checked={draft.clearAuthToken}
                onChange={(clearAuthToken) => set({ clearAuthToken, authToken: "" })}
              />
            ) : null}
          </>
        )}

        <button type="button" className="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
