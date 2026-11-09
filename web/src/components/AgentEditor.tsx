import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  AGENT_PRESETS,
  type AgentDraft,
  type AgentPreset,
  type AgentsApi,
  agentPresetDescription,
} from "../state/use-agents.ts";
import { type ModelsApi, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { AvatarSheet } from "./AvatarSheet.tsx";
import { Icon } from "./Icon.tsx";
import { ModelChoices } from "./ModelPicker.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  onClose: () => void;
}

const EMPTY: AgentDraft = { name: "", system: "", modelHandle: null, avatar: {} };

/**
 * New agent. Editing an existing one is the Agent tab's General section
 * (`AgentGeneralSection`), next to the agent's other settings.
 *
 * The face is offered here too, because an agent being named deserves its face when
 * it is made — but there is no agent to write it to yet, so it is staged in the
 * draft the way the name is and applied by `createAgent` once the id exists.
 */
export function AgentEditor({ session, agents, onClose }: Props) {
  const models = useModels(session);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY);
  const [preset, setPreset] = useState<AgentPreset>("memo");
  const [choosingAvatar, setChoosingAvatar] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The preview has no id to hash a colour from yet, so it is seeded from the name;
  // the sheet's note says which part of it is a promise and which is a guess.
  const seed = draft.name.trim() || "new-agent";
  const avatar = draft.avatar ?? {};

  const create = async () => {
    setBusy(true);
    try {
      await agents.createAgent(preset, draft);
      toast(`Created ${draft.name.trim()}.`);
      onClose();
    } catch (cause) {
      setStatus(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New agent"
      onClose={onClose}
      status={status}
      actions={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !draft.name.trim()}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input
          value={draft.name}
          placeholder="my-assistant"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>

      <label className="field">
        Personality preset
        <select value={preset} onChange={(event) => setPreset(event.target.value as AgentPreset)}>
          {AGENT_PRESETS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="small">{agentPresetDescription(preset)}</span>
      </label>

      <ModelField
        models={models}
        value={draft.modelHandle}
        emptyLabel="Preset default"
        onChange={(modelHandle) => setDraft({ ...draft, modelHandle })}
      />

      <div className="field">
        Avatar
        <div className="avatar-row">
          <AgentAvatar
            agentId={seed}
            name={seed}
            pref={avatar}
            className="agent-avatar avatar-preview"
          />
          <button
            type="button"
            className="button ghost compact"
            onClick={() => setChoosingAvatar(true)}
          >
            Choose…
          </button>
        </div>
        <span className="small">Optional — the same sheet an agent's own tab opens.</span>
      </div>

      {/* A sheet over a sheet: `Sheet` gives Back and Escape to the innermost one,
          so closing the picker leaves this draft exactly as it was. */}
      {choosingAvatar ? (
        <AvatarSheet
          agentId={seed}
          name={seed}
          pref={avatar}
          onPick={(next) => setDraft({ ...draft, avatar: next })}
          onClose={() => setChoosingAvatar(false)}
          note="Applied as soon as the agent is created. Pick no colour and it gets the one its new id hashes to."
        />
      ) : null}
    </Sheet>
  );
}

/**
 * The agent's model: a field that opens the conversation's model sheet.
 *
 * Two idioms for the same choice is what this replaced — a native select here, a
 * grouped sheet there — and only one of them said which endpoint serves what.
 * Picking here **stages**: an agent's model is saved with everything else on its
 * tab, so the sheet sets the draft and `Save` commits, exactly as the name and
 * the system prompt do.
 */
export function ModelField({
  models,
  value,
  emptyLabel,
  hint,
  onChange,
}: {
  models: ModelsApi;
  value: string | null;
  emptyLabel: string;
  /** Shown under the field when the pick is staged rather than applied. */
  hint?: string | null;
  onChange: (handle: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const known = models.models.find((model) => model.handle === value);
  // A handle the endpoint stopped serving shows as itself — the sheet keeps it
  // selectable so saving the name cannot silently move the agent.
  const shown = value === null ? emptyLabel : (known?.label ?? value);
  return (
    <div className="field">
      Model
      <button
        type="button"
        className="field-trigger"
        // The field used to be a `<label>` around a `<select>`, which named the
        // control for free. A button needs its name said out loud, or a screen
        // reader announces a model name with nothing to say what it belongs to.
        aria-label={`Model: ${shown}`}
        disabled={models.loading}
        onClick={() => setPicking(true)}
      >
        <span className={`trigger-value${value === null ? " muted" : ""}`}>{shown}</span>
      </button>
      {hint ? <span className="small">{hint}</span> : null}
      {picking ? (
        <Sheet
          title="Model"
          size="compact"
          status={models.error}
          onClose={() => setPicking(false)}
          headerAction={
            <button
              type="button"
              className="sheet-head-icon"
              disabled={models.loading}
              onClick={() => void models.refresh()}
              aria-label="Refresh the model list"
              title="Refresh"
            >
              <Icon name="refresh" />
            </button>
          }
        >
          <ModelChoices
            models={models}
            currentHandle={value}
            emptyLabel={emptyLabel}
            onPick={(handle) => {
              onChange(handle);
              setPicking(false);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
