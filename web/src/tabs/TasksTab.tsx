import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@letta-ai/letta-code/app-server-protocol";
import { useCallback, useEffect, useState } from "react";
import { ClaudeRunsList } from "../components/ClaudeRunsList.tsx";
import { CodexRunsList } from "../components/CodexRunsList.tsx";
import { Icon } from "../components/Icon.tsx";
import { ToggleRow } from "../components/MenuRow.tsx";
import { PiRunsList } from "../components/PiRunsList.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { CLAUDE_SUBAGENT_TYPE } from "../lib/claude.ts";
import { CODEX_SUBAGENT_TYPE } from "../lib/codex.ts";
import { shortDate } from "../lib/conversation-groups.ts";
import { describeCron } from "../lib/cron-describe.ts";
import { errorMessage } from "../lib/errors.ts";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";
import { conversationTargetLabel, NEW_CONVERSATION } from "../lib/tasks.ts";
import type { ConversationSummary } from "../state/use-agents.ts";
import type { BackgroundProcessSummary } from "../state/use-conversation.ts";
import type { SessionApi } from "../state/use-session.ts";

interface CronTask {
  id: string;
  /**
   * The conversation this task fires into. Upstream always returns one
   * (`schedule-protocol.ts` `CronTask`); the UI used to discard it, which
   * meant a task could be aimed at a conversation with no way to see or
   * change which. `cron_update` honours it, so it is editable too.
   */
  conversation_id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: string;
  last_fired_at: string | null;
  fire_count: number;
  scheduled_for: string | null;
  last_run_outcome: string | null;
  last_run_error: string | null;
}

const PROCESS_KIND_LABEL: Record<BackgroundProcessSummary["kind"], string> = {
  bash: "Shell",
  agent_task: "Subagent",
  monitor: "Monitor",
  // Not stoppable from here — see stopMonitor's doc.
  workflow: "Workflow",
};

interface Props {
  session: SessionApi;
  agentId: string | null;
  conversationId: string | null;
  backgroundProcesses: BackgroundProcessSummary[];
  onStopMonitor: (processId: string) => void;
  /** Every conversation for this agent, used to name each task's target. */
  conversations: ConversationSummary[];
  /** Profile-gated features: the coding-run lists hide when their token is off. */
  features?: FeatureFlags;
}

/**
 * Suggestions only — the field stays free text. The real list is resolved per
 * cwd (`getAllSubagentConfigs`, which also reads project-defined agents), is
 * not advertised anywhere in the protocol, and an unknown type comes back as
 * an error naming every valid one. The other builtins (fork, init,
 * reflection, memory) are harness internals.
 */
// `codex` runs the Codex CLI instead of a Letta subagent — enabled in Settings → Codex.
// `claude-code` runs the Claude Code CLI — enabled in Settings → Claude Code.
const SUBAGENT_TYPES = [
  "general-purpose",
  "recall",
  "history-analyzer",
  CODEX_SUBAGENT_TYPE,
  CLAUDE_SUBAGENT_TYPE,
];

const BLANK_SUBAGENT = { type: "general-purpose", description: "", prompt: "" };

/**
 * A new task defaults to a fresh conversation per run; the editor overrides
 * `conversationId` with whatever conversation the user picks.
 */
const BLANK = {
  name: "",
  description: "",
  cron: "0 9 * * *",
  prompt: "",
  recurring: true,
  conversationId: NEW_CONVERSATION,
};

export function TasksTab({
  session,
  agentId,
  conversationId,
  backgroundProcesses,
  onStopMonitor,
  conversations,
  features,
}: Props) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [creating, setCreating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [subagent, setSubagent] = useState({ ...BLANK_SUBAGENT });
  const [launchBusy, setLaunchBusy] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) return;
    setStatus("Loading tasks…");
    try {
      const response = await session.request<{
        tasks?: CronTask[];
        success?: boolean;
        error?: string;
      }>("cron_list", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to list tasks");
        return;
      }
      setTasks(response?.tasks ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  }, [agentId, session.request]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  // The agent can schedule its own work; keep the list live.
  useEffect(
    () =>
      session.onFrame((frame) => {
        if ((frame as { type?: unknown }).type === "crons_updated") void load();
      }),
    [session.onFrame, load],
  );

  const act = async (type: string, body: Record<string, unknown>, label: string) => {
    setStatus(`${label}…`);
    try {
      const response = await session.request<{
        success?: boolean;
        error?: string;
        warning?: string;
      }>(type, body);
      if (response?.success === false) {
        setStatus(response.error ?? `${label} failed`);
        return false;
      }
      setStatus(response?.warning ?? "");
      await load();
      return true;
    } catch (cause) {
      setStatus(errorMessage(cause));
      return false;
    }
  };

  /** Shared by Cancel, the scrim and Escape, now that the Sheet supplies all three. */
  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
  };

  const submit = async () => {
    if (!agentId) return;
    const target = draft.conversationId.trim() || NEW_CONVERSATION;
    const ok = editing
      ? await act(
          "cron_update",
          {
            task_id: editing.id,
            name: draft.name,
            description: draft.description,
            conversation_id: target,
            cron: draft.cron,
            prompt: draft.prompt,
            recurring: draft.recurring,
          },
          "Saving",
        )
      : await act(
          "cron_add",
          {
            agent_id: agentId,
            conversation_id: target,
            name: draft.name,
            description: draft.description || draft.name,
            cron: draft.cron,
            recurring: draft.recurring,
            prompt: draft.prompt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          "Creating",
        );
    if (ok) {
      setEditing(null);
      setCreating(false);
      setDraft({ ...BLANK });
    }
  };

  /**
   * `launch_subagent` runs beside the parent's turn without taking its lease,
   * so it works mid-turn too. The child shows up under "Running now" via
   * device status and reports back into this conversation when it finishes.
   */
  const launchSubagent = async () => {
    if (!agentId || !conversationId) return;
    const subagentType = subagent.type.trim() || "general-purpose";
    const args: LaunchSubagentCommand["args"] = {
      subagent_type: subagentType,
      description: subagent.description.trim(),
      prompt: subagent.prompt.trim(),
    };
    setLaunchBusy(true);
    setStatus("Launching subagent…");
    try {
      const response = await session.request<LaunchSubagentResponse>("launch_subagent", {
        runtime: { agent_id: agentId, conversation_id: conversationId },
        args,
      });
      if (!response.success) {
        setStatus(response.error);
        return;
      }
      setStatus(`Subagent started (${response.task_id}); it reports back to this conversation.`);
      setLaunching(false);
      setSubagent({ ...BLANK_SUBAGENT });
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setLaunchBusy(false);
    }
  };

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">Select an agent.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        <button
          type="button"
          className="link"
          onClick={() => {
            setDraft({ ...BLANK, conversationId: conversationId ?? NEW_CONVERSATION });
            setEditing(null);
            setCreating(true);
          }}
        >
          <Icon name="plus" /> New task
        </button>
        <button
          type="button"
          className="link"
          disabled={!conversationId}
          onClick={() => {
            setSubagent({ ...BLANK_SUBAGENT });
            setLaunching(true);
          }}
          title={conversationId ? "Launch a subagent" : "Open a conversation first"}
        >
          <Icon name="plus" /> Subagent
        </button>
        <span className="spacer" />
        <span className="muted small">{tasks.length} scheduled</span>
        <button
          type="button"
          className="link"
          onClick={() => void load()}
          title="Reload tasks"
          aria-label="Reload tasks"
        >
          <Icon name="refresh" />
        </button>
      </div>

      {status ? <p className="muted small pad">{status}</p> : null}

      {backgroundProcesses.length > 0 ? (
        <>
          <p className="section-note">Running now</p>
          <ul className="list">
            {backgroundProcesses.map((process) => (
              <li key={process.processId} className="task">
                <div className="task-head">
                  <span className="tag muted">{PROCESS_KIND_LABEL[process.kind]}</span>
                  <span className="small">{process.label}</span>
                </div>
                <div className="muted small">{process.status}</div>
                {process.stoppable ? (
                  <div className="task-actions">
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => onStopMonitor(process.processId)}
                    >
                      Stop
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="section-note">Scheduled</p>
        </>
      ) : null}

      {/* The run viewers belong to the coding workers: their profile token
          off means the worker cannot run, so the viewer has nothing to show. */}
      {featureEnabled(features, "codex") ? (
        <CodexRunsList
          refreshKey={backgroundProcesses
            .filter((process) => process.kind === "agent_task")
            .map((process) => process.processId)
            .join(",")}
        />
      ) : null}

      {featureEnabled(features, "claude") ? (
        <ClaudeRunsList
          refreshKey={backgroundProcesses
            .filter((process) => process.kind === "agent_task")
            .map((process) => process.processId)
            .join(",")}
        />
      ) : null}

      {/* Remote-pi runs are captured by the BFF itself, so this list does not
          need the worker tokens the coding lists ride on — only `pi` itself. */}
      {featureEnabled(features, "pi") ? (
        <PiRunsList
          refreshKey={backgroundProcesses
            .filter((process) => process.kind === "agent_task")
            .map((process) => process.processId)
            .join(",")}
        />
      ) : null}

      <ul className="list">
        {tasks.map((task) => (
          <li key={task.id} className="task">
            <div className="task-head">
              <strong>{task.name}</strong>
              <span className={`tag ${task.status === "active" ? "" : "muted"}`}>
                {task.status}
              </span>
            </div>
            <div className="muted small">
              <code>{task.cron}</code> · {task.timezone} ·{" "}
              {task.recurring ? "repeating" : "one-shot"}
            </div>
            <div className="muted small">
              Runs in: {conversationTargetLabel(task.conversation_id, conversations)}
            </div>
            {task.description ? <div className="small">{task.description}</div> : null}
            <div className="muted small">
              {task.last_fired_at
                ? `Last fired ${shortDate(task.last_fired_at)} (${task.fire_count}×)`
                : task.scheduled_for
                  ? `Scheduled for ${shortDate(task.scheduled_for)}`
                  : "Never fired"}
              {task.last_run_outcome ? ` · ${task.last_run_outcome}` : ""}
            </div>
            {task.last_run_error ? <div className="small bad">{task.last_run_error}</div> : null}

            <div className="task-actions">
              <button
                type="button"
                className="link"
                onClick={() => void act("cron_trigger", { task_id: task.id }, "Running")}
              >
                Run now
              </button>
              {task.status === "active" ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => void act("cron_pause", { task_id: task.id }, "Pausing")}
                >
                  Pause
                </button>
              ) : null}
              {task.status === "paused" ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => void act("cron_resume", { task_id: task.id }, "Resuming")}
                >
                  Resume
                </button>
              ) : null}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setEditing(task);
                  setCreating(false);
                  setDraft({
                    name: task.name,
                    description: task.description,
                    cron: task.cron,
                    prompt: task.prompt,
                    recurring: task.recurring,
                    conversationId: task.conversation_id || NEW_CONVERSATION,
                  });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="link danger"
                onClick={() => {
                  if (confirm(`Delete "${task.name}"?`)) {
                    void act("cron_delete", { task_id: task.id }, "Deleting");
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && !status ? <li className="muted pad">No scheduled tasks</li> : null}
      </ul>

      {launching ? (
        <Sheet
          title="Launch subagent"
          onClose={() => setLaunching(false)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setLaunching(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={launchBusy || !subagent.description.trim() || !subagent.prompt.trim()}
                onClick={() => void launchSubagent()}
              >
                {launchBusy ? "Launching…" : "Launch"}
              </button>
            </>
          }
        >
          <label className="field">
            Type
            <input
              value={subagent.type}
              list="subagent-types"
              onChange={(event) => setSubagent({ ...subagent, type: event.target.value })}
            />
            <datalist id="subagent-types">
              {SUBAGENT_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>

          {subagent.type.trim() === CODEX_SUBAGENT_TYPE ? (
            // No `mcp.inherit` toggle: upstream only forwards the parent's
            // per-agent MCP list, which is always empty here (the shared list
            // lives in bff/src/mcp). A worker reaches it through the
            // mcp-servers skill's wrapper, named in its prompt.
            <p className="muted small">
              A Codex worker, set up in the Codex section of Settings. Its full run appears under
              Codex runs.
            </p>
          ) : null}

          {subagent.type.trim() === CLAUDE_SUBAGENT_TYPE ? (
            <p className="muted small">
              A Claude Code worker, set up in the Claude Code section of Settings. Its full run
              appears under Claude runs.
            </p>
          ) : null}

          <label className="field">
            Description
            <input
              value={subagent.description}
              placeholder="A few words, shown in Running now"
              onChange={(event) => setSubagent({ ...subagent, description: event.target.value })}
            />
          </label>

          <label className="field">
            Prompt
            <textarea
              value={subagent.prompt}
              rows={5}
              onChange={(event) => setSubagent({ ...subagent, prompt: event.target.value })}
            />
            <span className="muted small">
              Runs in this conversation's working directory and reports back here when done.
            </span>
          </label>
        </Sheet>
      ) : null}

      {creating || editing ? (
        <Sheet
          title={editing ? "Edit task" : "New task"}
          onClose={closeEditor}
          actions={
            <>
              <button type="button" className="button ghost" onClick={closeEditor}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!draft.name.trim() || !draft.prompt.trim()}
                onClick={() => void submit()}
              >
                {editing ? "Save" : "Create"}
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="field">
            Description
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <label className="field">
            Schedule (cron)
            <input
              className="mono-input"
              value={draft.cron}
              placeholder="0 9 * * *"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setDraft({ ...draft, cron: event.target.value })}
            />
            <span className="muted small">
              {describeCron(draft.cron) ? (
                <span className="ok">{describeCron(draft.cron)}</span>
              ) : draft.cron.trim() ? (
                "Custom schedule"
              ) : null}
              {draft.cron.trim() ? <br /> : null}
              minute hour day month weekday — e.g. <code>0 9 * * *</code> is 9am daily
            </span>
          </label>

          <label className="field">
            Prompt sent to the agent
            <textarea
              value={draft.prompt}
              rows={4}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>

          <ToggleRow
            title="Repeating"
            description="Off runs it once, at the next match"
            checked={draft.recurring}
            onChange={(recurring) => setDraft({ ...draft, recurring })}
          />

          <label className="field">
            Conversation it runs in
            <select
              value={draft.conversationId}
              onChange={(event) => setDraft({ ...draft, conversationId: event.target.value })}
            >
              <option value={NEW_CONVERSATION}>New conversation each run</option>
              {/* A target outside this agent's listed conversations — "default",
                  or one the list does not carry — still needs an option, or the
                  select would silently display the first entry instead. */}
              {draft.conversationId !== NEW_CONVERSATION &&
              !conversations.some((c) => c.id === draft.conversationId) ? (
                <option value={draft.conversationId}>
                  {conversationTargetLabel(draft.conversationId, conversations)}
                </option>
              ) : null}
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.summary}
                  {conversation.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
            <span className="muted small">
              The prompt is delivered there each time the schedule matches. Picking the conversation
              you are in now keeps its context.
            </span>
          </label>
        </Sheet>
      ) : null}
    </div>
  );
}
