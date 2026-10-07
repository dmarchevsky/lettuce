import {
  type AskUserQuestionResponse,
  prepareAskUserQuestionNotif,
} from "@letta-ai/letta-code/ask-user-question";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildMessageContent, type PreparedImage } from "../lib/attachments.ts";
import { errorMessage } from "../lib/errors.ts";
import {
  addLocalUserMessage,
  applyStreamDelta,
  clearLocalNotice,
  createStreamIndex,
  mergeTurnErrors,
  type StreamIndex,
  setLocalNotice,
  settleStreaming,
  sortedEntries,
  type Transcript,
  type TranscriptEntry,
  type TranscriptImage,
  type TurnErrorRecord,
  transcriptFromHistory,
} from "../lib/messages.ts";
import { frameSeq, type RuntimeScope, type SequencedFrame, scopeKey } from "../lib/protocol.ts";
import { planForceSend, type QueuedItem, readQueue } from "../lib/queue-actions.ts";
import { type ResponseFormat, validateResponseFormat } from "../lib/structured-output.ts";
import { pickTurnUsage, type TurnUsage } from "../lib/usage.ts";
import {
  agentWorkspace,
  isPermissionMode,
  type PermissionMode,
  readCommands,
  type SlashCommand,
} from "../lib/workspace.ts";
import type { SessionApi } from "./use-session.ts";

/**
 * Transcript id for the client's own line about a stop.
 *
 * Fixed, so pressing Stop twice replaces the note instead of stacking notes.
 */
const STOP_NOTICE_ID = "local-stop-notice";

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  blockedPath: string | null;
  suggestions: { id: string; text: string }[];
  diffs: unknown[];
}

export interface ToolsetSummary {
  id: string;
  label: string;
  description: string;
  featured: boolean;
}

export interface BackgroundProcessSummary {
  processId: string;
  /** `workflow` is a native wire kind since letta-code 0.33 (`WorkflowBackgroundProcessSummary`). */
  kind: "bash" | "agent_task" | "monitor" | "workflow";
  label: string;
  status: string;
  /** Only monitors can be stopped from here — bash jobs and subagent tasks have no client-reachable stop command. */
  stoppable: boolean;
}

export type { QueuedItem } from "../lib/queue-actions.ts";

export interface ConversationApi {
  entries: TranscriptEntry[];
  processing: boolean;
  /**
   * A stop was accepted upstream but the turn has not ended yet.
   *
   * Not the same as `!processing`: the app-server reports idle the instant it
   * accepts the abort, long before the turn actually unwinds. See `abort`.
   */
  stopping: boolean;
  /** Working directory of this runtime, from device status. */
  cwd: string | null;
  queue: QueuedItem[];
  approvals: PendingApproval[];
  error: string | null;
  /**
   * Send one turn. `responseFormat` constrains the reply to a JSON schema and
   * must already pass `validateResponseFormat`; an invalid value is reported
   * through `error` rather than silently dropped. `images` are already
   * normalized client-side (`lib/attachments.ts`) and ride as base64 content
   * parts; empty text with images attached is a sendable message.
   */
  sendMessage: (
    text: string,
    responseFormat?: ResponseFormat | null,
    images?: PreparedImage[],
  ) => Promise<void>;
  abort: () => Promise<void>;
  respondToApproval: (requestId: string, approve: boolean, reason?: string) => void;
  /**
   * Answer (or dismiss) an async `AskUserQuestion` — letta-code 0.34.1+, where
   * the tool returns an immediate receipt and no longer blocks on an approval.
   * The answer rides ordinary `create_message` delivery as a `<task-notification>`
   * user message built by upstream's own `prepareAskUserQuestionNotif`, so it
   * queues behind a busy turn exactly like a typed message and reaches the
   * agent whenever the person gets to it.
   */
  answerQuestions: (response: AskUserQuestionResponse) => void;
  removeQueued: (itemId: string) => void;
  /**
   * Make one queued user message the next thing that runs: stop the current
   * turn, take every user item out of the queue, and resend them with the
   * target first. Upstream has no promote command — see `planForceSend`.
   */
  forceSend: (itemId: string) => Promise<void>;
  /** Releases items parked by an interrupt so they start the next turn. */
  resumeQueue: () => void;
  runCommand: (commandId: string, args?: string) => void;
  /**
   * Bumped on every `skills_updated` frame, so Settings → Skills re-reads its
   * list — including after an agent's own shell enabled or disabled one.
   */
  skillsVersion: number;
  /** Live permission mode, from device status. Null until the first status frame. */
  permissionMode: PermissionMode | null;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Slash commands this server advertises, built-ins plus mod-contributed. */
  commands: SlashCommand[];
  /** Preference driving the active toolset — "auto" or an explicit id. Null until the first status frame. */
  toolsetPreference: string | null;
  /** Toolsets this runtime can load, from device status. */
  availableToolsets: ToolsetSummary[];
  /** Bash jobs, subagent tasks, monitors and workflows currently running, from device status. */
  backgroundProcesses: BackgroundProcessSummary[];
  /**
   * Stops a persistent monitor. No-op for bash, agent_task and workflow
   * processes — `stopMonitor` upstream refuses anything whose
   * `process.kind !== "monitor"` with "Monitor not found", so a stop button
   * for those would always fail.
   */
  stopMonitor: (processId: string) => void;
  /**
   * Token usage: the turn in flight so far (refreshed after every model step),
   * else the last finished turn. The BFF keeps it, so every device shows the
   * same numbers; null until it has seen a turn. See `lib/usage.ts`.
   */
  turnUsage: TurnUsage | null;
  /**
   * When the turn now running started (wall clock); null while idle. Counts
   * from turn start, not phase start — the composer's working line shows an
   * elapsed that never resets when the phase changes.
   */
  turnStartedAt: number | null;
  /**
   * When the last frame for this conversation arrived. The working line's
   * stall watch: a minute of silence while nothing runs is what "is it hung?"
   * is answered with.
   */
  lastActivityAt: number | null;
}

/**
 * Whether this stream delta is the successful end of a `/clear`.
 *
 * `execute_command_response` would be the obvious signal, but it carries only a
 * `request_id` — no command id — and awaiting it is not an option either: the
 * same frame type answers `/init` and `/doctor`, which run whole agent turns
 * and would outlive the client's request timeout. The lifecycle delta names the
 * command, so it is what we match on.
 */
function isClearCompleted(delta: unknown): boolean {
  if (!delta || typeof delta !== "object") return false;
  const message = delta as { message_type?: unknown; command_id?: unknown; success?: unknown };
  return (
    message.message_type === "slash_command_end" &&
    message.command_id === "clear" &&
    message.success !== false
  );
}

/** The transcript's image entries for a send's prepared images (preview bytes). */
function localEntryImages(images?: PreparedImage[]): TranscriptImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({ mediaType: image.mediaType, dataUrl: image.previewUrl }));
}

function readToolsets(raw: unknown): ToolsetSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {
      id?: unknown;
      label?: unknown;
      description?: unknown;
      is_featured?: unknown;
    };
    if (typeof entry.id !== "string") return [];
    return [
      {
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        description: typeof entry.description === "string" ? entry.description : "",
        featured: entry.is_featured === true,
      },
    ];
  });
}

export function readBackgroundProcesses(raw: unknown): BackgroundProcessSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {
      process_id?: unknown;
      kind?: unknown;
      status?: unknown;
      command?: unknown;
      description?: unknown;
      task_type?: unknown;
    };
    if (typeof entry.process_id !== "string") return [];
    const kind = entry.kind;
    if (kind !== "bash" && kind !== "agent_task" && kind !== "monitor" && kind !== "workflow") {
      return [];
    }
    const status = typeof entry.status === "string" ? entry.status : "unknown";
    const label =
      kind === "bash"
        ? typeof entry.command === "string"
          ? entry.command
          : "(command)"
        : typeof entry.description === "string" && entry.description
          ? entry.description
          : typeof entry.task_type === "string"
            ? entry.task_type
            : kind;
    return [
      {
        processId: entry.process_id,
        kind,
        label,
        status,
        stoppable: kind === "monitor" && status === "running",
      },
    ];
  });
}

function readApproval(raw: unknown): PendingApproval | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { request_id?: unknown; request?: unknown };
  if (typeof frame.request_id !== "string") return null;
  const request = frame.request as
    | {
        tool_name?: unknown;
        input?: unknown;
        tool_call_id?: unknown;
        blocked_path?: unknown;
        permission_suggestions?: unknown;
        diffs?: unknown;
      }
    | undefined;
  if (!request) return null;

  return {
    requestId: frame.request_id,
    toolName: typeof request.tool_name === "string" ? request.tool_name : "tool",
    input:
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, unknown>)
        : {},
    toolCallId: typeof request.tool_call_id === "string" ? request.tool_call_id : "",
    blockedPath: typeof request.blocked_path === "string" ? request.blocked_path : null,
    suggestions: Array.isArray(request.permission_suggestions)
      ? request.permission_suggestions.flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const suggestion = s as { id?: unknown; text?: unknown };
          if (typeof suggestion.id !== "string" || typeof suggestion.text !== "string") return [];
          return [{ id: suggestion.id, text: suggestion.text }];
        })
      : [],
    diffs: Array.isArray(request.diffs) ? request.diffs : [],
  };
}

export function useConversation(
  session: SessionApi,
  agentId: string | null,
  conversationId: string | null,
  /**
   * Fired when the agent reports that `/clear` completed. `/clear` does not
   * clear in place: the app-server creates a fresh conversation and re-points
   * its runtime at it, so the caller has to go and find it.
   */
  onConversationCleared?: () => void,
): ConversationApi {
  // Individually stable; depending on the whole session object would re-fire
  // these effects on every link-state change.
  const { request, send, setScopes, onFrame, onResync, ready, markResynced } = session;

  // Held in a ref, not a dep: the frame subscription below must not re-run when
  // a caller passes a fresh closure, and re-subscribing per render is exactly
  // the unbounded loop `use-session.ts` documents.
  const clearedRef = useRef(onConversationCleared);
  clearedRef.current = onConversationCleared;

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  /** Mirror of `queue` for callbacks that must read the live snapshot. */
  const queueRef = useRef<QueuedItem[]>([]);
  /** Mirror of `processing`, so `forceSend` can decide whether to abort. */
  const processingRef = useRef(false);
  /**
   * Set while force-send aborts a turn it is about to replace. The aborted
   * turn's `turn_finished` lands after the resend is already in flight and
   * the queue is empty (the resend started directly, it was never queued),
   * so the queue check cannot tell this boundary from a real end of work —
   * the flag says the next `turn_finished` is the seam into the resent turn.
   */
  const expectResentTurnRef = useRef(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const [permissionMode, setPermissionModeFromStatus] = useState<PermissionMode | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [toolsetPreference, setToolsetPreferenceFromStatus] = useState<string | null>(null);
  const [availableToolsets, setAvailableToolsets] = useState<ToolsetSummary[]>([]);
  const [backgroundProcesses, setBackgroundProcesses] = useState<BackgroundProcessSummary[]>([]);
  const [turnUsage, setTurnUsage] = useState<TurnUsage | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  /** Mirrors the last frame time; published to render state on every flush. */
  const lastActivityRef = useRef<number | null>(null);
  /** The conversation `refreshUsage` fetches for; a stale answer is dropped. */
  const usageScopeRef = useRef<RuntimeScope | null>(null);
  /** One usage fetch at a time; a request during one runs once more after it. */
  const usageFetchRef = useRef({ running: false, again: false });
  const transcriptRef = useRef<Transcript>(new Map());
  // Alias maps that hold a streamed message together; reset wherever the
  // transcript is, so a stale otid can never bind to a rebuilt transcript.
  const streamIndexRef = useRef<StreamIndex>(createStreamIndex());
  const seqRef = useRef(0);
  const startedRef = useRef<string | null>(null);

  const scope: RuntimeScope | null =
    agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;

  /**
   * Re-render from the transcript, at most once per animation frame.
   *
   * Every streamed token calls this. Sorting and rebuilding the whole transcript
   * per token makes the cost grow with conversation length, and a fast stream can
   * produce more updates than the browser can paint — so the work is coalesced:
   * many tokens arriving in one frame cause one sort and one render, at the
   * frame boundary. The transcript itself is updated synchronously, so no data
   * is ever lost or delayed; only the render is batched.
   *
   * `flushSync` is used where the UI must reflect the transcript immediately
   * rather than a frame later — a turn finishing, or a stop being acknowledged —
   * because a visible lag there reads as the app having dropped the event.
   */
  const flushHandleRef = useRef<number | null>(null);
  const flush = useCallback(() => {
    if (flushHandleRef.current !== null) return;
    flushHandleRef.current = requestAnimationFrame(() => {
      flushHandleRef.current = null;
      setEntries(sortedEntries(transcriptRef.current));
      setLastActivityAt(lastActivityRef.current);
    });
  }, []);

  const flushSync = useCallback(() => {
    if (flushHandleRef.current !== null) {
      cancelAnimationFrame(flushHandleRef.current);
      flushHandleRef.current = null;
    }
    setEntries(sortedEntries(transcriptRef.current));
    setLastActivityAt(lastActivityRef.current);
  }, []);

  useEffect(() => {
    processingRef.current = processing;
  }, [processing]);

  // The turn clock starts when work starts and resets when it ends; the
  // queue pump keeps `processing` up across the seam, so a queued follow-up
  // re-arms it for its own turn.
  useEffect(() => {
    if (processing) {
      setTurnStartedAt((prev) => prev ?? Date.now());
    } else {
      setTurnStartedAt(null);
    }
  }, [processing]);

  // Do not leave a frame scheduled against an unmounted conversation.
  useEffect(
    () => () => {
      if (flushHandleRef.current !== null) {
        cancelAnimationFrame(flushHandleRef.current);
        flushHandleRef.current = null;
      }
    },
    [],
  );

  /**
   * Re-read this conversation's usage from the BFF, which folds every step on
   * its permanent connection. Called on open, after a resync, and on each
   * usage delta or turn end this tab sees — steps come seconds apart at most,
   * so there is no need to fold locally as well.
   */
  const refreshUsage = useCallback(function refresh(): void {
    const state = usageFetchRef.current;
    if (state.running) {
      state.again = true;
      return;
    }
    const target = usageScopeRef.current;
    if (!target) return;
    state.running = true;
    void fetchTurnUsage(target.agent_id, target.conversation_id)
      .then((usage) => {
        if (usage !== undefined && usageScopeRef.current === target) setTurnUsage(usage);
      })
      .finally(() => {
        state.running = false;
        if (state.again) {
          state.again = false;
          refresh();
        }
      });
  }, []);

  const loadHistory = useCallback(
    async (afterResync = false) => {
      if (!conversationId) return;
      setError(null);
      // In parallel with the history request; see `mergeTurnErrors`.
      const turnErrors = agentId ? fetchTurnErrors(agentId, conversationId) : Promise.resolve([]);
      refreshUsage();
      try {
        const response = await request<{ messages?: unknown[] }>("conversation_messages_list", {
          conversation_id: conversationId,
          query: { limit: 200 },
        });
        const messages = Array.isArray(response?.messages) ? response.messages : [];
        transcriptRef.current = transcriptFromHistory(messages);
        mergeTurnErrors(transcriptRef.current, await turnErrors);
        streamIndexRef.current = createStreamIndex();
        seqRef.current = messages.length;
        flushSync();
        // A request/response frame like this one never carries the sequence
        // number that would otherwise flip the link back to "live" on its
        // own — see session-client.ts's markResynced. Only relevant when this
        // reload was resync-triggered; an ordinary load has nothing to un-stick.
        if (afterResync) markResynced();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [agentId, conversationId, request, flush, markResynced, refreshUsage],
  );

  // Start (or resume) the runtime for this conversation, then load its history.
  useEffect(() => {
    if (!ready || !scope) return;
    const key = scopeKey(scope);
    if (startedRef.current === key) return;
    startedRef.current = key;

    transcriptRef.current = new Map();
    streamIndexRef.current = createStreamIndex();
    seqRef.current = 0;
    lastActivityRef.current = null;
    setEntries([]);
    setTurnStartedAt(null);
    setQueue([]);
    queueRef.current = [];
    expectResentTurnRef.current = false;
    setApprovals([]);
    setStopping(false);
    usageScopeRef.current = scope;
    setTurnUsage(null);
    setLastActivityAt(null);

    setScopes([scope]);
    void (async () => {
      const home = agentWorkspace(scope.agent_id);
      try {
        // `cwd` below refuses a directory that does not exist, and no mkdir
        // command exists — but write_file does `mkdir -p` on the parent before
        // writing, so seeding a marker file is how the directory gets created.
        // Best effort: a failure here should not block the turn.
        await request("write_file", {
          path: `${home}/.keep`,
          content: "",
        }).catch(() => undefined);

        // No `workspace_sandbox`: it is write-scoped to a SINGLE root, which
        // left the agent's own memfs memory, /tmp and /root/.letta read-only,
        // and it rode on the per-conversation runtime, so cron- and
        // Telegram-fired turns escaped it entirely. letta-code's filesystem
        // sandbox is off too (see LETTA_FS_SANDBOX in docker/compose.yml).
        // `cwd` points each runtime at its own directory — a convention, not a
        // kernel boundary.
        const started = await request<{ success?: boolean; error?: string }>("runtime_start", {
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
          wait_for_replay: true,
          cwd: home,
        });

        // `success: false` does not throw, so it is checked here.
        if (started?.success === false) {
          setError(started.error ?? "Failed to start the runtime");
        }
      } catch (cause) {
        setError(errorMessage(cause));
      }
      await loadHistory();
    })();
  }, [ready, scope?.agent_id, scope?.conversation_id, request, setScopes, loadHistory]);

  // A resync means the BFF buffer could not cover the gap while we were away.
  useEffect(() => onResync(() => void loadHistory(true)), [onResync, loadHistory]);

  useEffect(() => {
    return onFrame((frame: SequencedFrame) => {
      const type = (frame as { type?: unknown }).type;
      const runtime = (frame as { runtime?: RuntimeScope }).runtime;

      // Ignore traffic for other conversations sharing the app-server.
      if (runtime && scope && runtime.conversation_id !== scope.conversation_id) return;

      // Any frame is activity; the stall watch only looks at how long it has
      // been since the last one, so one timestamp covers every frame kind.
      lastActivityRef.current = Date.now();

      const seq = frameSeq(frame);
      if (seq !== null) seqRef.current = Math.max(seqRef.current, seq);

      switch (type) {
        case "stream_delta": {
          const delta = (frame as { delta?: unknown }).delta;
          const subagentId = (frame as { subagent_id?: unknown }).subagent_id;
          applyStreamDelta(
            transcriptRef.current,
            streamIndexRef.current,
            delta,
            seqRef.current,
            typeof subagentId === "string" ? subagentId : undefined,
          );
          flush();
          // The one signal that /clear landed which actually reaches us. The
          // device status the app-server emits afterwards is scoped to the NEW
          // conversation, so the BFF's per-scope frame filter drops it for a
          // browser still subscribed to this one; this end marker carries the
          // scope captured before the runtime was re-pointed.
          if (isClearCompleted(delta)) clearedRef.current?.();
          // A subagent's steps share this scope but are not this turn's.
          if (
            (delta as { message_type?: unknown } | null)?.message_type === "usage_statistics" &&
            typeof subagentId !== "string"
          ) {
            refreshUsage();
          }
          break;
        }
        case "turn_finished": {
          refreshUsage();
          settleStreaming(transcriptRef.current);
          if (expectResentTurnRef.current) {
            // The seam between an aborted turn and its force-sent replacement:
            // processing continues into the resent turn.
            expectResentTurnRef.current = false;
          } else {
            // A ready queued item means the pump starts the next turn the
            // moment this one unwinds — the working dots must not blink off
            // in between. Paused items (parked by an interrupt) will not
            // start, so they do not hold the indicator on.
            setProcessing(queueRef.current.some((item) => !item.paused));
          }
          // The turn has genuinely unwound now, whatever the app-server said
          // when it accepted the abort. Our own note was about the gap between
          // those two moments, so it goes; the app-server's "Interrupted"
          // status line stays as the record.
          setStopping(false);
          clearLocalNotice(transcriptRef.current, STOP_NOTICE_ID);
          flushSync();
          break;
        }
        case "update_device_status": {
          const status = (
            frame as {
              device_status?: {
                is_processing?: unknown;
                current_working_directory?: unknown;
                current_permission_mode?: unknown;
                supported_commands?: unknown;
                mod_commands?: unknown;
                current_toolset_preference?: unknown;
                available_toolsets?: unknown;
                background_processes?: unknown;
              };
            }
          ).device_status;
          // The seam of a force-send: the abort's own status frames say "not
          // processing" while the replacement turn is staged, and the
          // replacement's own start frames can arrive before the aborted
          // turn's turn_finished — so only turn_finished ends the seam.
          if (!expectResentTurnRef.current || status?.is_processing === true) {
            setProcessing(status?.is_processing === true);
          }
          if (typeof status?.current_working_directory === "string") {
            setCwd(status.current_working_directory);
          }
          // `change_device_state` has no response frame; this is the only
          // acknowledgement a mode change ever gets, so the status frame is the
          // source of truth rather than optimistic local state.
          if (isPermissionMode(status?.current_permission_mode)) {
            setPermissionModeFromStatus(status.current_permission_mode);
          }
          // The command palette is advertised here, not enumerable on demand.
          if (Array.isArray(status?.supported_commands)) {
            setCommands(readCommands(status.supported_commands, status.mod_commands));
          }
          if (typeof status?.current_toolset_preference === "string") {
            setToolsetPreferenceFromStatus(status.current_toolset_preference);
          }
          if (Array.isArray(status?.available_toolsets)) {
            setAvailableToolsets(readToolsets(status.available_toolsets));
          }
          if (Array.isArray(status?.background_processes)) {
            setBackgroundProcesses(readBackgroundProcesses(status.background_processes));
          }
          break;
        }
        case "skills_updated": {
          // Enable/disable moved a symlink in /root/.letta/skills. The list in
          // Settings comes from the BFF's own discovery (`/api/skills`), not
          // from device status, so a re-read picks the change up at once.
          setSkillsVersion((version) => version + 1);
          break;
        }
        case "update_loop_status": {
          // LoopState is an object and has no "idle" member; the terminal state
          // is WAITING_ON_INPUT. Comparing the object to a string left the
          // composer permanently stuck showing "stop".
          const loop = (frame as { loop_status?: { status?: unknown } }).loop_status;
          const loopStatus = loop?.status;
          const loopBusy = typeof loopStatus === "string" && loopStatus !== "WAITING_ON_INPUT";
          // Same force-send seam as in the device-status case above.
          if (!expectResentTurnRef.current || loopBusy) setProcessing(loopBusy);
          break;
        }
        case "update_queue": {
          const items = readQueue((frame as { queue?: unknown }).queue);
          queueRef.current = items;
          setQueue(items);
          break;
        }
        case "control_request": {
          const approval = readApproval(frame);
          if (approval) {
            setApprovals((current) =>
              current.some((a) => a.requestId === approval.requestId)
                ? current
                : [...current, approval],
            );
          }
          break;
        }
        default:
          break;
      }
    });
  }, [onFrame, scope?.conversation_id, flush, flushSync]);

  /**
   * One user message out the door, with its local echo. `raw` is the content
   * as the protocol wants it (string or content parts); `display` is what the
   * echo shows; `images` are what the echo renders beside the text (the wire
   * already carries them inside `raw`). Returns the fresh `client_message_id` —
   * a message must never be resent under an id the listener already
   * acknowledged, which it would silently swallow.
   */
  const sendContent = useCallback(
    (
      raw: unknown,
      display: string,
      responseFormat?: ResponseFormat | null,
      images?: PreparedImage[],
    ): string => {
      if (!scope) throw new Error("No conversation is open");
      const clientMessageId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Render it ourselves: the app-server echoes a user message back only
      // when it was queued behind a busy agent, so on the ordinary path no
      // frame ever arrives and the transcript would show the reply without the
      // question. The id doubles as the otid, so a queued echo merges into this
      // entry rather than duplicating it.
      seqRef.current += 1;
      addLocalUserMessage(
        transcriptRef.current,
        streamIndexRef.current,
        clientMessageId,
        display,
        seqRef.current,
        Boolean(responseFormat),
        localEntryImages(images),
      );
      flushSync();

      send({
        type: "input",
        runtime: scope,
        payload: {
          kind: "create_message",
          messages: [
            {
              role: "user",
              content: raw,
              client_message_id: clientMessageId,
            },
          ],
          ...(responseFormat ? { response_format: responseFormat } : {}),
        },
      });
      return clientMessageId;
    },
    [scope, send, flushSync],
  );

  const sendMessage = useCallback(
    async (text: string, responseFormat?: ResponseFormat | null, images?: PreparedImage[]) => {
      const hasImages = Boolean(images && images.length > 0);
      if (!scope || (!text.trim() && !hasImages)) return;

      // Validate before anything is rendered or sent: a schema the listener
      // would reject should never look like a turn that went through.
      if (responseFormat) {
        const invalid = validateResponseFormat(responseFormat);
        if (invalid) {
          setError(invalid);
          return;
        }
      }

      setProcessing(true);
      setStopping(false);
      expectResentTurnRef.current = false;
      clearLocalNotice(transcriptRef.current, STOP_NOTICE_ID);
      try {
        // Images go as content parts (text part first, dropped when empty);
        // a text-only send keeps the plain string. We validate and shrink
        // client-side, so no `image_failure_mode` is set — strict (the default)
        // is the honest outcome: a server-side normalization failure surfaces
        // as a `loop_error` in the transcript rather than silently vanishing.
        const raw = hasImages ? buildMessageContent(text, images ?? []) : text;
        sendContent(raw, text, responseFormat, images);
      } catch (cause) {
        setProcessing(false);
        setError(errorMessage(cause));
      }
    },
    [scope, sendContent],
  );

  /**
   * Erase our optimistic line for a message that will now never arrive as
   * itself — removed from the queue, or superseded by a force-send resend.
   * Only ever the local echo: once the app-server has echoed the message back
   * (it dequeued), the entry is the real record and stays.
   */
  const dropLocalEcho = useCallback(
    (clientMessageId: string) => {
      if (!clientMessageId) return;
      const entry = transcriptRef.current.get(clientMessageId);
      if (!entry || !entry.local) return;
      transcriptRef.current.delete(clientMessageId);
      streamIndexRef.current.byOtid.delete(clientMessageId);
      flushSync();
    },
    [flushSync],
  );

  const abort = useCallback(async () => {
    if (!scope) return;

    // `send` was fire-and-forget, which threw away the only frame that says
    // whether anything was actually cancelled — and swallowed the "Not
    // connected" throw with it. `request` correlates the response back.
    try {
      const response = await request<{ aborted?: boolean; success?: boolean; error?: string }>(
        "abort_message",
        { runtime: scope },
      );

      if (response?.success === false) {
        setError(response.error ?? "Could not stop the turn");
        return;
      }

      if (response?.aborted === false) {
        // `handleAbortMessageInput` returns early with no active turn and no
        // pending approval, emitting NOTHING — so without this the press was
        // invisible. It also means our `processing` was stale.
        setProcessing(false);
        setStopping(false);
        seqRef.current += 1;
        setLocalNotice(
          transcriptRef.current,
          STOP_NOTICE_ID,
          "Nothing to stop — the agent is not running.",
          "info",
          seqRef.current,
        );
        flushSync();
        return;
      }

      // Accepted, but NOT finished. The app-server flips its lifecycle to
      // `cancelling` and emits "Interrupted" synchronously, then asks the
      // backend to cancel the run — and against a local provider that request
      // reaches a dead end: `createProviderLettaStream` hands out an
      // AbortController wired to nothing and `PiStreamAdapter` is built with no
      // `abortSignal`, so the HTTP request to the model is never aborted. The
      // turn can only end when the model's next chunk arrives. Saying so is the
      // honest thing the UI can do; see AGENTS.md.
      setStopping(true);
      seqRef.current += 1;
      setLocalNotice(
        transcriptRef.current,
        STOP_NOTICE_ID,
        "Stopping — the response already in flight may still finish first.",
        "warning",
        seqRef.current,
      );
      flushSync();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [scope, request, flush]);

  const respondToApproval = useCallback(
    (requestId: string, approve: boolean, reason?: string) => {
      if (!scope) return;
      send({
        type: "input",
        runtime: scope,
        payload: {
          kind: "approval_response",
          request_id: requestId,
          decision: approve
            ? { behavior: "allow" }
            : { behavior: "deny", message: reason ?? "Denied from the web UI" },
        },
      });
      setApprovals((current) => current.filter((a) => a.requestId !== requestId));
    },
    [scope, send],
  );

  const answerQuestions = useCallback(
    (response: AskUserQuestionResponse) => {
      // A question answer is just a message: same send path, same queueing,
      // same optimistic echo — `splitInjectedBlocks` renders the echo as the
      // answered state of the card, not as a raw XML bubble.
      void sendMessage(prepareAskUserQuestionNotif(response));
    },
    [sendMessage],
  );

  const removeQueued = useCallback(
    (itemId: string) => {
      if (!scope) return;
      const item = queueRef.current.find((q) => q.id === itemId);
      send({
        type: "remove_queue_item",
        runtime: scope,
        request_id: `dequeue-${Date.now()}`,
        item_id: itemId,
      });
      // A cancelled queued message was never sent, so its optimistic line has
      // to go with it — otherwise it sits in the transcript as a message that
      // never reached the agent.
      if (item) dropLocalEcho(item.clientMessageId);
    },
    [scope, send, dropLocalEcho],
  );

  const forceSend = useCallback(
    async (itemId: string) => {
      if (!scope) return;
      const plan = planForceSend(queueRef.current, itemId);
      if (!plan) return;

      // Take the user items out of the queue FIRST: if the turn ended while we
      // waited, the pump would otherwise dequeue the target itself and the
      // resend below would run it a second time. Only then stop the turn, and
      // then resend with the target at the head. With the queue empty the
      // target either starts at once or sits at the head of a queue that is
      // still unwinding — upstream has no promote command, so this
      // remove-and-resend is the only way to run an item out of order.
      for (const id of plan.remove) {
        send({
          type: "remove_queue_item",
          runtime: scope,
          request_id: `force-${Date.now()}`,
          item_id: id,
        });
      }
      for (const item of plan.removed) dropLocalEcho(item.clientMessageId);
      if (processingRef.current) {
        expectResentTurnRef.current = true;
        await abort();
      }
      try {
        // Optimistic, like `sendMessage`: the queue was just emptied, so the
        // abort's `turn_finished` would otherwise drop the working indicator
        // until the resent turn's own start-of-turn status frame lands.
        setProcessing(true);
        setStopping(false);
        for (const next of plan.resend) sendContent(next.raw, next.content);
      } catch (cause) {
        expectResentTurnRef.current = false;
        setProcessing(false);
        setError(errorMessage(cause));
      }
    },
    [scope, send, abort, dropLocalEcho, sendContent],
  );

  const resumeQueue = useCallback(() => {
    if (!scope) return;
    send({
      type: "resume_queue",
      runtime: scope,
      request_id: `resume-${Date.now()}`,
    });
  }, [scope, send]);

  const stopMonitor = useCallback(
    (processId: string) => {
      if (!scope) return;
      send({
        type: "monitor_stop",
        runtime: scope,
        request_id: `monitor-stop-${Date.now()}`,
        process_id: processId,
      });
    },
    [scope, send],
  );

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (!scope) return;
      // Fire-and-forget: there is no change_device_state_response. The mode we
      // display comes back on the next update_device_status frame, so nothing
      // is set optimistically here — a rejected change would otherwise leave
      // the button showing a mode the server never adopted.
      send({
        type: "change_device_state",
        runtime: scope,
        payload: { mode },
      });
    },
    [scope, send],
  );

  const runCommand = useCallback(
    (commandId: string, args?: string) => {
      if (!scope) return;
      send({
        type: "execute_command",
        runtime: scope,
        request_id: `cmd-${Date.now()}`,
        command_id: commandId,
        ...(args ? { args } : {}),
      });
    },
    [scope, send],
  );

  return {
    entries,
    processing,
    stopping,
    cwd,
    queue,
    approvals,
    error,
    sendMessage,
    abort,
    respondToApproval,
    answerQuestions,
    removeQueued,
    forceSend,
    resumeQueue,
    runCommand,
    skillsVersion,
    permissionMode,
    setPermissionMode,
    commands,
    toolsetPreference,
    availableToolsets,
    backgroundProcesses,
    stopMonitor,
    turnUsage,
    turnStartedAt,
    lastActivityAt,
  };
}

/**
 * The usage the BFF holds for this conversation (`bff/src/session/turn-usage.ts`).
 * Undefined when it could not be read, so the gauge keeps what it shows.
 */
async function fetchTurnUsage(
  agentId: string,
  conversationId: string,
): Promise<TurnUsage | null | undefined> {
  try {
    const params = new URLSearchParams({ agent_id: agentId, conversation_id: conversationId });
    const response = await fetch(`/api/turn-usage?${params}`);
    if (!response.ok) return undefined;
    return pickTurnUsage(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Failed turns the BFF remembers for this conversation. Best effort: history
 * must still load when this cannot, so every failure is an empty list.
 */
async function fetchTurnErrors(
  agentId: string,
  conversationId: string,
): Promise<TurnErrorRecord[]> {
  try {
    const params = new URLSearchParams({ agent_id: agentId, conversation_id: conversationId });
    const response = await fetch(`/api/turn-errors?${params}`);
    if (!response.ok) return [];
    const body = (await response.json()) as { errors?: unknown };
    return Array.isArray(body.errors) ? (body.errors as TurnErrorRecord[]) : [];
  } catch {
    return [];
  }
}
