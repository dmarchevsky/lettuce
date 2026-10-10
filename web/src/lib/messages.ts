import {
  type AskUserQuestionReceipt,
  type AskUserQuestionResponse,
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
} from "@letta-ai/letta-code/ask-user-question";

/**
 * Normalizes Letta messages — whether streamed as deltas or loaded as history —
 * into a flat transcript the UI can render.
 *
 * Streaming sends many partial frames per message: assistant text, reasoning,
 * and tool-call arguments all arrive in fragments. Those fragments are grouped
 * by a canonical key resolved from `otid` and `id` (see StreamIndex — `id`
 * alone is per-frame, not per-message) and string fields are appended, so a
 * delta and a full history record converge on the same shape.
 */

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_return"
  | "system"
  | "task"
  | "approval_request"
  | "approval_response"
  | "event"
  | "notice"
  | "question"
  | "pi_run";

/** The filter groups offered in the UI. */
export type FilterGroup = "user" | "agent" | "tools" | "tasks" | "system";

export interface TranscriptEntry {
  id: string;
  kind: EntryKind;
  date: string;
  /** Ordering key: first time this id was seen. */
  seenAt: number;
  text: string;
  /** tool_call / approval_request */
  toolName?: string;
  toolArgs?: string;
  toolCallId?: string;
  /** pi_run: the remote-pi run this entry announces (parsed from the tool return). */
  piRunId?: string;
  /** tool_return */
  status?: "success" | "error";
  /** tool_return: the captured streams, when the app-server sent them separately. */
  stdout?: string[];
  stderr?: string[];
  /** notice */
  level?: "info" | "success" | "warning" | "error";
  /** notice: the machine payload behind the headline, shown behind a disclosure. */
  detail?: string;
  /** loop_error: the run it belongs to, used to fold the duplicate pair. */
  runId?: string;
  /** reasoning */
  redacted?: boolean;
  /** Set while the entry is still being streamed. */
  streaming?: boolean;
  /** A machine-injected block lifted out of a user message; rendered collapsed. */
  reminder?: boolean;
  /** task: the summary line, shown in the header. */
  title?: string;
  /** task: the originating task id. */
  taskId?: string;
  /** user: arrived over a channel (telegram, slack) rather than being typed. */
  channel?: string;
  /**
   * user: images attached to the message, lifted from base64 image content
   * parts — present on the local echo, the queued echo and history alike,
   * because all three carry the parts (`readContentParts`).
   */
  images?: TranscriptImage[];
  /**
   * question: the async AskUserQuestion receipt (letta-code 0.34.1+). The tool
   * returns immediately with this — the answer is not part of the tool call,
   * it comes back later as an ordinary user message, so this card stays live
   * until a `questionResponse` shows up or the user dismisses it.
   */
  question?: AskUserQuestionReceipt;
  /** task: an `<ask-user-question-response>` lifted out of a notification. */
  questionResponse?: AskUserQuestionResponse;
  /**
   * user: sent with a `response_format` JSON schema, so the reply was
   * constrained. Only the client knows this — nothing on the wire carries it
   * back — so it is set where the local echo is made and never survives a
   * reload from history.
   */
  structured?: boolean;
  /**
   * Rendered by us on send, before any server frame. The app-server only echoes
   * a user message when it was queued, so without this your own message never
   * appears until a reload.
   */
  local?: boolean;
  /** Rendered dimmed (command output that is informational only). */
  dim?: boolean;
  /** Subagent that produced this entry, when not the main agent. */
  subagentId?: string;
}

const FILTER_GROUPS: Record<EntryKind, FilterGroup> = {
  user: "user",
  assistant: "agent",
  reasoning: "agent",
  tool_call: "tools",
  tool_return: "tools",
  // Background work reporting back carries content you asked for, unlike the
  // environment plumbing in "system" — so it gets its own switch.
  task: "tasks",
  approval_request: "tools",
  approval_response: "tools",
  system: "system",
  event: "system",
  notice: "system",
  // A tool the agent ran; the card answers it, but it belongs with the work.
  question: "tools",
  // A remote-pi run announced in the transcript; it rides the Tools switch.
  pi_run: "tools",
};

export const FILTER_LABELS: Record<FilterGroup, string> = {
  user: "You",
  agent: "Agent",
  tools: "Tools",
  tasks: "Tasks",
  system: "System",
};

/** One image attached to a message, rendered from a `data:` URL. */
export interface TranscriptImage {
  mediaType: string;
  dataUrl: string;
}

export type Transcript = Map<string, TranscriptEntry>;

/**
 * Alias maps that hold one streamed message together.
 *
 * `delta.id` is NOT stable: the local backend's `createStoredChunk` mints a
 * fresh `letta-msg-N` for every chunk and strips the provider's own id. `otid`
 * is memoized per contiguous content segment and is the only field constant
 * across a message — a real capture showed 98 deltas, 98 ids, 1 otid. Keying on
 * `id` therefore produces one entry per word.
 *
 * Both directions are needed because streams mix the two: some chunks carry
 * only `id`, some only `otid`, some both. This mirrors `resolveAssistantLineId`
 * in letta-code's own TUI accumulator, which is the reference implementation.
 */
export interface StreamIndex {
  byMessageId: Map<string, string>;
  byOtid: Map<string, string>;
}

export function createStreamIndex(): StreamIndex {
  return { byMessageId: new Map(), byOtid: new Map() };
}

/**
 * The key this message accumulates under, remembering the aliases so later
 * chunks of the same message resolve to it whichever field they carry.
 */
function resolveCanonicalKey(
  index: StreamIndex,
  transcript: Transcript,
  id: string,
  otid: string,
  kind: EntryKind,
): string {
  // `||` not `??`: the absent fields are empty strings, not undefined.
  let canonical =
    (id ? index.byMessageId.get(id) : undefined) ??
    (otid ? index.byOtid.get(otid) : undefined) ??
    (id || otid);
  if (!canonical) return "";

  // Providers can reuse one id/otid across an assistant and a reasoning block.
  // Namespacing on collision keeps a thought out of the spoken message.
  const existing = transcript.get(canonical);
  if (existing && existing.kind !== kind) canonical = `${kind}:${canonical}`;

  if (id) index.byMessageId.set(id, canonical);
  if (otid) index.byOtid.set(otid, canonical);
  return canonical;
}

/**
 * Machine-injected blocks that ride along inside a user message.
 *
 * These are not something the person typed, so rendering them in the user
 * bubble is wrong twice over: it credits them to the human, and — because an
 * opening tag on its own line is a CommonMark HTML block that react-markdown
 * drops along with the paragraph after it — the body silently disappears.
 *
 * The tag text is the only signal available. No structured marker survives into
 * history: `otid` is a bare UUID on every path, `role` is always "user", and
 * `created_by_id` is absent both for notification batches and for real messages
 * here. letta-code parses text everywhere it consumes these too, so this is the
 * sanctioned approach rather than a workaround.
 */
const INJECTED_BLOCKS: Record<string, EntryKind> = {
  "system-reminder": "system",
  // Legacy: no longer constructed upstream, still parsed there for old history.
  "system-alert": "system",
  "stop-hook": "system",
  skill_content: "system",
  loaded_skills: "system",
  "task-notification": "task",
  // A person talking from another device, not machine noise — stays a user
  // message, just labelled with where it came from.
  "channel-notification": "user",
};

const INJECTED_BLOCK_RE = new RegExp(
  // The tag may carry attributes (`<skill_content name="...">`). The closing tag
  // is optional so a block still mid-stream is recognised rather than swallowing
  // the rest of the transcript once it completes.
  `<(${Object.keys(INJECTED_BLOCKS).join("|")})(\\s[^>]*)?>([\\s\\S]*?)(?:</\\1>|$)`,
  "g",
);

/**
 * A message that OPENS with an unknown tag block.
 *
 * Pre-loaded skills inject `<${skillId}>…</${skillId}>` — the tag name IS the
 * skill id, so there is no fixed list to match. Two guards keep this off real
 * prose: the block must start the message, and it must be properly closed (no
 * open-ended fallback). So "is 3 < 5?" and "use <div> in html" are untouched,
 * while a skill dump followed by a question still splits correctly.
 */
const LEADING_TAG_RE = /^<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/;

/** Tags that are real HTML, so a message using them is prose, not an injection. */
const HTML_TAGS = new Set([
  "p",
  "div",
  "span",
  "a",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "img",
  "blockquote",
]);

/** The trailing pointer upstream appends OUTSIDE the closing tag. */
const TRANSCRIPT_LINE_RE = /^Full transcript available at: .*$/gm;

interface InjectedBlock {
  tag: string;
  kind: EntryKind;
  attrs: string;
  body: string;
}

/** Pull out every known block, plus the whole-message skill case. */
function extractBlocks(text: string): { blocks: InjectedBlock[]; prose: string } {
  const blocks: InjectedBlock[] = [];
  let prose = text
    .replace(INJECTED_BLOCK_RE, (_match, tag: string, attrs: string | undefined, body: string) => {
      blocks.push({
        tag,
        kind: INJECTED_BLOCKS[tag] ?? "system",
        attrs: attrs ?? "",
        body: body.trim(),
      });
      return "";
    })
    .replace(TRANSCRIPT_LINE_RE, "")
    .trim();

  if (blocks.length === 0) {
    const leading = LEADING_TAG_RE.exec(prose);
    if (leading && !HTML_TAGS.has(leading[1] ?? "")) {
      blocks.push({
        tag: leading[1] ?? "",
        kind: "system",
        attrs: "",
        body: (leading[2] ?? "").trim(),
      });
      prose = prose.slice(leading[0].length).trim();
    }
  }
  return { blocks, prose };
}

/** First `<tag>value</tag>` inside a block body. */
function innerTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match?.[1]?.trim() || undefined;
}

/**
 * Task notifications come in three incompatible shapes — the full subagent/Bash
 * form, a Monitor variant with no status and a nested <event>, and a reflection
 * variant that is a summary and nothing else. Only <summary> is common to all,
 * so every field is optional and the raw body is the fallback.
 */
function taskEntry(base: TranscriptEntry, body: string): TranscriptEntry {
  const summary = innerTag(body, "summary");
  const status = innerTag(body, "status");
  const result = innerTag(body, "result");
  const taskId = innerTag(body, "task-id");
  // An answer to an AskUserQuestion card is a task notification too —
  // `prepareAskUserQuestionNotif` wraps it in exactly this tag. Lift it so the
  // card can render read-only with the chosen answers, live and after a
  // reload alike (the raw block would otherwise just say "User answered").
  // The extractor hands us the body INSIDE the tag, so re-wrap for the
  // npm parser, which only matches complete notifications.
  const [questionResponse] = parseAskUserQuestionNotif(
    `<task-notification>${body}</task-notification>`,
  );

  return {
    ...base,
    kind: "task",
    // Never an empty card: without a summary the raw block is still readable.
    ...(summary ? { title: summary } : { title: body.slice(0, 120) }),
    ...(taskId ? { taskId } : {}),
    // Absent status (Monitor) must not read as a failure, so no badge at all.
    ...(status ? { status: status === "completed" ? "success" : "error" } : {}),
    ...(questionResponse ? { questionResponse } : {}),
    text: result ?? (summary ? "" : body),
  };
}

/** `<channel-notification channel="telegram">` → the channel name. */
function channelName(attrs: string): string | undefined {
  return /channel="([^"]+)"/.exec(attrs)?.[1];
}

/** Whatever the person actually wrote, with machine-injected blocks removed. */
export function stripInjectedBlocks(text: string): string {
  if (!text.includes("<")) return text.trim();
  return extractBlocks(text).prose;
}

/**
 * Expand one user entry into its injected blocks plus whatever the person
 * actually wrote. Any other entry passes through untouched.
 */
function splitInjectedBlocks(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind !== "user" || !entry.text.includes("<")) return [entry];

  const { blocks, prose } = extractBlocks(entry.text);
  if (blocks.length === 0) return [entry];

  const out: TranscriptEntry[] = blocks.map((block, index) => {
    const base: TranscriptEntry = { ...entry, id: `${entry.id}:block:${index}` };
    if (block.kind === "task") return taskEntry(base, block.body);
    if (block.kind === "user") {
      const channel = channelName(block.attrs);
      return { ...base, text: block.body, ...(channel ? { channel } : {}) };
    }
    return { ...base, kind: "system", reminder: true, text: block.body };
  });

  // A message that was nothing but injected blocks leaves no user bubble behind.
  if (prose) out.push({ ...entry, text: prose });
  return out;
}

/**
 * Show the user's own message immediately.
 *
 * `emitDequeuedUserMessage` is the only thing that puts a user message on the
 * wire, and both call sites are guarded by `consumeQueuedTurn` — so the echo
 * arrives ONLY for a message that was queued behind a busy agent. On the
 * ordinary path nothing comes back, and the transcript would show the reply
 * without the question.
 *
 * The client message id becomes the server's `otid`, so registering it in the
 * stream index means a later echo resolves onto this same entry instead of
 * creating a second one.
 */
export function addLocalUserMessage(
  transcript: Transcript,
  index: StreamIndex,
  clientMessageId: string,
  text: string,
  seq: number,
  structured = false,
  images?: TranscriptImage[],
): void {
  index.byOtid.set(clientMessageId, clientMessageId);
  transcript.set(clientMessageId, {
    id: clientMessageId,
    kind: "user",
    date: new Date().toISOString(),
    seenAt: seq,
    text,
    local: true,
    streaming: false,
    ...(structured ? { structured: true } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  });
}

/**
 * Name each tool return after the call it answers.
 *
 * A `tool_return_message` carries no tool name — only `tool_call_id` — so the
 * name has to come from the matching call. Done here rather than in
 * `applyMessage` because a return can be merged before its call has been seen
 * whole, and this runs over the finished transcript.
 */
function nameToolReturns(entries: TranscriptEntry[]): TranscriptEntry[] {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "tool_call" && entry.kind !== "approval_request") continue;
    if (entry.toolCallId && entry.toolName) names.set(entry.toolCallId, entry.toolName);
  }
  if (names.size === 0) return entries;
  return entries.map((entry) => {
    if (entry.kind !== "tool_return" || entry.toolName || !entry.toolCallId) return entry;
    const toolName = names.get(entry.toolCallId);
    return toolName ? { ...entry, toolName } : entry;
  });
}

const PI_RUN_ANNOUNCE =
  /^(?:Started remote-pi (?:run|send)|run) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

/**
 * The remote-pi runs announced by tool returns. A `pi_run`/`pi_send` return
 * announces a run's birth; the synthetic `pi_run` entry placed right after it
 * is where the live run card renders (it polls until the run settles), so the
 * human watches the dispatch directly instead of asking the agent to relay
 * pi_status. Several returns about the same run get one card, at the first.
 */
function attachPiRunCards(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    out.push(entry);
    if (entry.kind !== "tool_return") continue;
    if (entry.toolName !== "pi_run" && entry.toolName !== "pi_send" && entry.toolName !== "pi_wait")
      continue;
    const match = PI_RUN_ANNOUNCE.exec(entry.text);
    if (!match || seen.has(match[1]!)) continue;
    seen.add(match[1]!);
    out.push({
      id: `pi-run:${match[1]}`,
      kind: "pi_run",
      date: entry.date,
      seenAt: entry.seenAt + 0.5, // straight after the return it answers
      text: entry.text,
      piRunId: match[1]!,
    });
  }
  return out;
}

/**
 * The async AskUserQuestion receipt carried by a tool return, or null.
 *
 * Since 0.34.1 the question tool does not block: its return is an immediate
 * receipt `{type: "ask_user_question", version: 2, toolCallId, questions}`
 * and the agent is told to continue without an answer. The receipt is a
 * persisted tool return, so the pending question survives a tab-away, a
 * reconnect, and a full history rebuild — which is what makes detection here
 * (live and replay share the keyed entry) the only place it needs doing.
 */
export function readQuestionReceipt(entry: TranscriptEntry): AskUserQuestionReceipt | null {
  if (entry.kind !== "tool_return" || !entry.toolCallId) return null;
  // Cheap guards first: this runs over every return on every flush.
  if (entry.toolName !== "AskUserQuestion" || !entry.text.includes('"ask_user_question"'))
    return null;
  const receipt = parseAskUserQuestionReceipt(entry.text);
  return receipt && receipt.toolCallId === entry.toolCallId ? receipt : null;
}

/**
 * Give every question receipt its own transcript entry, beside the tool return
 * that carries it.
 *
 * The return itself keeps folding into its call as the machine record it is;
 * the promoted entry renders the interactive card at top level, because a
 * pending question must never hide inside a collapsed steps run. Runs on the
 * sorted, named, block-split entries so live and rebuilt transcripts promote
 * identically.
 */
function promoteQuestions(entries: TranscriptEntry[]): TranscriptEntry[] {
  let hasQuestion = false;
  for (const entry of entries) {
    if (entry.kind === "tool_return" && readQuestionReceipt(entry) !== null) {
      hasQuestion = true;
      break;
    }
  }
  if (!hasQuestion) return entries;

  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    const receipt = readQuestionReceipt(entry);
    if (!receipt || !entry.toolCallId) continue;
    out.push({
      id: `question:${entry.toolCallId}`,
      kind: "question",
      date: entry.date,
      // Just after the return it answers; fractional values are the existing
      // convention for inserting between integer seqs (see mergeTurnErrors).
      seenAt: entry.seenAt + 0.1,
      text: entry.text,
      toolCallId: entry.toolCallId,
      question: receipt,
      ...(entry.subagentId ? { subagentId: entry.subagentId } : {}),
    });
  }
  return out;
}

/**
 * The transcript as a render-ready list, ordered by arrival.
 *
 * Entries are mutated in place while streaming (`applyMessage` appends to
 * `entry.text`), so a settled entry's object identity is stable across flushes
 * and a streaming one's is not — which is exactly what `React.memo` needs. To
 * keep that property, every entry that is still streaming is shallow-copied here.
 * Without the copy a memoised row would never see the new tokens and the bubble
 * would freeze mid-sentence; with it, only the one or two rows actually
 * changing re-render, instead of every message in the conversation per token.
 */
export function sortedEntries(transcript: Transcript): TranscriptEntry[] {
  return attachPiRunCards(
    promoteQuestions(
      nameToolReturns(
        [...transcript.values()]
          .sort((a, b) => {
            if (a.seenAt !== b.seenAt) return a.seenAt - b.seenAt;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
          .map((entry) => (entry.streaming ? { ...entry } : entry))
          // After copying, so an extracted block keeps its parent's position and a
          // settled entry keeps its identity.
          .flatMap(splitInjectedBlocks),
      ),
    ),
  );
}

/** Every filter group, in the order the Filter sheet lists them. */
export const FILTER_ORDER: readonly FilterGroup[] = ["user", "agent", "tools", "tasks", "system"];

/**
 * Whether a group's messages are on screen. The filter set holds the groups to
 * show, and an empty set means "everything" — so every box reads ticked then.
 */
export function isShown(active: ReadonlySet<FilterGroup>, group: FilterGroup): boolean {
  return active.size === 0 || active.has(group);
}

/**
 * Tick or untick one group as the Filter sheet shows it (ticked = shown).
 * From "everything", unticking hides just that group; ticking the last hidden
 * group back returns to the empty "everything" set. The last shown group
 * cannot be unticked: an empty set already means everything, not nothing.
 */
export function toggleShown(
  active: ReadonlySet<FilterGroup>,
  group: FilterGroup,
): Set<FilterGroup> {
  const shown = new Set(FILTER_ORDER.filter((g) => isShown(active, g)));
  if (shown.has(group)) {
    if (shown.size === 1) return new Set(active);
    shown.delete(group);
  } else {
    shown.add(group);
  }
  return shown.size === FILTER_ORDER.length ? new Set() : shown;
}

export function filterEntries(
  entries: TranscriptEntry[],
  active: ReadonlySet<FilterGroup>,
): TranscriptEntry[] {
  if (active.size === 0) return entries;
  return entries.filter((entry) => active.has(FILTER_GROUPS[entry.kind]));
}

/** One row of the rendered transcript: a message, a notice, or a run of steps. */
export type TranscriptItem =
  | { kind: "message"; entry: TranscriptEntry }
  | { kind: "notice"; entry: TranscriptEntry }
  | {
      kind: "steps";
      /** The first step's id — stable while the run grows at its tail. */
      id: string;
      /** Steps and narration, in order; narration is `isNarration`. */
      entries: TranscriptEntry[];
      /** Step count per label, in first-seen order ("Thinking" → 6, "Bash" → 5). */
      counts: [label: string, count: number][];
      /** Number of steps — `entries` minus the narration. */
      steps: number;
      /** The run's latest narration line, its heading while folded. */
      headline?: string;
      /** When the run began. */
      date: string;
    };

/** The main agent speaking, as opposed to a subagent's reply (a step). */
function isAgentText(entry: TranscriptEntry): boolean {
  return entry.kind === "assistant" && !entry.subagentId;
}

/**
 * Text the model emitted that says nothing. Some local models put a lone
 * newline between two tool calls of one step (`[thinking, toolCall, "\n",
 * toolCall]` in the store), and upstream turns every text part into an
 * `assistant_message` — which drew an empty "Agent" bubble per step.
 */
function isBlankAgentText(entry: TranscriptEntry): boolean {
  return isAgentText(entry) && entry.text.trim() === "";
}

/**
 * Where one turn ends and the next begins, for telling narration from an
 * answer: your message, background work reporting back (which starts a turn of
 * its own), injected reminders (they open a cron- or channel-fired turn), and
 * notices (often the error that ended one).
 */
function isTurnBoundary(entry: TranscriptEntry): boolean {
  return (
    entry.kind === "user" ||
    entry.kind === "task" ||
    entry.kind === "notice" ||
    // A posted question ends the work that asked for it: the agent's next text
    // arrives on the answer, in a turn of its own.
    entry.kind === "question" ||
    (entry.kind === "system" && entry.reminder === true)
  );
}

/** The conversation proper: what you said and what the agent answered. */
function isConversationMessage(entry: TranscriptEntry): boolean {
  if (entry.reminder) return false;
  if (entry.kind === "user") return true;
  return isAgentText(entry);
}

/**
 * The main agent's text that more work followed within the same turn:
 * "Scan done. Selecting the scoring batch:" before a tool call. It is the
 * agent narrating its steps, not answering, so it folds in with them — only a
 * turn's last text is its answer. The set is keyed by entry id.
 */
function narrationIds(entries: readonly TranscriptEntry[]): Set<string> {
  const ids = new Set<string>();
  let workFollows = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (isTurnBoundary(entry)) workFollows = false;
    else if (isAgentText(entry)) {
      if (isBlankAgentText(entry)) continue;
      if (workFollows) ids.add(entry.id);
    } else workFollows = true;
  }
  return ids;
}

/** Whether a steps-run entry is narration rather than a step. */
export function isNarration(entry: TranscriptEntry): boolean {
  return isAgentText(entry);
}

/** How a step is counted in its group's summary line. */
export function stepLabel(entry: TranscriptEntry): string {
  if (entry.reminder) return "Reminder";
  switch (entry.kind) {
    case "reasoning":
      return "Thinking";
    case "tool_call":
    case "approval_request":
      return entry.toolName ?? "Tool";
    case "tool_return":
      return entry.toolName ?? "Result";
    case "task":
      return "Task";
    case "assistant":
      return "Subagent";
    case "approval_response":
      return "Approval";
    case "question":
      return "Question";
    case "event":
      return "Event";
    default:
      return "System";
  }
}

/**
 * Fold the agent's work between messages into runs.
 *
 * The transcript used to render every thinking block, tool call and reminder at
 * the same weight as the question and the answer, so a ten-step turn buried the
 * reply. Each run of consecutive steps becomes one collapsible item; messages
 * and notices stay standalone — a notice is often the error that ended the
 * turn, and must never be hidden inside a fold. The caller removes tool returns
 * it renders folded into their call before grouping, so they are not counted.
 *
 * The agent's narration between steps ("Scan done. Selecting the batch:")
 * belongs to the run, not between runs: splitting on it turned one turn into a
 * ladder of bubble / "3 steps" pairs. So a whole turn's work is one run, headed
 * by its latest narration, and only the turn's final text stands as the
 * answer. Blank text is dropped outright. Live, the agent's newest text is an
 * answer until a step follows it, then it folds into the run above.
 */
export function groupTranscript(entries: readonly TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const narration = narrationIds(entries);
  let run: Extract<TranscriptItem, { kind: "steps" }> | null = null;
  let counts = new Map<string, number>();

  for (const entry of entries) {
    if (isBlankAgentText(entry)) continue;
    if (entry.kind === "notice") {
      items.push({ kind: "notice", entry });
      run = null;
      continue;
    }
    if (entry.kind === "question") {
      // Standalone, never inside a run: a question the user has to see and
      // answer cannot hide behind a collapsed "5 steps" fold.
      items.push({ kind: "message", entry });
      run = null;
      continue;
    }
    if (entry.kind === "pi_run") {
      // Same as a question: the live run card must never hide inside a fold.
      items.push({ kind: "message", entry });
      run = null;
      continue;
    }
    if (isConversationMessage(entry) && !narration.has(entry.id)) {
      items.push({ kind: "message", entry });
      run = null;
      continue;
    }
    if (!run) {
      counts = new Map();
      run = { kind: "steps", id: entry.id, entries: [], counts: [], steps: 0, date: entry.date };
      items.push(run);
    }
    run.entries.push(entry);
    if (narration.has(entry.id)) {
      run.headline = entry.text.trim();
      continue;
    }
    run.steps += 1;
    const label = stepLabel(entry);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    run.counts = [...counts];
  }
  return items;
}

/** Text plus images carried by one Letta `content` field. */
export interface ContentParts {
  text: string;
  images: TranscriptImage[];
}

/**
 * One base64 image content part, as the wire sends it:
 * `{ type: "image", source: { type: "base64", media_type, data } }` — the
 * shape letta-code's own Telegram channel emits and the app-server normalizes
 * before the model call. Anything else (a `url` source, a malformed part) is
 * not something this UI can render and is skipped, exactly as it always was
 * when only text was read.
 */
function readImagePart(part: Record<string, unknown>): TranscriptImage | null {
  if (part.type !== "image") return null;
  const source = part.source;
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  if (record.type !== "base64") return null;
  if (typeof record.media_type !== "string" || !record.media_type) return null;
  if (typeof record.data !== "string" || !record.data) return null;
  return {
    mediaType: record.media_type,
    dataUrl: `data:${record.media_type};base64,${record.data}`,
  };
}

/** Letta content fields are either a plain string or an array of content parts. */
export function readContentParts(content: unknown): ContentParts {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  let text = "";
  const images: TranscriptImage[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const image = readImagePart(record);
    if (image) {
      images.push(image);
      continue;
    }
    if (typeof record.text === "string") text += record.text;
  }
  return { text, images };
}

function contentToText(content: unknown): string {
  return readContentParts(content).text;
}

interface ToolCallish {
  name?: unknown;
  arguments?: unknown;
  tool_call_id?: unknown;
}

function readToolCall(message: Record<string, unknown>): ToolCallish | null {
  const single = message.tool_call;
  if (single && typeof single === "object") return single as ToolCallish;
  const many = message.tool_calls;
  if (Array.isArray(many) && many.length > 0 && typeof many[0] === "object") {
    return many[0] as ToolCallish;
  }
  if (many && typeof many === "object") return many as ToolCallish;
  return null;
}

interface ToolReturnPart {
  toolCallId: string;
  status: "success" | "error";
  text: string;
  stdout?: string[];
  stderr?: string[];
}

function readOutputLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines : undefined;
}

/** The return body as text, whatever shape it arrived in. */
function toolReturnText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentToText(value);
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function readToolReturnPart(raw: unknown): ToolReturnPart | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
  if (!toolCallId) return null;
  const stdout = readOutputLines(record.stdout);
  const stderr = readOutputLines(record.stderr);
  return {
    toolCallId,
    status: record.status === "error" ? "error" : "success",
    text: toolReturnText(record.tool_return),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

/**
 * Every tool return carried by one `tool_return_message`.
 *
 * The wire has two shapes and a live frame carries BOTH: the singular
 * `tool_call_id`/`status`/`tool_return` fields that history persists, and a
 * `tool_returns[]` array that `normalizeToolReturnWireMessage` adds upstream
 * (`websocket/listener/interrupts.ts`) and that alone can describe an interrupt
 * settling several calls at once. The array wins when present; the singular
 * fields are the history fallback. `tool_returns` is absent from
 * `protocol_v2.ts`, so typecheck cannot see drift here.
 */
function readToolReturns(message: Record<string, unknown>): ToolReturnPart[] {
  const many = message.tool_returns;
  if (Array.isArray(many)) {
    const parts = many.flatMap((raw) => {
      const part = readToolReturnPart(raw);
      return part ? [part] : [];
    });
    if (parts.length > 0) return parts;
  }
  const single = readToolReturnPart(message);
  return single ? [single] : [];
}

/**
 * The key one tool return accumulates under.
 *
 * ONE call produces at least TWO frames — a `synthetic-tool-return-stream-<id>`
 * snapshot while the tool runs and a `synthetic-tool-return-<uuid>` canonical
 * one after (verified against a live turn), and upstream says so outright:
 * "Client-executed tools emit repeated tool_return_message snapshots while
 * running" (`websocket/app-server-openai-tools.ts`). Their ids differ and they
 * carry no `otid`, so keying the usual way drew one Result row per snapshot —
 * which a reload then collapsed, because history stores a single record.
 *
 * `tool_call_id` is the one field constant across every frame AND present in
 * history, so live and reloaded transcripts land on the same key.
 */
function toolReturnKey(toolCallId: string): string {
  return `return:${toolCallId}`;
}

function kindForMessageType(messageType: string): EntryKind | null {
  switch (messageType) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "reasoning_message":
    case "hidden_reasoning_message":
      return "reasoning";
    case "tool_call_message":
      return "tool_call";
    case "tool_return_message":
      return "tool_return";
    case "system_message":
      return "system";
    case "approval_request_message":
      return "approval_request";
    case "approval_response_message":
      return "approval_response";
    case "event_message":
      return "event";
    default:
      return null;
  }
}

/**
 * Merge every tool return in one frame into the transcript, one entry per call.
 *
 * Later frames overwrite earlier ones, which is what makes the corrected status
 * stick: the running snapshot reports `success` even for a command that went on
 * to fail, and only the canonical frame that follows says `error`.
 */
function applyToolReturns(
  transcript: Transcript,
  message: Record<string, unknown>,
  fallbackKey: string,
  options: { streaming: boolean; seq: number; subagentId?: string },
): void {
  for (const part of readToolReturns(message)) {
    const key = part.toolCallId ? toolReturnKey(part.toolCallId) : fallbackKey;
    if (!key) continue;
    const existing = transcript.get(key);
    transcript.set(key, {
      ...(existing ?? {
        id: key,
        date: typeof message.date === "string" ? message.date : new Date().toISOString(),
        seenAt: options.seq,
        ...(options.subagentId ? { subagentId: options.subagentId } : {}),
      }),
      id: key,
      kind: "tool_return",
      streaming: options.streaming,
      text: part.text,
      status: part.status,
      toolCallId: part.toolCallId,
      ...(part.stdout ? { stdout: part.stdout } : {}),
      ...(part.stderr ? { stderr: part.stderr } : {}),
    } as TranscriptEntry);
  }
}

/** Merge one Letta message (delta or complete) into the transcript. */
function applyMessage(
  transcript: Transcript,
  raw: unknown,
  options: { streaming: boolean; seq: number; subagentId?: string; index?: StreamIndex },
): void {
  if (!raw || typeof raw !== "object") return;
  const message = raw as Record<string, unknown>;

  const messageType = typeof message.message_type === "string" ? message.message_type : "";
  const kind = kindForMessageType(messageType);
  if (!kind) return;

  const id = typeof message.id === "string" ? message.id : "";
  const otid = typeof message.otid === "string" ? message.otid : "";
  // A chunk with an otid but no id is a real shape (a raw pre-store provider
  // chunk); only a chunk with neither is unaddressable.
  if (!id && !otid) return;

  // Tool returns key on their tool call, not on the frame, and one frame can
  // settle several calls — so they never reach the single-entry path below.
  if (kind === "tool_return") {
    applyToolReturns(transcript, message, id || otid, options);
    return;
  }

  // History carries a stable id and no otid, so it still keys by id and the
  // replay path is unchanged.
  const key = options.index
    ? resolveCanonicalKey(options.index, transcript, id, otid, kind)
    : id || otid;
  if (!key) return;

  const existing = transcript.get(key);
  const entry: TranscriptEntry = existing ?? {
    id: key,
    kind,
    date: typeof message.date === "string" ? message.date : new Date().toISOString(),
    seenAt: options.seq,
    text: "",
    ...(options.subagentId ? { subagentId: options.subagentId } : {}),
  };

  // A later frame may reveal the concrete type after a generic first chunk.
  entry.kind = kind;
  entry.streaming = options.streaming;

  switch (kind) {
    case "user":
    case "assistant": {
      const parts = readContentParts(message.content);
      const chunk = parts.text;
      // History replaces; streaming appends. A replayed history record for a
      // message we streamed must not double the text.
      //
      // The exception is an entry we rendered ourselves on send: the server's
      // echo carries the whole message, so appending it to our copy would show
      // the text twice. Replace once, then let normal append semantics resume
      // in case the echo is itself chunked.
      if (options.streaming && entry.local) {
        entry.text = chunk;
        entry.local = false;
      } else {
        entry.text = options.streaming ? entry.text + chunk : chunk;
      }
      // Image parts arrive whole on one frame (echo or history record); a
      // frame carrying none must not erase the ones our local echo put there.
      // Non-empty means the server's (normalized) copy replaces ours.
      if (parts.images.length > 0) entry.images = parts.images;
      break;
    }
    case "reasoning": {
      if (messageType === "hidden_reasoning_message") {
        entry.redacted = true;
        const hidden = message.hidden_reasoning;
        entry.text = typeof hidden === "string" ? hidden : "(reasoning hidden)";
      } else {
        const chunk = typeof message.reasoning === "string" ? message.reasoning : "";
        entry.text = options.streaming ? entry.text + chunk : chunk;
      }
      break;
    }
    case "tool_call":
    case "approval_request": {
      const call = readToolCall(message);
      if (call) {
        if (typeof call.name === "string" && call.name) entry.toolName = call.name;
        if (typeof call.tool_call_id === "string" && call.tool_call_id) {
          entry.toolCallId = call.tool_call_id;
        }
        if (typeof call.arguments === "string") {
          entry.toolArgs = options.streaming
            ? (entry.toolArgs ?? "") + call.arguments
            : call.arguments;
        }
      }
      break;
    }
    case "system": {
      entry.text = contentToText(message.content);
      break;
    }
    case "approval_response": {
      const approved = message.approve === true;
      const reason = typeof message.reason === "string" ? message.reason : "";
      entry.text = approved ? "Approved" : `Denied${reason ? `: ${reason}` : ""}`;
      entry.status = approved ? "success" : "error";
      break;
    }
    case "event": {
      const eventType = typeof message.event_type === "string" ? message.event_type : "event";
      entry.text = eventType === "compaction" ? "Conversation compacted" : eventType;
      break;
    }
    case "notice":
      break;
  }

  transcript.set(key, entry);
}

/**
 * The error notice this one merely repeats, or null.
 *
 * ONE failure emits TWO loop_error deltas upstream. While the stream drains,
 * `turn.ts` emits a non-terminal notice off the error chunk and stashes the
 * chunk in `latestErrorInfoRef`; at the stop it emits a terminal one whose
 * message is `latestErrorInfo.detail || latestErrorInfo.message`. Against the
 * local backend those are the same sentence — `localErrorChunk` fills both
 * fields from a single `normalizeLocalProviderError` — so the transcript drew
 * the same error twice. Each delta carries its own `lifecycle-<uuid>`, so
 * keying on the id cannot catch it, and the fork carries zero delta so it
 * cannot be fixed at the source.
 *
 * The match is kept tight so a real repeat is never swallowed: when both
 * notices name a run, only the same run folds — errors from different turns
 * stay separate. Without a run to key on, only a repeat of the MOST RECENT
 * notice folds, which is the ordinary adjacent-log-line collapse and cannot
 * reach back across a turn.
 */
function duplicateErrorNotice(
  transcript: Transcript,
  text: string,
  runId: string,
): TranscriptEntry | null {
  let latest: TranscriptEntry | null = null;
  for (const entry of transcript.values()) {
    latest = entry;
    if (
      runId &&
      entry.kind === "notice" &&
      entry.level === "error" &&
      entry.runId === runId &&
      entry.text === text
    ) {
      return entry;
    }
  }
  if (runId) return null;

  // No run to key on, so fold only what immediately precedes this — anything at
  // all in between, an assistant message included, means the turn carried on and
  // this is a second failure rather than the same one being finalised.
  if (
    latest?.kind === "notice" &&
    latest.level === "error" &&
    !latest.runId &&
    latest.text === text
  ) {
    return latest;
  }
  return null;
}

/**
 * Split a provider error into a sentence and the machine detail behind it.
 *
 * `local-provider-errors.ts` builds the detail a terminal `loop_error` carries
 * by joining the error message with `JSON.stringify()` of whichever of
 * `responseBody`, `data`, `body`, `detail`, `code` the failure happened to
 * have — so what reaches the transcript is a sentence followed by llama.cpp's
 * raw HTTP body. Rendering that verbatim is how "ERROR messages come as JSON".
 *
 * The body is not discarded, only demoted: the caller shows it behind a
 * disclosure, because the actual cause is sometimes only in there.
 */
export function splitErrorDetail(text: string): { headline: string; detail?: string } {
  const prose: string[] = [];
  const machine: string[] = [];
  let lifted = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      if (trimmed) prose.push(trimmed);
      continue;
    }
    machine.push(trimmed);
    if (lifted) continue;
    try {
      lifted = liftErrorMessage(JSON.parse(trimmed));
    } catch {
      // Not JSON after all — it stays in the detail and nothing is lifted.
    }
  }

  // Prefer what the provider itself said over our own wrapper sentence: an
  // "Error: 500 status code (no body)" tells you nothing a payload message does
  // not, and the payload is the part that names the actual fault.
  const headline = lifted || prose.join(" ") || text.trim();
  const detail = machine.length > 0 ? machine.join("\n") : undefined;
  return detail ? { headline, detail } : { headline };
}

/** The human sentence inside a provider error payload, if it has one. */
function liftErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const inner = liftErrorMessage(nested);
    if (inner) return inner;
  }
  const message = record.message;
  return typeof message === "string" ? message.trim() : "";
}

/** Non-message lifecycle deltas: status lines, retries, errors, command output. */
function applyNotice(transcript: Transcript, raw: Record<string, unknown>, seq: number): void {
  const messageType = typeof raw.message_type === "string" ? raw.message_type : "";
  const id = typeof raw.id === "string" ? raw.id : `${messageType}-${seq}`;

  let text = "";
  let level: TranscriptEntry["level"] = "info";
  let dim = false;
  let detail: string | undefined;

  switch (messageType) {
    case "status":
      text = typeof raw.message === "string" ? raw.message : "";
      level = raw.level === "warning" ? "warning" : raw.level === "success" ? "success" : "info";
      break;
    case "retry": {
      const split = splitErrorDetail(typeof raw.message === "string" ? raw.message : "Retrying");
      text = split.headline;
      detail = split.detail;
      level = "warning";
      break;
    }
    case "loop_error": {
      const split = splitErrorDetail(typeof raw.message === "string" ? raw.message : "Error");
      text = split.headline;
      detail = split.detail;
      level = "error";
      break;
    }
    case "command_end":
    case "slash_command_end": {
      const command = typeof raw.command_id === "string" ? raw.command_id : "command";
      const output = typeof raw.output === "string" ? raw.output : "";
      text = `/${command}\n${output}`.trim();
      level = raw.success === false ? "error" : "info";
      dim = raw.dim_output === true;
      break;
    }
    case "slash_command_start": {
      // Only /compact earns a card, and it earns one because it is the command
      // that runs a whole model call with nothing else on screen: the summary
      // takes a minute or more, and until `slash_command_end` the transcript
      // looks idle and the composer looks free. Every other command answers
      // fast enough that a start line would be noise — which is why this marker
      // used to be dropped outright.
      if (raw.command_id !== "compact") return;
      transcript.set(COMPACT_PENDING_ID, {
        id: COMPACT_PENDING_ID,
        kind: "notice",
        date: typeof raw.date === "string" ? raw.date : new Date().toISOString(),
        seenAt: seq,
        text: "Compacting the conversation… the summary is a model call, so this takes a minute.",
        level: "info",
        streaming: true,
      });
      return;
    }
    case "client_tool_start":
    case "client_tool_end":
    case "command_start":
      return; // Start markers add noise without the paired result.
    default:
      return;
  }

  if (!text) return;

  const runId = typeof raw.run_id === "string" ? raw.run_id : "";
  // Fold the terminal half of a duplicated error into the entry the
  // non-terminal half already made, keeping that entry's `seenAt` so it holds
  // its place — `sortedEntries` orders on `seenAt`. No repeat count: this is
  // one failure reported twice, so a badge would assert something untrue.
  const duplicate =
    messageType === "loop_error" ? duplicateErrorNotice(transcript, text, runId) : null;
  // A finished /compact replaces the "Compacting…" card it grew from, so one
  // compaction is one line. Keyed by command rather than by delta id because
  // the start and end markers carry unrelated random ids and no run id.
  const pending =
    messageType === "slash_command_end" && raw.command_id === "compact"
      ? (transcript.get(COMPACT_PENDING_ID) ?? null)
      : null;
  if (pending) transcript.delete(COMPACT_PENDING_ID);

  transcript.set(duplicate?.id ?? pending?.id ?? id, {
    id: duplicate?.id ?? pending?.id ?? id,
    kind: "notice",
    date: typeof raw.date === "string" ? raw.date : new Date().toISOString(),
    seenAt: duplicate?.seenAt ?? pending?.seenAt ?? seq,
    text,
    level,
    dim,
    ...(detail ? { detail } : {}),
    ...(runId ? { runId } : {}),
  });
}

/** The transcript slot for a running `/compact`, folded into by its end marker. */
const COMPACT_PENDING_ID = "notice:compact-pending";

/**
 * How long a `/compact` may go on claiming the harness is busy. Upstream answers
 * `slash_command_end` on success and on failure alike, so the only way that
 * answer never arrives is a socket drop or an app-server restart mid-compaction
 * — and then the line would sit there claiming work until the page is reloaded.
 * The transcript card keeps its text past this: it is the record that a
 * `/compact` was issued and never answered, and nothing renders it as running.
 */
const COMPACT_PENDING_MAX_MS = 10 * 60_000;

/**
 * When a running `/compact` began, or null when none is. The turn clock is idle
 * during a compaction — no turn is in flight — so this is the only thing that
 * tells the composer's working line the harness is busy and how long it has
 * been at it.
 */
export function pendingCompactStartedAt(entries: readonly TranscriptEntry[]): number | null {
  for (const entry of entries) {
    if (entry.id !== COMPACT_PENDING_ID || !entry.streaming) continue;
    const at = Date.parse(entry.date);
    if (Number.isNaN(at)) return null;
    return Date.now() - at > COMPACT_PENDING_MAX_MS ? null : at;
  }
  return null;
}

/**
 * Put a line in the transcript that came from us, not from the app-server.
 *
 * Used for the things only the client knows: that a stop was refused because
 * nothing was running, or that a stop was accepted but cannot reach the model.
 * Keyed so repeating it replaces the previous one rather than stacking.
 */
export function setLocalNotice(
  transcript: Transcript,
  id: string,
  text: string,
  level: NonNullable<TranscriptEntry["level"]>,
  seq: number,
): void {
  const existing = transcript.get(id);
  transcript.set(id, {
    id,
    kind: "notice",
    date: existing?.date ?? new Date().toISOString(),
    seenAt: existing?.seenAt ?? seq,
    text,
    level,
  });
}

/** Remove a notice this client put there. */
export function clearLocalNotice(transcript: Transcript, id: string): boolean {
  return transcript.delete(id);
}

/** Route one `stream_delta.delta` into the transcript. */
export function applyStreamDelta(
  transcript: Transcript,
  index: StreamIndex,
  delta: unknown,
  seq: number,
  subagentId?: string,
): void {
  if (!delta || typeof delta !== "object") return;
  const record = delta as Record<string, unknown>;

  if (record.type === "message") {
    applyMessage(transcript, record, {
      streaming: true,
      seq,
      index,
      ...(subagentId ? { subagentId } : {}),
    });
    return;
  }
  applyNotice(transcript, record, seq);
}

/**
 * Rebuild a transcript from `conversation_messages_list`.
 *
 * That endpoint returns messages NEWEST FIRST (verified against the backend:
 * the array runs descending by `date`). `seenAt` drives the render order, so
 * using the raw array index put the newest message at the top and rendered the
 * whole conversation backwards — the reply above the question that prompted it.
 */
export function transcriptFromHistory(messages: readonly unknown[]): Transcript {
  const transcript: Transcript = new Map();
  const oldestFirst = [...messages].reverse();
  oldestFirst.forEach((message, index) => {
    applyMessage(transcript, message, { streaming: false, seq: index });
  });
  for (const entry of transcript.values()) entry.streaming = false;
  return transcript;
}

/** A failed turn as the BFF remembers it — `GET /api/turn-errors`. */
export interface TurnErrorRecord {
  turn_id: string;
  run_id: string | null;
  error: string;
  /** ISO time the BFF saw the turn end. */
  at: string;
}

/**
 * Put failed turns back into a transcript rebuilt from history.
 *
 * The app-server never stores a turn's terminal error — it only sends it live
 * as a `loop_error` — so `transcriptFromHistory` cannot show one, and a turn
 * that failed while nobody watched (a cron run) vanished on reload. The BFF
 * keeps them (`bff/src/session/turn-errors.ts`); this slots each one in after
 * the last history entry dated at or before it. Only called on a history
 * rebuild, where no live `loop_error` entry can exist to duplicate.
 */
export function mergeTurnErrors(transcript: Transcript, errors: readonly TurnErrorRecord[]): void {
  const byOrder = [...transcript.values()].sort((a, b) => a.seenAt - b.seenAt);
  for (const record of errors) {
    const at = Date.parse(record.at);
    if (!record.error || Number.isNaN(at)) continue;
    let seenAt = -0.5;
    for (const entry of byOrder) {
      const date = Date.parse(entry.date);
      if (Number.isNaN(date) || date > at) break;
      seenAt = entry.seenAt + 0.5;
    }
    const split = splitErrorDetail(record.error);
    const id = `turn-error:${record.turn_id}`;
    transcript.set(id, {
      id,
      kind: "notice",
      date: record.at,
      seenAt,
      text: split.headline,
      level: "error",
      ...(split.detail ? { detail: split.detail } : {}),
      ...(record.run_id ? { runId: record.run_id } : {}),
    });
  }
}

/** Mark every streaming entry complete (turn finished or aborted). */
export function settleStreaming(transcript: Transcript): void {
  for (const entry of transcript.values()) {
    if (entry.streaming) entry.streaming = false;
  }
}
