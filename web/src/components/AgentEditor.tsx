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
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  onClose: () => void;
}

const EMPTY: AgentDraft = { name: "", system: "", modelHandle: null };

/**
 * New agent. Editing an existing one is the Agent tab's General section
 * (`AgentGeneralSection`), next to the agent's other settings.
 */
export function AgentEditor({ session, agents, onClose }: Props) {
  const models = useModels(session);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY);
  const [preset, setPreset] = useState<AgentPreset>("memo");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    </Sheet>
  );
}

/** The agent's model, as a select over what the endpoint serves. */
export function ModelField({
  models,
  value,
  emptyLabel,
  onChange,
}: {
  models: ModelsApi;
  value: string | null;
  emptyLabel: string;
  onChange: (handle: string | null) => void;
}) {
  // A model the endpoint no longer serves must stay selectable, or saving the
  // name would silently move the agent onto a different model.
  const known = models.models.some((model) => model.handle === value);
  return (
    <label className="field">
      Model
      <select
        value={value ?? ""}
        disabled={models.loading}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{emptyLabel}</option>
        {value && !known ? <option value={value}>{value} (not served)</option> : null}
        {models.models.map((model) => (
          <option key={model.id} value={model.handle}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}
