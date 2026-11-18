import { useEffect, useRef, useState } from "react";
import {
  fetchAgentStepLimit,
  parseStepLimitInput,
  saveAgentStepLimit,
} from "../lib/agent-step-limit.ts";
import type { AvatarPref } from "../lib/agent-tint.ts";
import { errorMessage } from "../lib/errors.ts";
import {
  type AgentDraft,
  type AgentsApi,
  buildCompactionRecord,
  type CompactionMode,
  DEFAULT_COMPACTION_MODE,
  DEFAULT_SLIDING_WINDOW_PERCENT,
  isSlidingWindowMode,
  parseSlidingWindowPercent,
} from "../state/use-agents.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ModelField } from "./AgentEditor.tsx";
import { AvatarSheet } from "./AvatarSheet.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import { toast } from "./Toast.tsx";

const COMPACTION_OPTIONS: Array<{ mode: CompactionMode; label: string; caption: string }> = [
  {
    mode: "sliding_window",
    label: "Drop the oldest turns (default)",
    caption:
      "When this agent fills its context: the oldest turns are dropped, nothing is summarized. The cheapest mode, and the default.",
  },
  {
    mode: "self_compact_sliding_window",
    label: "Summarize in context, then drop the oldest turns",
    caption:
      "When this agent fills its context: the oldest turns are summarized inside the agent's own request first, then dropped.",
  },
  {
    mode: "all",
    label: "Summarize the whole conversation (separate request)",
    caption:
      "When this agent fills its context: a separate summariser request carries a truncated transcript of the whole conversation and returns one summary. More faithful than dropping, pricier than sliding.",
  },
  {
    mode: "self_compact_all",
    label: "Summarize the whole conversation in context",
    caption:
      "When this agent fills its context: the whole conversation is summarized inside the agent's own request — no separate summariser call, and the most faithful summary. The summary request is as big as the conversation.",
  },
];

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
  /** The model call limit as typed ("" is none), staged like the avatar: Save commits it. */
  const [stepLimit, setStepLimit] = useState("");
  const [stepLimitSaved, setStepLimitSaved] = useState("");
  /** Why the model call limit could not be read; its field is disabled until a reload. */
  const [stepLimitError, setStepLimitError] = useState<string | null>(null);
  /** The compaction mode and drop percentage, staged like every other field: Save commits them. */
  const [compactionMode, setCompactionMode] = useState<CompactionMode>(DEFAULT_COMPACTION_MODE);
  const [compactionModeSaved, setCompactionModeSaved] =
    useState<CompactionMode>(DEFAULT_COMPACTION_MODE);
  const [dropPercent, setDropPercent] = useState(String(DEFAULT_SLIDING_WINDOW_PERCENT));
  const [dropPercentSaved, setDropPercentSaved] = useState(String(DEFAULT_SLIDING_WINDOW_PERCENT));
  /** The stored record as loaded — keys this form does not own ride back through it. */
  const [compactionSource, setCompactionSource] = useState<Record<string, unknown>>({});
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
      // The model call limit is a separate BFF setting: its failing to load disables
      // its own field, never the rest of the form.
      const limitRequest = fetchAgentStepLimit(agentId).then(
        (limit) => ({ limit, error: null }),
        (cause: unknown) => ({ limit: null, error: errorMessage(cause) }),
      );
      try {
        const detail = await retrieveAgent(agentId);
        const { limit, error } = await limitRequest;
        if (cancelled) return;
        const loaded = {
          name: detail.name,
          system: detail.system,
          modelHandle: detail.modelHandle,
        };
        const chosen = avatarsRef.current[agentId] ?? {};
        const limitText = limit === null ? "" : String(limit);
        const percentText = String(detail.compaction.slidingWindowPercent);
        setDraft(loaded);
        setSaved(loaded);
        setAvatar(chosen);
        setAvatarSaved(chosen);
        setStepLimit(limitText);
        setStepLimitSaved(limitText);
        setStepLimitError(error);
        setCompactionMode(detail.compaction.mode);
        setCompactionModeSaved(detail.compaction.mode);
        setCompactionSource(detail.compaction.source);
        setDropPercent(percentText);
        setDropPercentSaved(percentText);
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
  const stepLimitValue = parseStepLimitInput(stepLimit);
  const stepLimitDirty = stepLimit.trim() !== stepLimitSaved;
  const showDropPercent = isSlidingWindowMode(compactionMode);
  const dropPercentValue = parseSlidingWindowPercent(dropPercent);
  const compactionDirty =
    compactionMode !== compactionModeSaved || dropPercent !== dropPercentSaved;
  const dirty = agentFieldsDirty || avatarDirty || stepLimitDirty || compactionDirty;

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
        // Marked saved as each part lands: when a later part fails, a retry
        // must not send this one (and its model switch) again.
        setSaved(draft);
      }
      if (avatarDirty) {
        await agents.setAvatar(agentId, {
          tint: avatar.tint ?? null,
          glyph: avatar.glyph ?? null,
          image: avatar.image ?? null,
        });
        setAvatarSaved(avatar);
      }
      // The model call limit is the BFF's too; the watchdog reads it at every step.
      if (stepLimitDirty && stepLimitValue !== undefined) {
        const savedLimit = await saveAgentStepLimit(agentId, stepLimitValue);
        const limitText = savedLimit === null ? "" : String(savedLimit);
        setStepLimit(limitText);
        setStepLimitSaved(limitText);
      }
      // Its own write, whenever this part is dirty: upstream stores the record in
      // place of the old one, so it is rebuilt from the record as loaded (foreign
      // keys survive) and a mode switch saved while a hidden % field holds junk
      // still writes — on the last good percentage, never silently skipped.
      if (compactionDirty) {
        const percent =
          dropPercentValue ??
          parseSlidingWindowPercent(dropPercentSaved) ??
          DEFAULT_SLIDING_WINDOW_PERCENT;
        const record = buildCompactionRecord(compactionSource, {
          mode: compactionMode,
          slidingWindowPercent: percent,
          // Only a valid edit rewrites the fraction; junk in a hidden field counts
          // as untouched, so the raw stored fraction passes through unchanged.
          percentEdited: dropPercentValue !== undefined && dropPercent !== dropPercentSaved,
        });
        await agents.saveAgentCompaction(agentId, record);
        // The written record becomes the base for the next write: a later
        // percent-untouched Save must pass through what this one stored, not what
        // the page first loaded.
        setCompactionSource(record);
        setCompactionModeSaved(compactionMode);
        // The field shows what the store now holds — not what was typed: junk in a
        // field that was only hidden must not come back as the current value when
        // it reappears, and a loaded value this UI would not accept stays shown.
        const stored = record.sliding_window_percentage;
        const shown =
          typeof stored === "number" ? String(Math.round(stored * 100)) : String(percent);
        setDropPercent(shown);
        setDropPercentSaved(shown);
      }
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

      <label className="field">
        Model call limit
        {/* Text, not `type="number"`: a number input reports a half-typed "5e"
            or "-" as "", which would read as "no limit" and save as one. */}
        <input
          type="text"
          inputMode="numeric"
          value={stepLimit}
          placeholder="No limit"
          disabled={stepLimitError !== null}
          onChange={(event) => setStepLimit(event.target.value)}
        />
        <span className="small">
          {stepLimitError !== null
            ? `Could not load the model call limit: ${stepLimitError}`
            : stepLimitValue === undefined
              ? "A whole number of 1 or more, or empty for no limit."
              : "Stops a turn after this many model calls (each tool round-trip is one), in chats, crons and Telegram alike. Empty means no limit."}
        </span>
      </label>

      <label className="field">
        Compaction
        <select
          value={compactionMode}
          onChange={(event) => setCompactionMode(event.target.value as CompactionMode)}
        >
          {COMPACTION_OPTIONS.map((option) => (
            <option key={option.mode} value={option.mode}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="small">
          {COMPACTION_OPTIONS.find((option) => option.mode === compactionMode)?.caption}
        </span>
      </label>
      {showDropPercent ? (
        <label className="field">
          Drop per compaction (%)
          {/* Text, not `type="number"`, for the reason the call-limit field gives: a
              half-typed value must disable Save, not save as something else. */}
          <input
            type="text"
            inputMode="numeric"
            value={dropPercent}
            onChange={(event) => setDropPercent(event.target.value)}
          />
          <span className="small">
            Each compaction drops at least this much of the context window — more if the
            conversation is still over it. Whole percent 1–80.
          </span>
        </label>
      ) : null}

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
        disabled={
          busy ||
          !dirty ||
          !draft.name.trim() ||
          stepLimitValue === undefined ||
          // Only a *dirty* unparseable % blocks Save: a loaded fraction above 80
          // (upstream's own self-configuration skill can store one) must not brick
          // the whole form — nothing about it is being written.
          (showDropPercent && dropPercentValue === undefined && dropPercent !== dropPercentSaved)
        }
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
