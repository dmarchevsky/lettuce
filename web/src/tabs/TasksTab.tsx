import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@letta-ai/letta-code/app-server-protocol";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { ToggleRow } from "../components/MenuRow.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { toast } from "../components/Toast.tsx";
import { CLAUDE_SUBAGENT_TYPE } from "../lib/claude.ts";
import { CODEX_SUBAGENT_TYPE } from "../lib/codex.ts";
import { shortDate } from "../lib/conversation-groups.ts";
import { describeCron } from "../lib/cron-describe.ts";
import { errorMessage } from "../lib/errors.ts";
import { findMonitorBackupWake } from "../lib/monitor-backup.ts";
import type { LiveSubagent } from "../lib/subagents.ts";
import { subagentStatusLine, workflowPhasesLine, workflowStatusLine } from "../lib/subagents.ts";
import {
  askToChangeText,
  fetchSystemCron,
  jobsForAgent,
  type SystemCronList,
} from "../lib/system-cron.ts";
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
  // No client-side command stops a workflow.
  workflow: "Workflow",
};

interface Props {
  session: SessionApi;
  agentId: string | null;
  conversationId: string | null;
  backgroundProcesses: BackgroundProcessSummary[];
  /** Live snapshots keyed by `subagent_id`; the source of subagent row progress. */
  liveSubagents: Record<string, LiveSubagent>;
  onStopMonitor: (processId: string) => void;
  /** Stops a running subagent; resolves to the error to show, or nothing when it stopped. */
  onStopSubagent: (subagentId: string) => Promise<string | null>;
  /** Every conversation for this agent, used to name each task's target. */
  conversations: ConversationSummary[];
  /** Puts text in this conversation's composer and switches to Chat; nothing is sent. */
  onAskAgent: (text: string) => void;
  /** Every agent that exists, so a cron job whose agent is gone still shows somewhere. */
  agentIds: readonly string[];
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
  liveSubagents,
  onStopMonitor,
  onStopSubagent,
  conversations,
  onAskAgent,
  agentIds,
}: Props) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  /** Unix cron jobs, read-only: only an agent can change them. */
  const [cron, setCron] = useState<SystemCronList | null>(null);
  const [cronError, setCronError] = useState("");
  const [status, setStatus] = useState("");
  /** In-flight text for the list; a failed write is a toast, a failed list is the box. */
  const [progress, setProgress] = useState("");
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [creating, setCreating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [subagent, setSubagent] = useState({ ...BLANK_SUBAGENT });
  const [launchBusy, setLaunchBusy] = useState(false);

  /**
   * Which stop a running row answers to, if any. A monitor stops by process id and a subagent by
   * the child agent the app-server still owns (`subagent_stop`); a shell job has no client verb —
   * `task_stop` is an agent tool — so its row never gets one.
   */
  const stopRow = (process: BackgroundProcessSummary): (() => void) | null => {
    if (!process.stoppable) return null;
    if (process.kind === "monitor") return () => onStopMonitor(process.processId);
    const subagentId = process.subagentId;
    if (process.kind !== "agent_task" || !subagentId) return null;
    return () =>
      void onStopSubagent(subagentId).then((error) => {
        if (error) setStatus(error);
      });
  };

  const load = useCallback(async () => {
    if (!agentId) return;
    // Every agent's jobs, filtered at render: an answer cannot belong to the wrong agent.
    // Its own error line, so a failed cron read never hides the agent's tasks.
    void fetchSystemCron().then(
      (list) => {
        setCron(list);
        setCronError("");
      },
      (cause) => setCronError(`Could not list cron jobs: ${errorMessage(cause)}`),
    );
    setProgress("Loading tasks…");
    try {
      const response = await session.request<{
        tasks?: CronTask[];
        success?: boolean;
        error?: string;
      }>("cron_list", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Could not list tasks");
        return;
      }
      setTasks(response?.tasks ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setProgress("");
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
    // The row's buttons are not disabled, so this line is the only sign the press
    // landed at all — without it a slow cron write looks dead and gets pressed twice.
    setProgress(`${label}…`);
    try {
      const response = await session.request<{
        success?: boolean;
        error?: string;
        warning?: string;
      }>(type, body);
      if (response?.success === false) {
        toast(response.error ?? `${label} failed`, "bad");
        return false;
      }
      // A warning is the one part of a successful write that is not visible in the
      // refreshed list — it says the schedule will not fire the way it reads.
      if (response?.warning) toast(response.warning, "warn");
      await load();
      return true;
    } catch (cause) {
      toast(`${label} failed: ${errorMessage(cause)}`, "bad");
      return false;
    } finally {
      setProgress("");
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
    try {
      const response = await session.request<LaunchSubagentResponse>("launch_subagent", {
        runtime: { agent_id: agentId, conversation_id: conversationId },
        args,
      });
      if (!response.success) {
        toast(response.error, "bad");
        return;
      }
      toast("Subagent started — it reports back to this conversation");
      setLaunching(false);
      setSubagent({ ...BLANK_SUBAGENT });
    } catch (cause) {
      toast(`Could not start the subagent: ${errorMessage(cause)}`, "bad");
    } finally {
      setLaunchBusy(false);
    }
  };

  const cronJobs = agentId ? jobsForAgent(cron?.jobs ?? [], agentId, agentIds) : [];

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
        <span className="muted small">{tasks.length + cronJobs.length} scheduled</span>
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

      {progress && !status ? <p className="muted small pad">{progress}</p> : null}
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {backgroundProcesses.length > 0 ? (
        <>
          <p className="section-note">Running now</p>
          <ul className="list">
            {backgroundProcesses.map((process) => {
              const stop = stopRow(process);
              const backup =
                process.kind === "monitor" ? findMonitorBackupWake(process.label, tasks) : null;
              // A subagent's line carries its live tool call, tokens and elapsed off the
              // snapshot; a workflow's carries the counts the device status already sends.
              const child =
                process.kind === "agent_task" && process.subagentId
                  ? liveSubagents[process.subagentId]
                  : undefined;
              const statusLine = child
                ? subagentStatusLine(process.status, child, null)
                : process.workflow
                  ? workflowStatusLine(process.status, process.workflow)
                  : process.status;
              const phasesLine = process.workflow ? workflowPhasesLine(process.workflow) : "";
              return (
                <li key={process.processId} className="task">
                  <div className="task-head">
                    <span className="tag muted">{PROCESS_KIND_LABEL[process.kind]}</span>
                    <span className="small">{process.label}</span>
                  </div>
                  {backup?.scheduled_for ? (
                    <div className="muted small">
                      Backup wake armed — fires if silent by {shortDate(backup.scheduled_for)}
                    </div>
                  ) : null}
                  <div className="muted small">{statusLine}</div>
                  {phasesLine ? <div className="muted small">{phasesLine}</div> : null}
                  {stop ? (
                    <div className="task-actions">
                      <button type="button" className="link danger" onClick={() => void stop()}>
                        Stop
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="section-note">Scheduled</p>
        </>
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
        {cronJobs.map(({ job, owner }) => (
          <li key={`cron:${job.name}`} className="task">
            <div className="task-head">
              <span>
                <strong>{job.name}</strong> <span className="muted small">cron job</span>
              </span>
              {job.live ? null : <span className="tag">waiting for restart</span>}
            </div>
            {job.description ? <div className="small">{job.description}</div> : null}
            {owner === "self" ? null : (
              <div className="muted small">
                {owner === "gone" ? "Its agent no longer exists" : "No agent recorded"}
              </div>
            )}
            {/* Each schedule over its own command: a file may hold several job lines. */}
            {job.entries.map((entry, index) => {
              const described = describeCron(entry.schedule);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a file may repeat a line verbatim, and the list is redrawn whole.
                <Fragment key={index}>
                  <div className="muted small">
                    <code>{entry.schedule}</code>
                    {described ? ` · ${described}` : ""} · {cron?.timezone}
                  </div>
                  <div className="muted small">
                    <code className="cron-command">{entry.command}</code>
                  </div>
                </Fragment>
              );
            })}
            <div className="task-actions">
              <button
                type="button"
                className="link"
                disabled={!conversationId}
                title={conversationId ? undefined : "Open a conversation first"}
                aria-label={`Ask the agent to change ${job.name}`}
                onClick={() => onAskAgent(askToChangeText(job))}
              >
                Ask agent to change
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && cronJobs.length === 0 && !status ? (
          <li className="muted pad">No scheduled tasks</li>
        ) : null}
      </ul>
      {cronError ? <p className="warning small">{cronError}</p> : null}

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
