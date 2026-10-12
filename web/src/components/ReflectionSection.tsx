import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { RuntimeScope } from "../lib/protocol.ts";
import { SAVED_NOW } from "../lib/save-result.ts";
import type { SessionApi } from "../state/use-session.ts";
import { toast } from "./Toast.tsx";

type TriggerMode = "off" | "step-count" | "compaction-event";
type MergeMode = "auto" | "explicit";

interface ReflectionSettings {
  agent_id: string;
  trigger: TriggerMode;
  step_count: number;
  merge: MergeMode;
  merge_instructions: string;
}

interface Props {
  session: SessionApi;
  agentId: string | null;
  conversationId: string | null;
}

const TRIGGER_LABELS: { id: TriggerMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Never reflect automatically." },
  {
    id: "step-count",
    label: "Every N steps",
    hint: "Reflect once the turn has run this many tool steps.",
  },
  {
    id: "compaction-event",
    label: "On compaction",
    hint: "Reflect when the conversation is compacted.",
  },
];

/**
 * Reflection settings.
 *
 * `/dream` and `/reflect` fire the thing itself; these two commands read and
 * write what governs it. The scope parameter is deliberately not exposed:
 * upstream can persist to the local project, globally, or both, and picking
 * between those is a deployment decision rather than something to guess at
 * from a phone. Omitting `scope` takes the server default.
 *
 * The settings are resolved server-side against the conversation's working
 * directory, so this needs a live conversation — not just an agent.
 */
export function ReflectionSection({ session, agentId, conversationId }: Props) {
  const [settings, setSettings] = useState<ReflectionSettings | null>(null);
  /**
   * The settings as last loaded or saved, as a serialised snapshot. Comparing
   * against it is what lets Save be disabled when nothing changed — a plain
   * reference check would not work, since every keystroke makes a new object.
   */
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const scopeKey = agentId && conversationId ? `${agentId}::${conversationId}` : null;

  const load = useCallback(async () => {
    if (!agentId || !conversationId) return;
    setLoading(true);
    setStatus("");
    try {
      const response = await session.request<{
        success?: boolean;
        reflection_settings?: ReflectionSettings | null;
        error?: string;
      }>("get_reflection_settings", {
        runtime: { agent_id: agentId, conversation_id: conversationId } satisfies RuntimeScope,
      });
      if (response?.success === false) {
        setStatus(response.error ?? "Could not load reflection settings");
        return;
      }
      const loaded = response?.reflection_settings ?? null;
      setSettings(loaded);
      setSavedSnapshot(JSON.stringify(loaded));
      setLoadedKey(scopeKey);
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, conversationId, scopeKey, session.request]);

  useEffect(() => {
    if (session.ready && agentId && conversationId) void load();
  }, [session.ready, agentId, conversationId, load]);

  const save = async () => {
    if (!agentId || !conversationId || !settings) return;
    setSaving(true);
    try {
      const response = await session.request<{
        success?: boolean;
        reflection_settings?: ReflectionSettings | null;
        error?: string;
      }>("set_reflection_settings", {
        runtime: { agent_id: agentId, conversation_id: conversationId } satisfies RuntimeScope,
        settings: {
          trigger: settings.trigger,
          step_count: settings.step_count,
          merge: settings.merge,
          merge_instructions: settings.merge_instructions,
        },
      });
      if (response?.success === false) {
        toast(response.error ?? "Could not save reflection settings", "bad");
        return;
      }
      const saved = response?.reflection_settings ?? settings;
      setSettings(saved);
      setSavedSnapshot(JSON.stringify(saved));
      toast(SAVED_NOW);
    } catch (cause) {
      toast(`Could not save: ${errorMessage(cause)}`, "bad");
    } finally {
      setSaving(false);
    }
  };

  if (!agentId || !conversationId) {
    return (
      <p className="muted pad">
        Open a conversation first — reflection settings are resolved against its working directory.
      </p>
    );
  }

  if (loading && loadedKey !== scopeKey) {
    return <p className="muted pad">Loading reflection settings…</p>;
  }

  if (!settings) {
    return (
      <>
        {status ? (
          <p className="warning small" role="alert">
            <span>{status}</span>
          </p>
        ) : null}
        <p className="muted pad">
          No reflection settings reported for this conversation. They appear once the runtime has
          started — send a message, then reload.
        </p>
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  const dirty = settings !== null && JSON.stringify(settings) !== savedSnapshot;

  return (
    <>
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      <div className="pad-x">
        <label className="field">
          Trigger
          <select
            value={settings.trigger}
            onChange={(event) =>
              setSettings({ ...settings, trigger: event.target.value as TriggerMode })
            }
          >
            {TRIGGER_LABELS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="muted small">
            {TRIGGER_LABELS.find((option) => option.id === settings.trigger)?.hint}
          </span>
        </label>

        {settings.trigger === "step-count" ? (
          <label className="field">
            Steps before reflecting
            <input
              type="number"
              min={1}
              step={1}
              value={settings.step_count}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  step_count: Math.max(1, Number(event.target.value) || 1),
                })
              }
            />
          </label>
        ) : null}

        <label className="field">
          Merge mode
          <select
            value={settings.merge}
            onChange={(event) =>
              setSettings({ ...settings, merge: event.target.value as MergeMode })
            }
          >
            <option value="auto">Auto — merge without asking</option>
            <option value="explicit">Explicit — follow the instructions below</option>
          </select>
        </label>

        {settings.merge === "explicit" ? (
          <label className="field">
            Merge instructions
            <textarea
              rows={4}
              value={settings.merge_instructions}
              placeholder="How reflections should be merged into memory."
              onChange={(event) =>
                setSettings({ ...settings, merge_instructions: event.target.value })
              }
            />
          </label>
        ) : null}

        <button
          type="button"
          className="button"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <p className="muted small pad">
        Applies to this agent in this conversation&apos;s working directory. The scope is the server
        default; this screen does not choose between project and global persistence.
      </p>
    </>
  );
}
