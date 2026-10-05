import { useEffect, useState } from "react";
import {
  type AgentToolAccess,
  fetchAgentToolAccess,
  type GoogleAccess,
  type ModsResult,
  saveAgentToolAccess,
} from "../lib/agent-tool-access.ts";
import { errorMessage } from "../lib/errors.ts";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";

interface Props {
  agentId: string;
  /** Profile-gated features: a family whose token is off cannot be narrowed, so its row is hidden. */
  features?: FeatureFlags;
  /** Codex, Claude Code and Google themselves are set up for every agent in Settings. */
  onOpenGlobalSettings: () => void;
}

const GOOGLE_OPTIONS: { id: GoogleAccess; label: string; hint: string }[] = [
  {
    id: "full",
    label: "Full",
    hint: "Everything Settings → Google allows, including sending and editing.",
  },
  {
    id: "read",
    label: "Read-only",
    hint: "Search and read only: no sending, drafting or editing, even where Settings → Google allows it.",
  },
  { id: "off", label: "Off", hint: "No Google tools at all." },
];

const SAVED_NOTE: Record<ModsResult, string> = {
  unchanged: "Saved.",
  reloaded: "Saved. Applies from the agent's next turn.",
  "reload-pending": "Saved. It takes effect once the app-server reloads its mods.",
  failed: "Saved, but the tools could not be updated yet. They catch up on the next reconnect.",
};

/**
 * Which of the shared tool families this agent gets. Narrows, never widens:
 * what Settings → Codex workers and → Google turn off stays off for everyone.
 */
export function AgentToolsSection({ agentId, features, onOpenGlobalSettings }: Props) {
  const [access, setAccess] = useState<AgentToolAccess | null>(null);
  const [saved, setSaved] = useState<AgentToolAccess | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAccess(null);
    setStatus("");
    fetchAgentToolAccess(agentId)
      .then((loaded) => {
        if (cancelled) return;
        setAccess(loaded);
        setSaved(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setStatus(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const save = async () => {
    if (!access) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const { mods, ...next } = await saveAgentToolAccess(agentId, access);
      setAccess(next);
      setSaved(next);
      setStatus(SAVED_NOTE[mods] ?? "Saved.");
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!access) {
    return <p className="muted pad">{status || "Loading tool access…"}</p>;
  }

  const dirty =
    !saved ||
    saved.codex !== access.codex ||
    saved.claude !== access.claude ||
    saved.google !== access.google ||
    saved.pi !== access.pi;

  const showGoogle = featureEnabled(features, "google");
  const showCodex = featureEnabled(features, "codex");
  const showClaude = featureEnabled(features, "claude");
  const showPi = featureEnabled(features, "pi");
  if (!showGoogle && !showCodex && !showClaude && !showPi) {
    return (
      <p className="muted pad">
        No shared tool family is enabled on this instance, so there is nothing to narrow here.
      </p>
    );
  }

  return (
    <>
      <div className="pad-x">
        {showGoogle ? (
          <label className="field">
            Google (Gmail, Calendar, Tasks, Contacts)
            <select
              value={access.google}
              onChange={(event) =>
                setAccess({ ...access, google: event.target.value as GoogleAccess })
              }
            >
              {GOOGLE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="muted small">
              {GOOGLE_OPTIONS.find((option) => option.id === access.google)?.hint}
            </span>
          </label>
        ) : null}

        {showCodex ? (
          <label className="field">
            Codex workers
            <select
              value={access.codex ? "on" : "off"}
              onChange={(event) => setAccess({ ...access, codex: event.target.value === "on" })}
            >
              <option value="on">Allowed</option>
              <option value="off">Blocked</option>
            </select>
            <span className="muted small">
              {access.codex
                ? "The agent may hand coding tasks to Codex workers."
                : "Starting or messaging a Codex worker is refused, in every permission mode."}
            </span>
          </label>
        ) : null}

        {showClaude ? (
          <label className="field">
            Claude Code workers
            <select
              value={access.claude ? "on" : "off"}
              onChange={(event) => setAccess({ ...access, claude: event.target.value === "on" })}
            >
              <option value="on">Allowed</option>
              <option value="off">Blocked</option>
            </select>
            <span className="muted small">
              {access.claude
                ? "The agent may hand coding tasks to Claude Code workers."
                : "Starting or messaging a Claude Code worker is refused, in every permission mode."}
            </span>
          </label>
        ) : null}

        {showPi ? (
          <label className="field">
            Remote pi worker
            <select
              value={access.pi ? "on" : "off"}
              onChange={(event) => setAccess({ ...access, pi: event.target.value === "on" })}
            >
              <option value="on">Allowed</option>
              <option value="off">Blocked</option>
            </select>
            <span className="muted small">
              {access.pi
                ? "The agent may dispatch coding tasks to the remote pi agent."
                : "The pi tools are hidden from this agent's turns."}
            </span>
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
        {status ? <p className="muted small">{status}</p> : null}
      </div>

      <p className="muted small pad">
        These only narrow what is set up for every agent in{" "}
        <button type="button" className="link inline" onClick={onOpenGlobalSettings}>
          Settings
        </button>
        . They control which tools the agent is offered, not what its shell can reach: it runs in
        the same container as every other agent.
      </p>
    </>
  );
}
