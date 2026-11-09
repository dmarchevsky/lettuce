import { useEffect, useRef, useState } from "react";
import type { AvatarPref } from "../lib/agent-tint.ts";
import { errorMessage } from "../lib/errors.ts";
import type { AgentDraft, AgentsApi } from "../state/use-agents.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ModelField } from "./AgentEditor.tsx";
import { AvatarSheet } from "./AvatarSheet.tsx";
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
/**
 * Agent → General: name, model, base system prompt and avatar, edited in place,
 * plus the delete. Creating an agent stays a sheet (`AgentEditor`) — there is no
 * agent yet for this tab to be about.
 */
export function AgentGeneralSection({ session, agents, agentId }: Props) {
  const models = useModels(session);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  /** The agent as last loaded or saved, so Save knows what changed. */
  const [saved, setSaved] = useState<AgentDraft | null>(null);
  /** The avatar choice, staged like every other field here: Save commits it. */
  const [avatar, setAvatar] = useState<AvatarPref>({});
  const [avatarSaved, setAvatarSaved] = useState<AvatarPref>({});
  const [choosingAvatar, setChoosingAvatar] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Only a failed load — a save result is a toast, it does not live on the page. */
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const { retrieveAgent } = agents;
  // Read at load time, not as an effect dependency: saving an avatar changes
  // `agents.avatars`, and an effect that depended on it would reload the form
  // under the edits still being typed.
  const avatarsRef = useRef(agents.avatars);
  avatarsRef.current = agents.avatars;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setDraft(null);
    setDeleting(false);
    setChoosingAvatar(false);
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
        const chosen = avatarsRef.current[agentId] ?? {};
        setDraft(loaded);
        setSaved(loaded);
        setAvatar(chosen);
        setAvatarSaved(chosen);
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

  const agentFieldsDirty =
    draft.name !== saved.name ||
    draft.system !== saved.system ||
    draft.modelHandle !== saved.modelHandle;
  const avatarDirty =
    (avatar.tint ?? null) !== (avatarSaved.tint ?? null) ||
    (avatar.glyph ?? null) !== (avatarSaved.glyph ?? null) ||
    (avatar.image ?? null) !== (avatarSaved.image ?? null);
  const dirty = agentFieldsDirty || avatarDirty;

  /** The model sheet stages a pick instead of applying it, so say that out loud. */
  const modelHint =
    draft.modelHandle === saved.modelHandle
      ? null
      : draft.modelHandle === null
        ? "Saves with no model change — the agent keeps the model it has."
        : `Saves as ${
            models.models.find((model) => model.handle === draft.modelHandle)?.label ??
            draft.modelHandle
          } — from the agent's next turn.`;

  const save = async () => {
    setBusy(true);
    try {
      // Re-sending the current handle would make the server redo the whole model
      // switch (and its context-window reconciliation) for no change. And an
      // avatar-only edit sends no `agent_update` at all: the avatar is the BFF's,
      // not part of the agent record.
      if (agentFieldsDirty) {
        await agents.updateAgent(agentId, {
          ...draft,
          modelHandle: draft.modelHandle === saved.modelHandle ? null : draft.modelHandle,
        });
      }
      if (avatarDirty) {
        await agents.setAvatar(agentId, {
          tint: avatar.tint ?? null,
          glyph: avatar.glyph ?? null,
          image: avatar.image ?? null,
        });
      }
      setSaved(draft);
      setAvatarSaved(avatar);
      toast(agentFieldsDirty ? "Saved — agents see it on their next turn" : "Saved");
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
        hint={modelHint}
        onChange={(modelHandle) => setDraft({ ...draft, modelHandle })}
      />

      <div className="field">
        Avatar
        <div className="avatar-row">
          <AgentAvatar
            agentId={agentId}
            name={draft.name}
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
        {/* The button is the only way into the choice now, so it has to say what is
            behind it — and that the commit is Save, not the sheet's Done. */}
        <span className="small">
          One sheet for the glyph, an image and the colour, as the model field does; Save commits
          it. Reset takes back the letter and colour this agent gets on its own.
        </span>
        {avatar.tint !== undefined || avatar.glyph !== undefined || avatar.image !== undefined ? (
          <button type="button" className="button ghost compact" onClick={() => setAvatar({})}>
            Reset to default
          </button>
        ) : null}
      </div>

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
      {choosingAvatar ? (
        <AvatarSheet
          agentId={agentId}
          name={draft.name}
          pref={avatar}
          onPick={setAvatar}
          onClose={() => setChoosingAvatar(false)}
          // Deleting a shared face cleared it off every agent wearing it, which is
          // a change to this agent's pref that only the BFF knows about.
          onLibraryChanged={() => void agents.refreshAvatars()}
        />
      ) : null}
    </div>
  );
}
