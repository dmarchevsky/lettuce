import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { AgentDraft, AgentsApi } from "../state/use-agents.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { ModelField } from "./AgentEditor.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  agentId: string;
}

/**
 * Agent → General: name, model and base system prompt, edited in place, plus
 * the delete. Creating an agent stays a sheet (`AgentEditor`) — there is no
 * agent yet for this tab to be about.
 */
export function AgentGeneralSection({ session, agents, agentId }: Props) {
  const models = useModels(session);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  /** The agent as last loaded or saved, so Save knows what changed. */
  const [saved, setSaved] = useState<AgentDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Only a failed load — a save result is a toast, it does not live on the page. */
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const { retrieveAgent } = agents;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setDraft(null);
    setDeleting(false);
    setStatus(null);
    void (async () => {
      try {
        const detail = await retrieveAgent(agentId);
        if (cancelled) return;
        const loaded = {
          name: detail.name,
          system: detail.system,
          modelHandle: detail.modelHandle,
        };
        setDraft(loaded);
        setSaved(loaded);
      } catch (cause) {
        if (!cancelled) setStatus(errorMessage(cause));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, retrieveAgent]);

  if (!draft || !saved) {
    return <p className="muted pad">{status ?? "Loading agent…"}</p>;
  }

  const dirty =
    draft.name !== saved.name ||
    draft.system !== saved.system ||
    draft.modelHandle !== saved.modelHandle;

  const save = async () => {
    setBusy(true);
    try {
      // Re-sending the current handle would make the server redo the whole model
      // switch (and its context-window reconciliation) for no change.
      await agents.updateAgent(agentId, {
        ...draft,
        modelHandle: draft.modelHandle === saved.modelHandle ? null : draft.modelHandle,
      });
      setSaved(draft);
      toast("Saved — agents see it on their next turn");
    } catch (cause) {
      toast(`Could not save: ${errorMessage(cause)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pad-x">
      <label className="field">
        Name
        <input
          value={draft.name}
          placeholder="my-assistant"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>

      <ModelField
        models={models}
        value={draft.modelHandle}
        emptyLabel="Unchanged"
        onChange={(modelHandle) => setDraft({ ...draft, modelHandle })}
      />

      <label className="field">
        Base system prompt (managed by letta-code)
        <textarea
          className="deny-reason"
          value={draft.system}
          rows={8}
          onChange={(event) => setDraft({ ...draft, system: event.target.value })}
        />
        {/* Neither half of this is discoverable from the field itself, and
            both surprised someone: an agent asked to "update its system
            prompt" rewrites its persona block, not this, so this looked
            unchanged and the work looked lost. */}
        <span className="small">
          A versioned preset letta-code refreshes on upgrade (tracked as{" "}
          <code>systemPromptPreset</code> / <code>systemPromptHash</code>). Editing it marks this
          agent <strong>custom</strong> and stops those refreshes for good.
        </span>
      </label>
      <p className="muted small">
        This is not where an agent's own instructions live. What it writes about itself — and what
        you should edit to shape its behaviour — is the persona block in the <strong>Memory</strong>{" "}
        tab (<code>system/persona.md</code>, or <code>persona.md</code> for agents created on
        letta-code 0.33.3 or later).
      </p>

      <button
        type="button"
        className="button"
        disabled={busy || !dirty || !draft.name.trim()}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save"}
      </button>

      <p className="section-note agent-delete-head">Delete</p>
      <button
        type="button"
        className="button danger outline"
        disabled={busy}
        onClick={() => setDeleting(true)}
      >
        Delete agent…
      </button>
      {deleting ? (
        <DeleteAgentSheet
          agents={agents}
          agent={{ id: agentId, name: saved.name }}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </div>
  );
}
