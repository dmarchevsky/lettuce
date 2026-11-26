import {
  type AskUserQuestionResponse,
  prepareAskUserQuestionNotif,
} from "@letta-ai/letta-code/ask-user-question";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMessageContent, type PreparedImage } from "../lib/attachments.ts";
import { historyShowsLoadingRow, openConversation } from "../lib/conversation-open.ts";
import { clearDelivery, deliveryCode, deliveryForCode, markDelivery } from "../lib/delivery.ts";
import { errorMessage, friendlyServerError } from "../lib/errors.ts";
import { consumeFreshConversation } from "../lib/fresh-conversations.ts";
import {
  appendOlderPage,
  fetchHistoryPage,
  HISTORY_MESSAGE_FLOOR,
  loadHistoryPages,
  olderPageStalled,
} from "../lib/history.ts";
import { upstreamReturned } from "../lib/link-status.ts";
import {
  indicatorStaysOn,
  QUEUE_HIDDEN,
  QUEUE_REVEAL_GRACE_MS,
  queueRevealDecision,
  queueShownIsStale,
  seamAllowsFlip,
  stallProbeDue,
} from "../lib/live-state.ts";
import {
  addLocalUserMessage,
  applyStreamDelta,
  clearLocalNotice,
  createStreamIndex,
  mergeStreamIntoHistory,
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
import {
  MONITOR_SOURCES,
  type MonitorSource,
  readStartedAtMs,
  readWatchTarget,
  type WatchTarget,
} from "../lib/pr-watch.ts";
import { frameSeq, type RuntimeScope, type SequencedFrame, scopeKey } from "../lib/protocol.ts";
import { planForceSend, type QueuedItem, readQueue } from "../lib/queue-actions.ts";
import { type ResponseFormat, validateResponseFormat } from "../lib/structured-output.ts";
import type { LiveSubagent, WorkflowCounts } from "../lib/subagents.ts";
import { readLiveSubagents, readWorkflowProgress } from "../lib/subagents.ts";
import { pickTurnUsage, type TurnUsage } from "../lib/usage.ts";
import { STALL_AFTER_MS } from "../lib/working.ts";
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

/** What an unresolved send would re-send, kept beside the id that makes the re-send safe. */
interface Resendable {
  raw: unknown;
  responseFormat?: ResponseFormat | null;
}

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

/** `MonitorBackgroundProcessSummary["source"]` — the four sources that run locally. */
export type { MonitorSource } from "../lib/pr-watch.ts";

export interface BackgroundProcessSummary {
  processId: string;
  /** `workflow` is a native wire kind since letta-code 0.33 (`WorkflowBackgroundProcessSummary`). */
  kind: "bash" | "agent_task" | "monitor" | "workflow";
  label: string;
  status: string;
  /** An agent_task's own id, which keys the live subagent snapshot list. */
  subagentId?: string;
  /** A workflow's phase counts, parsed off the device-status `progress` field. */
  workflow?: WorkflowCounts;
  /** A monitor's upstream source: `github_pull_request` is a `WatchPR`. */
  monitorSource?: MonitorSource;
  /** When a monitor started, for the row's "watching since" (`started_at_ms`). */
  startedAtMs?: number;
  /** A `WatchPR`'s rebuilt GitHub destination; absent for every other row. */
  watch?: WatchTarget;
  /**
   * Whether this row has a stop that works from the browser: a running monitor
   * (`monitor_stop`) or a subagent the app-server still owns (`subagent_stop`).
   * `task_stop` is an agent tool and not a client command, so a shell job stays false.
   */
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
  /** `queue` debounced by the reveal grace — render the queue strip from this,
   * never from `queue`, or an idle send's transient snapshot flashes a strip. */
  queueShown: QueuedItem[];
  approvals: PendingApproval[];
  error: string | null;
  /** History for the open conversation is in flight: the empty transcript must
   * say "Loading conversation…", not "No messages yet" (`MessageList`). */
  historyLoading: boolean;
  /**
   * The transcript holds only the newest messages: the floor stopped the read with
   * older ones still to fetch. Rendered as the wall row, so a partial transcript
   * never looks like a complete one.
   */
  historyPartial: boolean;
  /**
   * Older messages exist but the cursor stopped answering, so the wall says the older
   * end could not be loaded instead of offering a button that cannot deliver.
   */
  historyStalled: boolean;
  /** An older page is on its way. */
  historyLoadingOlder: boolean;
  /** How many messages were fetched, which is not how many rows there are. */
  historyLoaded: number;
  /** Bumped once per older page landed; the list anchors the scroll on this. */
  olderPages: number;
  /** Fetch the next page of older messages and put it above what is on screen. */
  loadOlder: () => void;
  /** Dismiss `error` — it is shown in a box the operator closes once read. */
  clearError: () => void;
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
  /**
   * Send an undelivered message again — the note under its bubble's only action.
   *
   * Re-sends under the **same** `client_message_id`, which is what makes it safe: the app-server de-dupes
   * an input on that id, so a message that did land is ignored rather than run twice. No-op once the
   * echo is gone (a reload clears both). See `web/src/lib/delivery.ts`.
   */
  resendMessage: (clientMessageId: string) => void;
  /** Resolves true when upstream confirmed a live turn was cancelled. */
  abort: () => Promise<boolean>;
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
  /** `subagent_id -> live snapshot` for this scope; the source of live child progress. */
  liveSubagents: Record<string, LiveSubagent>;
  /**
   * Stops a persistent monitor. No-op for bash, agent_task and workflow
   * processes — `stopMonitor` upstream refuses anything whose
   * `process.kind !== "monitor"` with "Monitor not found", which is why a subagent row stops
   * through `stopSubagent` instead.
   */
  stopMonitor: (processId: string) => void;
  /**
   * Stop a running background subagent (letta-code 0.34.16's `subagent_stop`). Resolves to the
   * error to show the operator, or null when it stopped; the row itself goes when the app-server
   * next reports this scope's processes.
   */
  stopSubagent: (subagentId: string) => Promise<string | null>;
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
  /**
   * True while the app-server's last loop status for this turn was
   * `PROCESSING_API_RESPONSE` — the model call is in flight, so silence has a
   * witness and the working line waits instead of warning. False is the
   * conservative default (no frames seen, or the loop says otherwise).
   */
  modelCallActive: boolean;
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

/**
 * The two fields a monitor carries that the parser used to drop: `source` is what
 * tells a PR watch from a `tail -f`, and `started_at_ms` how long it has been
 * watching (upstream's local watch has no duration cap, so nothing here shows an
 * expiry). A `WatchPR` also gets its rebuilt GitHub link, which needs the label.
 *
 * Upstream snapshots only *running* monitors and keeps no readable record of a
 * finished one in local mode, so there is no terminal-state row to render: what a
 * watch decided arrives in the conversation as a notice.
 */
function readMonitorFields(
  entry: { source?: unknown; started_at_ms?: unknown },
  description: string,
): Pick<BackgroundProcessSummary, "monitorSource" | "startedAtMs" | "watch"> {
  const source = entry.source;
  const monitorSource =
    typeof source === "string" && (MONITOR_SOURCES as readonly string[]).includes(source)
      ? (source as MonitorSource)
      : undefined;
  const startedAtMs = readStartedAtMs(entry.started_at_ms);
  return {
    ...(monitorSource ? { monitorSource } : {}),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(monitorSource === "github_pull_request"
      ? { watch: readWatchTarget(description) ?? undefined }
      : {}),
  };
}

export function readBackgroundProcesses(
  raw: unknown,
  liveSubagents: Record<string, LiveSubagent> = {},
): BackgroundProcessSummary[] {
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
      subagent_id?: unknown;
      progress?: unknown;
      source?: unknown;
      started_at_ms?: unknown;
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
    const subagentId = typeof entry.subagent_id === "string" ? entry.subagent_id : undefined;
    const workflow = kind === "workflow" ? readWorkflowProgress(entry.progress) : null;
    const monitor = kind === "monitor" ? readMonitorFields(entry, label) : {};
    return [
      {
        processId: entry.process_id,
        kind,
        label,
        status,
        subagentId,
        ...(workflow ? { workflow } : {}),
        ...monitor,
        // A subagent row is stoppable only while the snapshot list still names its child agent.
        // After an app-server restart nothing does, and the row simply has no Stop.
        stoppable:
          kind === "monitor"
            ? status === "running"
            : kind === "agent_task" && !!subagentId && !!liveSubagents[subagentId]?.agentId,
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

/**
 * Agents whose workspace this page load has seeded with `.keep`.
 *
 * `runtime_start` refuses a directory that does not exist and there is no mkdir
 * command, so a marker file is how the directory gets created (`write_file` does
 * `mkdir -p` on the parent). One agent has one directory, so one write per agent
 * per load is the whole job — writing it per conversation had a plain conversation
 * switch costing a file write, and a browsing session doing writes.
 */
const seededWorkspaces = new Set<string>();

export function useConversation(
  session: SessionApi,
  agentId: string | null,
  conversationId: string | null,
): ConversationApi {
  // Individually stable; depending on the whole session object would re-fire
  // these effects on every link-state change.
  const { request, send, setScopes, onFrame, onResync, ready, markResynced } = session;

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  /**
   * The queue as rendered: `queue` debounced by the reveal grace, so the
   * transient snapshot of a send that drained straight from the queue never
   * paints a strip (`queueRevealDecision`). The strip and the working line's
   * queue metric render from this; the queue verbs and the indicator seam
   * read `queue`.
   */
  const [queueShown, setQueueShown] = useState<QueuedItem[]>([]);
  /** When the raw queue went non-empty, for the reveal grace. */
  const queueSinceRef = useRef<number | null>(null);
  /** Mirror of `queue` for callbacks that must read the live snapshot. */
  const queueRef = useRef<QueuedItem[]>([]);
  /** Ids exempt from the queue's echo erase (the `update_queue` case): a
   * question answer's answered-card state renders from its echo, so that
   * echo survives waiting in the queue. */
  const keepEchoRef = useRef(new Set<string>());
  /**
   * What each unresolved send would re-send, keyed by the `client_message_id` it went out under.
   *
   * A resend has to reuse that id — it is what the app-server de-dupes on — so the payload must outlive
   * the request it was made for. Entries leave when the request settles with a verdict of its own: an
   * ack means there is nothing to resend, a verdictless failure (a timeout, a socket that was never open)
   * leaves no note on screen and therefore nothing that could offer one.
   */
  const resendableRef = useRef(new Map<string, Resendable>());
  /** Mirror of `processing`, so `forceSend` can decide whether to abort. */
  const processingRef = useRef(false);
  /**
   * Mirror of `ready`, for a verdict that arrives after the send that asked for it. A rejection's closure
   * holds the `ready` from the render that sent the message, which is the wrong moment: the link dropping
   * on the way back — phone backgrounding, the routine case — would read as a live link.
   */
  const readyRef = useRef(ready);
  readyRef.current = ready;
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
  const [historyLoading, setHistoryLoading] = useState(false);
  /**
   * Older messages exist and were not loaded — the floor stopped the read.
   * Rendered as the wall at the top of the transcript, never as silence.
   */
  const [historyPartial, setHistoryPartial] = useState(false);
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false);
  /**
   * Older messages exist but the cursor stops answering, so the wall has no button
   * to offer — it says the older end did not answer instead.
   */
  const [historyStalled, setHistoryStalled] = useState(false);
  /** How many messages the transcript was built from; what the wall counts. */
  const [historyLoaded, setHistoryLoaded] = useState(0);
  /** Bumped once per older page landed; what the list anchors the scroll on. */
  const [olderPages, setOlderPages] = useState(0);
  const [cwd, setCwd] = useState<string | null>(null);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const [permissionMode, setPermissionModeFromStatus] = useState<PermissionMode | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [toolsetPreference, setToolsetPreferenceFromStatus] = useState<string | null>(null);
  const [availableToolsets, setAvailableToolsets] = useState<ToolsetSummary[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<unknown[]>([]);
  /**
   * `subagent_id -> live snapshot` for this scope, off `update_subagent_state`.
   * A subagent row is only stoppable while its snapshot carries an agent id, and these
   * snapshots are what the working line and the Tasks rows show live child progress from.
   */
  const [liveSubagents, setLiveSubagents] = useState<Record<string, LiveSubagent>>({});
  const backgroundProcesses = useMemo(
    () => readBackgroundProcesses(runningProcesses, liveSubagents),
    [runningProcesses, liveSubagents],
  );
  const [turnUsage, setTurnUsage] = useState<TurnUsage | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [modelCallActive, setModelCallActive] = useState(false);
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
  /** The open conversation's last history load failed — see the recovery effect. */
  const lastLoadFailedRef = useRef(false);
  /** Bumped per start; a superseded async load checks it before writing (see `loadHistory`). */
  const loadGenRef = useRef(0);
  /** Bumped to re-run the start effect on app-server recovery (`startedRef` reset). */
  const [startNonce, setStartNonce] = useState(0);

  // Memoized so its identity changes only with the conversation: effects and
  // callbacks depend on this object, and a fresh literal every render made them
  // re-run every render — the request loop this hook has burned itself on
  // before. The field-wise deps that used to work around it are gone.
  const scope = useMemo(
    () =>
      agentId && conversationId
        ? ({ agent_id: agentId, conversation_id: conversationId } as RuntimeScope)
        : null,
    [agentId, conversationId],
  );

  // `cwd` is what a live runtime last reported for *this* conversation, so with no
  // conversation there is nothing for it to describe — and the stale value outlives
  // an agent switch, which is how Files went on showing the previous agent's
  // workspace after the rail changed agents.
  useEffect(() => {
    if (!scope) setCwd(null);
  }, [scope]);

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

  /**
   * Ask the app-server to re-emit this conversation's live state.
   *
   * An observer `sync` (never the owner's `resume_interrupted_turn` — the BFF
   * owns recovery) with `force_device_status` makes the app-server re-emit
   * device status and queue on the BFF's connection; the frame router fans
   * them out here, and the normal status handlers re-prime everything the
   * client keeps live-only: `processing`, the queue, the status pill. The
   * client's `processing` is optimistic from the send — a client bug or a lost
   * frame can strand it true on a finished conversation — and this is the
   * cheap way back to the app-server's truth, which holds turn state anyway.
   */
  const reprimeLiveState = useCallback(() => {
    if (!agentId || !conversationId) return;
    void request("sync", {
      runtime: { agent_id: agentId, conversation_id: conversationId },
      force_device_status: true,
    }).catch(() => {
      // A dead socket rejects; the reconnect resyncs and reprimes anyway.
    });
  }, [agentId, conversationId, request]);

  /**
   * The stall watchdog's once-per-turn flag: the reconciliation probe fires
   * again only after `processing` has been false since the last one.
   */
  const stallProbedRef = useRef(false);

  /**
   * Belt over every stranding path, known or not.
   *
   * The stall warning is client inference — "we claim a turn, and this client
   * has heard nothing for a minute". Every bug that ever strands `processing`
   * true ends up painting that warning over a finished conversation. So when
   * it is about to light, ask the app-server once (per turn, per episode) to
   * re-emit what it believes: a client-side stranding self-heals seconds
   * after the warning would appear, while a genuinely hung turn is reported
   * truthfully and keeps the warning — the probe answers "is it hung?" with
   * the only opinion that can say.
   */
  useEffect(() => {
    if (!processing) {
      stallProbedRef.current = false;
      return;
    }
    const timer = setInterval(() => {
      if (
        !stallProbeDue({
          probed: stallProbedRef.current,
          stopping,
          lastActivityAt: lastActivityRef.current,
          now: Date.now(),
          stallAfterMs: STALL_AFTER_MS,
        })
      )
        return;
      stallProbedRef.current = true;
      reprimeLiveState();
    }, 5_000);
    return () => clearInterval(timer);
  }, [processing, stopping, reprimeLiveState]);

  /** Every history record held for this conversation, newest-first. */
  const historyRecordsRef = useRef<unknown[]>([]);
  /** Where the older pages continue from, and whether the endpoint says more exist. */
  const historyCursorRef = useRef<{ nextBefore: string | null; hasMore: boolean }>({
    nextBefore: null,
    hasMore: false,
  });
  /** One older-page request at a time; a second click while one is in flight is noise. */
  const olderBusyRef = useRef(false);

  /**
   * Rebuild the transcript from history records, folding in whatever is live.
   *
   * Shared by the cold load and by an older page landing, because both replace the
   * transcript wholesale and both must keep the live entries that arrived while the
   * request was in flight: the history is a snapshot taken before those frames, so
   * its copy of a message wins and the ones it never saw are kept. The stream index
   * is rebuilt after the fold so a later chunk of a still-streaming entry keeps its
   * keys — an alias whose entry history replaced must not keep pointing at the
   * discarded key, and history's own entries need no seeding, their keys are ids.
   */
  const commitHistory = useCallback(
    (messages: readonly unknown[], errors: readonly TurnErrorRecord[]) => {
      const history = transcriptFromHistory(messages);
      mergeStreamIntoHistory(history, transcriptRef.current);
      mergeTurnErrors(history, errors);
      transcriptRef.current = history;
      const survived = (key: string) => history.has(key);
      const index = createStreamIndex();
      for (const [alias, key] of streamIndexRef.current.byMessageId) {
        if (survived(key)) index.byMessageId.set(alias, key);
      }
      for (const [alias, key] of streamIndexRef.current.byOtid) {
        if (survived(key)) index.byOtid.set(alias, key);
      }
      streamIndexRef.current = index;
      // History numbers its entries from 0 and the live ones were lifted above them
      // by `mergeStreamIntoHistory`, so the next live entry must be numbered above
      // everything now on screen — and the counter may already sit higher from a
      // connection sequence number, which a rebuild must never pull back down.
      let top = messages.length;
      for (const entry of history.values()) top = Math.max(top, entry.seenAt + 1);
      seqRef.current = Math.max(seqRef.current, Math.ceil(top));
      flushSync();
    },
    [flushSync],
  );

  const loadHistory = useCallback(
    async (afterResync = false, gen?: number) => {
      if (!conversationId) return;
      // A superseded load (the user switched conversations mid-flight) must
      // not land its result on the new conversation's transcript, error,
      // loading flag, or failure record — the flag in particular would read
      // "No messages yet" over a conversation still actually loading. `gen`
      // comes from the start effect; resync reloads pass none (their own
      // closure is already current).
      const current = () => gen === undefined || gen === loadGenRef.current;
      setError(null);
      // In parallel with the history request; see `mergeTurnErrors`. It is optional
      // data — a failure to read the BFF's error log must not cost the reader their
      // wall, so it answers with nothing rather than rejecting into the catch below.
      const turnErrors = agentId
        ? fetchTurnErrors(agentId, conversationId).catch(() => [] as TurnErrorRecord[])
        : Promise.resolve([] as TurnErrorRecord[]);
      refreshUsage();
      try {
        // Read back to the floor instead of accepting one page: one page of a long
        // conversation silently loses its beginning, with nothing on screen to tell
        // the reader the transcript is partial (#148). The newest page is committed
        // on its own so the transcript is not blank through every round trip; the
        // rest land together, because every commit re-renders the whole list and a
        // page at a time would render messages nobody has scrolled for yet.
        let painted = false;
        const loaded = await loadHistoryPages(request, conversationId, {
          floor: HISTORY_MESSAGE_FLOOR,
          onPage: (messages) => {
            // Only paint early when nothing is on screen. A resync reload replacing a
            // full transcript with the newest page would shrink it for a second and
            // leave the wall counting a thousand messages over two hundred rows.
            if (painted || !current() || transcriptRef.current.size > 0) return;
            painted = true;
            setHistoryLoaded(messages.length);
            commitHistory(messages, []);
          },
        });
        if (!current()) return;
        historyRecordsRef.current = loaded.messages;
        historyCursorRef.current = { nextBefore: loaded.nextBefore, hasMore: loaded.hasMore };
        setHistoryPartial(loaded.partial);
        setHistoryStalled(loaded.stalled);
        setHistoryLoaded(loaded.messages.length);
        const errors = await turnErrors;
        if (!current()) return;
        // The pile is what the rows must match, and it may have grown while the turn
        // errors were in flight: a resync reload happens with the wall on screen, so
        // an older page can land in this window. Committing this load's own pile then
        // would drop the page the reader just asked for.
        setHistoryLoaded(historyRecordsRef.current.length);
        commitHistory(historyRecordsRef.current, errors);
        // A request/response frame like this one never carries the sequence
        // number that would otherwise flip the link back to "live" on its
        // own — see session-client.ts's markResynced. Only relevant when this
        // reload was resync-triggered; an ordinary load has nothing to un-stick.
        if (afterResync) {
          markResynced();
          // The reload fixed the transcript; it cannot fix turn state.
          // `processing` is optimistic from the send, and every frame that
          // would have corrected it died in the gap this resync is the answer
          // to: a phone that slept through a turn's completion wakes to a
          // finished answer still shown as working, and the stall line lights
          // on a conversation that ended minutes ago.
          setStopping(false);
          reprimeLiveState();
        }
        lastLoadFailedRef.current = false;
      } catch (cause) {
        if (!current()) return;
        lastLoadFailedRef.current = true;
        setError(friendlyServerError(errorMessage(cause)));
      }
    },
    [agentId, conversationId, request, commitHistory, markResynced, refreshUsage, reprimeLiveState],
  );

  /**
   * Fetch one page of older messages and put it above what is on screen.
   *
   * This is what makes the floor an honest limit rather than a truncation: the
   * messages beyond it stay reachable. An older page rebuilds the whole transcript
   * (cheap, and it is one deliberate click), which is also what keeps the ordering
   * rule in one place — the older records join the pile and are sorted with it.
   */
  const loadOlder = useCallback(async () => {
    if (!conversationId || olderBusyRef.current) return;
    const { nextBefore } = historyCursorRef.current;
    if (!nextBefore) return;
    // The same supersession rule the cold load obeys: the reader may have switched
    // conversations while this page was on its way, and its records belong to the
    // conversation they were fetched for, not the one now on screen. The busy flag
    // is cleared on the generation alone — by the time the page lands this call has
    // itself replaced the pile, so the pile identity cannot answer that question.
    const gen = loadGenRef.current;
    const pile = historyRecordsRef.current;
    const superseded = () => gen !== loadGenRef.current || historyRecordsRef.current !== pile;
    olderBusyRef.current = true;
    setHistoryLoadingOlder(true);
    try {
      const page = await fetchHistoryPage(request, conversationId, nextBefore);
      if (superseded()) return;
      const merged = appendOlderPage(pile, page.messages);
      const errors = agentId
        ? await fetchTurnErrors(agentId, conversationId).catch(() => [] as TurnErrorRecord[])
        : [];
      if (superseded()) return;
      historyRecordsRef.current = merged.messages;
      historyCursorRef.current = { nextBefore: page.nextBefore, hasMore: page.hasMore };
      // A page that adds nothing while the endpoint still claims there is more is a
      // dead cursor, not the beginning: keep saying the transcript is partial, and
      // say plainly that the older end will not answer, rather than offering a
      // button that fetches the same page again forever.
      setHistoryPartial(page.hasMore && page.nextBefore !== null);
      setHistoryStalled(olderPageStalled(page, merged.added));
      setHistoryLoaded(merged.messages.length);
      // The counter and the rows must land in the same render, and the counter
      // first: it is what tells the list to hold the reader's scroll position, and
      // a render of the new rows without it would jump them before it arrived.
      setOlderPages((n) => n + 1);
      commitHistory(merged.messages, errors);
    } catch (cause) {
      if (superseded()) return;
      setError(friendlyServerError(errorMessage(cause)));
    } finally {
      if (gen === loadGenRef.current) {
        olderBusyRef.current = false;
        setHistoryLoadingOlder(false);
      }
    }
  }, [agentId, conversationId, request, commitHistory]);

  // Start (or resume) the runtime for this conversation, then load its history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: startNonce is the trigger itself — the recovery effect below bumps it to re-run this effect after resetting `startedRef`.
  useEffect(() => {
    if (!ready || !scope) return;
    const key = scopeKey(scope);
    if (startedRef.current === key) return;
    startedRef.current = key;
    const gen = ++loadGenRef.current;
    // An empty transcript from here until the history lands must read as
    // loading, not empty — unless this conversation was just created here, in
    // which case empty is exactly what it is and the row would only be a blink
    // over the truth. See `historyShowsLoadingRow`.
    // Whether the row shows at all; the load itself runs either way.
    const freshConversation = consumeFreshConversation(scope.conversation_id);
    setHistoryLoading(historyShowsLoadingRow(freshConversation));

    transcriptRef.current = new Map();
    streamIndexRef.current = createStreamIndex();
    seqRef.current = 0;
    historyRecordsRef.current = [];
    historyCursorRef.current = { nextBefore: null, hasMore: false };
    olderBusyRef.current = false;
    setHistoryPartial(false);
    setHistoryStalled(false);
    setHistoryLoadingOlder(false);
    setHistoryLoaded(0);
    setOlderPages(0);
    lastActivityRef.current = null;
    setEntries([]);
    setTurnStartedAt(null);
    setModelCallActive(false);
    setQueue([]);
    setQueueShown([]);
    queueRef.current = [];
    queueSinceRef.current = null;
    expectResentTurnRef.current = false;
    setApprovals([]);
    setStopping(false);
    usageScopeRef.current = scope;
    setTurnUsage(null);
    setLastActivityAt(null);

    setScopes([scope]);
    const startRuntime = async (): Promise<void> => {
      const home = agentWorkspace(scope.agent_id);
      try {
        // Seed the workspace once per agent per load — see `seededWorkspaces`.
        // Best effort: a failure here should not block the turn.
        if (!seededWorkspaces.has(scope.agent_id)) {
          // A refused write is not a reason to skip the runtime: `cwd` may already
          // exist, and this only ever tries to make it exist.
          const seeded = await request("write_file", {
            path: `${home}/.keep`,
            content: "",
          })
            .then(() => true)
            .catch(() => false);
          if (seeded) seededWorkspaces.add(scope.agent_id);
        }

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
        if (started?.success === false && gen === loadGenRef.current) {
          setError(started.error ?? "Failed to start the runtime");
        }
      } catch (cause) {
        if (gen === loadGenRef.current) setError(friendlyServerError(errorMessage(cause)));
      }
    };
    // The history first and the slow start beside it — see `conversation-open.ts`.
    // Every open loads its history, a freshly created conversation included:
    // it is the fold of live frames that needs the load, not the messages, and
    // skipping the load would drop a turn that started mid-open.
    void openConversation({
      loadHistory: (onSettled) => void loadHistory(false, gen).then(onSettled, onSettled),
      startRuntime,
      endLoadingRow: () => {
        if (gen === loadGenRef.current) setHistoryLoading(false);
      },
    });
  }, [ready, scope, startNonce, request, setScopes, loadHistory]);

  // A resync means the BFF buffer could not cover the gap while we were away.
  useEffect(() => onResync(() => void loadHistory(true)), [onResync, loadHistory]);

  // The app-server came back while this conversation sat on a failed load
  // ("App-server is not connected" with nothing retrying it — the BFF socket
  // never dropped). Restart the runtime the restart killed and reload, which
  // clears the error by succeeding. Only a conversation that actually failed
  // heals, so a healthy boot with both axes flipping is untouched.
  const upstreamRef = useRef(session.upstream);
  useEffect(() => {
    const previous = upstreamRef.current;
    upstreamRef.current = session.upstream;
    if (!upstreamReturned(previous, session.upstream)) return;
    if (!startedRef.current || !lastLoadFailedRef.current) return;
    startedRef.current = null;
    setStartNonce((n) => n + 1);
  }, [session.upstream]);

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
          // The turn's witness dies with it: the next model call must re-earn
          // "Waiting for model" from a fresh loop-status frame.
          setModelCallActive(false);
          // An approval the turn never got an answer to dies with it: upstream
          // rejects its pending approval resolvers as the turn is cancelled, so
          // answering it now would send a response for a request that no longer
          // exists — and the sheet is undismissable, so a leftover is a dead
          // modal over a finished turn. Goes on both sides of the force-send
          // seam below: the replacement turn raises its own approvals afresh.
          setApprovals([]);
          if (expectResentTurnRef.current) {
            // The seam between an aborted turn and its force-sent replacement:
            // processing continues into the resent turn.
            expectResentTurnRef.current = false;
          } else {
            setProcessing(indicatorStaysOn(queueRef.current));
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
          // The seam of a force-send: only a frame that says busy may move it.
          if (seamAllowsFlip(expectResentTurnRef.current, status?.is_processing === true)) {
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
            setRunningProcesses(status.background_processes);
          }
          break;
        }
        case "update_subagent_state": {
          // Whole list on every change, so a missed frame cannot leave a Stop button behind.
          setLiveSubagents(readLiveSubagents((frame as { subagents?: unknown }).subagents));
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
          // The working line's patience is earned here: while the loop says the
          // model call is running, silence is prefill, not a stall — see
          // `modelCallActive` in `lib/working.ts`.
          setModelCallActive(loopStatus === "PROCESSING_API_RESPONSE");
          // Same force-send seam as in the device-status case above.
          if (seamAllowsFlip(expectResentTurnRef.current, loopBusy)) setProcessing(loopBusy);
          break;
        }
        case "update_queue": {
          const items = readQueue((frame as { queue?: unknown }).queue);
          queueRef.current = items;
          setQueue(items);
          // The snapshot does NOT erase the message's local echo: a mid-turn
          // send would then live nowhere for the strip's reveal grace. The
          // echo retires when the strip reveals it — see the reveal effect.
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
  }, [onFrame, scope, flush, flushSync, refreshUsage]);

  /**
   * Put one user message on the wire under `clientMessageId` and watch the answer.
   *
   * Split out of `sendContent` because a resend must reuse the id: the listener de-dupes an input on
   * `client_message_id`, so re-sending the same message is safe and sending it under a fresh id is the
   * double-send. Carrying a `request_id` is what makes the send answerable at all — the BFF settles it
   * with the app-server's `input_accepted`, or, when its own upstream socket died first, with a delivery
   * code (`bff/src/session/inflight.ts`). Not awaited: the echo is already on screen and a slow app-server
   * must not hold up the next keystroke.
   */
  const deliverInput = useCallback(
    (clientMessageId: string, raw: unknown, responseFormat?: ResponseFormat | null) => {
      if (!scope) return;
      void request("input", {
        runtime: scope,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: raw, client_message_id: clientMessageId }],
          ...(responseFormat ? { response_format: responseFormat } : {}),
        },
      }).then(
        // The answer came back. An `input_accepted` can say *no* — a scope switching computers, a ledger at
        // capacity, an input the listener refuses — and that is a verdict that nothing ran, not delivery:
        // the message is marked undelivered with the app-server's reason, and its payload stays so the note
        // can offer the resend. Any other answer means the input was taken, so a note still on the bubble
        // was wrong and goes, and with it the payload there is nothing left to resend.
        (frame) => {
          const ack = frame as { type?: unknown; accepted?: unknown; error?: unknown };
          if (ack?.type === "input_accepted" && ack.accepted === false) {
            setError(
              typeof ack.error === "string" && ack.error
                ? ack.error
                : "The app-server refused that message.",
            );
            if (markDelivery(transcriptRef.current, clientMessageId, "refused")) flushSync();
            // Nothing is running because of a refusal, so the optimistic "working" state goes back the way
            // it came. The delivery-code path cannot do this — there a verdict of "unknown" says nothing
            // about whether something is still working.
            setProcessing(false);
            return;
          }
          resendableRef.current.delete(clientMessageId);
          if (clearDelivery(transcriptRef.current, clientMessageId)) flushSync();
        },
        (cause: unknown) => {
          const code = deliveryCode(cause);
          if (!code) {
            // No code, no verdict — so nothing is marked, and the payload goes with the verdict: there is
            // no note that could offer a resend.
            resendableRef.current.delete(clientMessageId);
            setError(errorMessage(cause));
            // The optimistic "working" state is only unwound when the tab's own link is down, because that
            // is the one case that proves no turn can be running. A codeless failure with a live link is a
            // silence, and something may well be working — frames, not this promise, decide that.
            if (!readyRef.current) setProcessing(false);
            return;
          }
          if (markDelivery(transcriptRef.current, clientMessageId, deliveryForCode(code)))
            flushSync();
          else resendableRef.current.delete(clientMessageId);
        },
      );
    },
    [scope, request, flushSync],
  );

  /**
   * One user message out the door, with its local echo. `raw` is the content
   * as the protocol wants it (string or content parts); `display` is what the
   * echo shows; `images` are what the echo renders beside the text (the wire
   * already carries them inside `raw`). Returns the fresh `client_message_id` —
   * a message must never be resent under an id the listener already
   * acknowledged, which is exactly what `resendMessage` does and why it reuses
   * this one.
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
      // entry rather than duplicating it. A send that turns out to be queued
      // loses this echo again when the `update_queue` snapshot carries the
      // item — see `keepEchoRef` — so the chip is the queued message's only
      // place on screen.
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

      resendableRef.current.set(clientMessageId, { raw, responseFormat });
      deliverInput(clientMessageId, raw, responseFormat);
      return clientMessageId;
    },
    [scope, deliverInput, flushSync],
  );

  /**
   * Send an undelivered message again, under the id it already went out under.
   *
   * Safe by construction: the app-server de-dupes an input on `client_message_id`, so this is ignored if
   * the first attempt landed and delivered if it did not. The existing echo stays — one message, one
   * bubble — and the note is cleared now rather than when the answer arrives, so the press reads as
   * taking effect.
   */
  const resendMessage = useCallback(
    (clientMessageId: string) => {
      // A rendered user row is not always the entry itself: `splitInjectedBlocks` suffixes the id of a
      // message it breaks into cards, so the note's click arrives with `:block:<n>` on the end. The
      // client_message_id never contains that, so stripping it is exact, and one click clears every row
      // the message was split into.
      const id = clientMessageId.split(":block:")[0] as string;
      const resendable = resendableRef.current.get(id);
      // No payload means the send is settled or forgotten; no entry means the echo is gone (a reload, a
      // force-send), and there is nothing on screen left to mark.
      if (!resendable || !transcriptRef.current.has(id)) return;
      clearDelivery(transcriptRef.current, id);
      flushSync();
      deliverInput(id, resendable.raw, resendable.responseFormat);
    },
    [deliverInput, flushSync],
  );

  const sendMessage = useCallback(
    async (
      text: string,
      responseFormat?: ResponseFormat | null,
      images?: PreparedImage[],
      /** A send whose echo must survive the queue — a question answer, whose
       * answered card state `splitInjectedBlocks` renders from the echo. The
       * card must flip the moment you answer, not when the queue drains. */
      opts?: { keepLocalEcho?: boolean },
    ) => {
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
        const clientMessageId = sendContent(raw, text, responseFormat, images);
        if (opts?.keepLocalEcho) keepEchoRef.current.add(clientMessageId);
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
      if (!entry?.local) return;
      transcriptRef.current.delete(clientMessageId);
      streamIndexRef.current.byOtid.delete(clientMessageId);
      flushSync();
    },
    [flushSync],
  );

  // The reveal grace: the raw snapshot decides when the strip's clock starts
  // and stops, the pure decision says when it may show (`live-state.ts`).
  // Revealing is also when a queued message's local echo retires — the chip
  // takes its place in the same paint, so a mid-turn send lives in exactly
  // one place at every moment. The timer counts the *remaining* grace, so a
  // burst of snapshots cannot push the reveal later than the constant.
  useEffect(() => {
    const act = queueRevealDecision(
      queue,
      queueShown.length > 0,
      queueSinceRef.current,
      performance.now(),
    );
    if (queue.length === 0) {
      queueSinceRef.current = null;
      if (queueShown.length > 0) setQueueShown(QUEUE_HIDDEN as never);
      return;
    }
    queueSinceRef.current ??= performance.now();
    if (act === "show" || (act === "keep" && queueShownIsStale(queue, queueShown))) {
      if (act === "show") {
        // The chip becomes the message's place on screen now (question
        // answers keep their echo — `keepEchoRef`).
        for (const item of queue) {
          if (
            item.source === "user" &&
            item.clientMessageId &&
            !keepEchoRef.current.has(item.clientMessageId)
          ) {
            dropLocalEcho(item.clientMessageId);
          }
        }
      }
      setQueueShown(queue);
      return;
    }
    if (act === "arm") {
      const remaining = QUEUE_REVEAL_GRACE_MS - (performance.now() - queueSinceRef.current);
      const timer = setTimeout(() => setQueueShown(queue), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }
  }, [queue, queueShown, dropLocalEcho]);

  const abort = useCallback(async (): Promise<boolean> => {
    if (!scope) return false;

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
        return false;
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
        return false;
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
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [scope, request, flushSync]);

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
      // A question answer is just a message: same send path, same queueing —
      // but its echo stays even when the answer waits in the queue, because
      // `splitInjectedBlocks` renders the answered state of the card from
      // the echo. The card must flip the moment you answer, not when the
      // queue drains.
      void sendMessage(prepareAskUserQuestionNotif(response), null, undefined, {
        keepLocalEcho: true,
      });
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
        const stopped = await abort();
        // The steer race: the turn can end between our `processing` check and
        // the abort landing — upstream answers "nothing was aborted" and its
        // `turn_finished` has usually been delivered already, so nothing left
        // will ever consume the seam. A live seam then swallows the RESENT
        // turn's `turn_finished`, ignores every idle status beside it, and
        // strands `processing` true on a completed conversation — the only
        // sign being the amber stall line a minute later. Arm the seam only
        // for an abort that actually cancelled something: an accepted abort is
        // upstream's promise that a `turn_finished` is coming for it.
        if (!stopped) expectResentTurnRef.current = false;
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

  const stopSubagent = useCallback(
    async (subagentId: string): Promise<string | null> => {
      const childAgentId = liveSubagents[subagentId]?.agentId;
      if (!scope || !childAgentId) return "That subagent is not running in this conversation.";
      try {
        const response = await request<{ stopped?: boolean; error?: string | null }>(
          "subagent_stop",
          { runtime: scope, agent_id: childAgentId },
        );
        // Nothing to clear locally: the app-server re-sends this scope's snapshots and processes
        // once the child is gone, and that is what takes the Stop button away.
        return response.stopped ? null : (response.error ?? "The subagent is still running.");
      } catch (cause) {
        return errorMessage(cause);
      }
    },
    [liveSubagents, request, scope],
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
    queueShown,
    approvals,
    error,
    historyLoading,
    historyPartial,
    historyLoadingOlder,
    historyStalled,
    historyLoaded,
    olderPages,
    loadOlder,
    /** The box shows an action that failed; the operator closes it once read. */
    clearError: () => setError(null),
    sendMessage,
    resendMessage,
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
    liveSubagents,
    stopMonitor,
    stopSubagent,
    turnUsage,
    turnStartedAt,
    lastActivityAt,
    modelCallActive,
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
