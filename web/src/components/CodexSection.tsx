import { useCallback, useEffect, useState } from "react";
import {
  type CodexSettings,
  type CodexSettingsUpdate,
  fetchCodexSettings,
  REASONING_EFFORTS,
  type ReasoningEffort,
  saveCodexSettings,
} from "../lib/codex.ts";
import { SAVED_NEXT_WORKER } from "../lib/save-result.ts";
import { ToggleRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

interface Draft {
  enabled: boolean;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  contextWindow: string;
  streamIdleTimeoutSeconds: string;
  /** Typed only; the stored key is never sent back. */
  apiKey: string;
  clearApiKey: boolean;
}

function draftOf(settings: CodexSettings, suggestedBaseUrl: string | null): Draft {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl || suggestedBaseUrl || "",
    model: settings.model,
    reasoningEffort: settings.reasoningEffort ?? "",
    contextWindow: settings.contextWindow ? String(settings.contextWindow) : "",
    streamIdleTimeoutSeconds: settings.streamIdleTimeoutSeconds
      ? String(settings.streamIdleTimeoutSeconds)
      : "",
    apiKey: "",
    clearApiKey: false,
  };
}

function optionalInt(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

/**
 * Settings → Codex: the endpoint and model Codex subagent workers run
 * against, and the switch that allows them at all. Saved server-side into
 * Codex's own config (see bff/src/codex/settings.ts); applies to the next
 * worker started, no restart needed.
 */
export function CodexSection() {
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchCodexSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings, loaded.suggestedBaseUrl));
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
    const update: CodexSettingsUpdate = {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl,
      model: draft.model,
      reasoningEffort: draft.reasoningEffort || null,
      contextWindow: optionalInt(draft.contextWindow),
      streamIdleTimeoutSeconds: optionalInt(draft.streamIdleTimeoutSeconds),
    };
    if (draft.clearApiKey) update.apiKey = "";
    else if (draft.apiKey.trim()) update.apiKey = draft.apiKey.trim();
    setSaving(true);
    try {
      const saved = await saveCodexSettings(update);
      setSettings(saved);
      setDraft(draftOf(saved, null));
      toast(SAVED_NEXT_WORKER);
    } catch (error) {
      toast(
        `Could not save the Codex worker settings: ${error instanceof Error ? error.message : String(error)}`,
        "bad",
      );
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !settings) {
    return (
      <>
        {status ? (
          <p className="warning small" role="alert">
            <span>{status}</span>
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

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <>
      <p className="muted small pad">
        Agents can hand coding work to a Codex worker (subagent type <code>codex</code>). It runs in
        the agent&apos;s workspace inside the app-server container, with the same access as the
        agent&apos;s own shell. The endpoint must serve the OpenAI Responses API.
      </p>

      <div className="pad-x">
        <ToggleRow
          title="Allow Codex workers"
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />

        <label className="field">
          Endpoint URL
          <input
            value={draft.baseUrl}
            placeholder="http://host:8080/v1"
            autoComplete="off"
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
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
          API key
          <input
            type="password"
            value={draft.apiKey}
            disabled={draft.clearApiKey}
            placeholder={settings.hasApiKey ? "Saved — type to replace" : "None (optional)"}
            autoComplete="off"
            onChange={(event) => set({ apiKey: event.target.value })}
          />
        </label>
        {settings.hasApiKey ? (
          <ToggleRow
            title="Remove the saved key"
            checked={draft.clearApiKey}
            onChange={(clearApiKey) => set({ clearApiKey, apiKey: "" })}
          />
        ) : null}

        <label className="field">
          Reasoning effort
          <select
            value={draft.reasoningEffort}
            onChange={(event) =>
              set({ reasoningEffort: event.target.value as Draft["reasoningEffort"] })
            }
          >
            <option value="">Model default</option>
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Context window (tokens)
          <input
            type="number"
            min={1}
            step={1}
            value={draft.contextWindow}
            placeholder="Codex's guess"
            onChange={(event) => set({ contextWindow: event.target.value })}
          />
          <span className="muted small">
            Set it for a local model: Codex knows only OpenAI&apos;s, and falls back to a guess.
          </span>
        </label>

        <label className="field">
          Stream idle timeout (seconds)
          <input
            type="number"
            min={1}
            step={1}
            value={draft.streamIdleTimeoutSeconds}
            placeholder="300"
            onChange={(event) => set({ streamIdleTimeoutSeconds: event.target.value })}
          />
          <span className="muted small">
            How long Codex waits for the next token. Raise it if long prompts are slow to start.
          </span>
        </label>

        <button type="button" className="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
