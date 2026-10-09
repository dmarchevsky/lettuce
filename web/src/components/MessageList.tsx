import type { AskUserQuestionResponse } from "@letta-ai/letta-code/ask-user-question";
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { claudeSessionInTaskText } from "../lib/claude.ts";
import { copyText } from "../lib/clipboard.ts";
import { codexThreadInTaskText } from "../lib/codex.ts";
import { collectFileTokens } from "../lib/file-links.ts";
import {
  groupTranscript,
  isNarration,
  type TranscriptEntry,
  type TranscriptItem,
} from "../lib/messages.ts";
import { formatEntryTime, formatEntryTimeFull } from "../lib/timestamps.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import { type FileLinks, useFileLinks } from "../state/use-file-links.ts";
import type { SessionApi } from "../state/use-session.ts";
import { ClaudeRunSheet } from "./ClaudeRunSheet.tsx";
import { CodexRunSheet } from "./CodexRunSheet.tsx";
import { Icon } from "./Icon.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { Markdown } from "./Markdown.tsx";
import { PiRunCard } from "./PiRunCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";

interface Props {
  entries: TranscriptEntry[];
  processing: boolean;
  session: SessionApi;
  /** The runtime's working directory, used to shorten paths in tool summaries. */
  cwd: string | null;
  /** Open a workspace file the agent linked, in the app's file viewer. */
  onOpenFile: (path: string) => void;
  /** Label entries with their time; toggled in the filter sheet. */
  showTimestamps: boolean;
  /** "Edit" on your last message: put its text back in the composer. Stable. */
  onEditMessage: (text: string) => void;
  /** Send an AskUserQuestion answer (or dismissal) as an ordinary user message. */
  onAnswerQuestion: (response: AskUserQuestionResponse) => void;
}

const KIND_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Agent",
  reasoning: "Thinking",
  tool_call: "Tool",
  tool_return: "Result",
  system: "System",
  task: "Task",
  // Every tool call arrives as an `approval_request_message`, whether or not it
  // needed approving — the real prompt is the ApprovalSheet, driven by
  // `control_request`. Labelling these "Approval" implied a decision that was
  // never asked for, so they read as what they are.
  approval_request: "Tool",
  approval_response: "Approval",
  event: "Event",
  notice: "",
};

/** Pretty-print JSON tool arguments, falling back to the raw string mid-stream. */
function formatArgs(args: string | undefined): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** First non-blank line of a string, trimmed — the one-line preview. */
function firstLine(text: string | undefined): string {
  if (!text) return "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** A narration line as plain text for a one-line heading: no markdown marks. */
function plainLine(text: string): string {
  return firstLine(text)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** Clip to n characters with an ellipsis. */
function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function MessageList({
  entries,
  processing,
  session,
  cwd,
  onOpenFile,
  showTimestamps,
  onEditMessage,
  onAnswerQuestion,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileLinks = useFileLinks(session, cwd);
  // Auto-scroll only while the reader is at the bottom, so scrolling up to read
  // history is not yanked away by an incoming token.
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  stuckRef.current = stuck;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !stuckRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [entries, processing]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      setStuck(distance < 80);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Index every tool return by its call id, and note which returns get folded
  // into a call so the standalone entry is dropped from the list.
  //
  // Memoised on `entries`: these two passes are O(n) over the whole transcript,
  // and the list re-renders on every streamed token. Rebuilding them each time
  // also produced fresh Map/Set identities per render, which would defeat the
  // memo on the rows below for no reason.
  const { returnByCall, pairedReturnIds } = useMemo(() => {
    const byCall = new Map<string, TranscriptEntry>();
    for (const entry of entries) {
      if (entry.kind === "tool_return" && entry.toolCallId && !byCall.has(entry.toolCallId)) {
        byCall.set(entry.toolCallId, entry);
      }
    }
    const paired = new Set<string>();
    for (const entry of entries) {
      if ((entry.kind === "tool_call" || entry.kind === "approval_request") && entry.toolCallId) {
        const match = byCall.get(entry.toolCallId);
        if (match) paired.add(match.id);
      }
    }
    return { returnByCall: byCall, pairedReturnIds: paired };
  }, [entries]);

  // An AskUserQuestion answer is a task notification, and the question card
  // renders it read-only right where the question was asked — so its raw Task
  // card is redundant the moment a card for that tool call is on screen.
  const answersByCall = useMemo(() => {
    const answers = new Map<string, AskUserQuestionResponse>();
    const calls = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "question" && entry.toolCallId) calls.add(entry.toolCallId);
      if (entry.questionResponse)
        answers.set(entry.questionResponse.toolCallId, entry.questionResponse);
    }
    return { answers, calls };
  }, [entries]);

  // Paired returns render inside their call, so they leave the list before
  // grouping — otherwise a Bash call would count as two steps. Answered
  // questions drop their raw notification the same way.
  const items = useMemo(
    () =>
      groupTranscript(
        entries.filter(
          (entry) =>
            !(entry.kind === "tool_return" && entry.toolCallId && pairedReturnIds.has(entry.id)) &&
            !(entry.questionResponse && answersByCall.calls.has(entry.questionResponse.toolCallId)),
        ),
      ),
    [entries, pairedReturnIds, answersByCall],
  );

  // Steps fold once the turn is done. Only an explicit tap is remembered, so a
  // run that was open while live closes by itself when the answer lands.
  const [openSteps, setOpenSteps] = useState<ReadonlyMap<string, boolean>>(new Map());
  const lastItem = items.at(-1);
  const liveStepsId = processing && lastItem?.kind === "steps" ? lastItem.id : null;
  const toggleSteps = (id: string, open: boolean) =>
    setOpenSteps((current) => new Map(current).set(id, !open));

  // Only your latest message offers Edit: it is the one a resend replaces in
  // spirit, and an Edit on something older would read as rewriting history.
  const lastUserId = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.kind === "user" && !entry.reminder) return entry.id;
    }
    return null;
  }, [entries]);

  const renderEntry = (entry: TranscriptEntry, inRun = false) => (
    <MessageItem
      key={entry.id}
      entry={entry}
      narration={inRun && isNarration(entry)}
      retn={
        (entry.kind === "tool_call" || entry.kind === "approval_request") && entry.toolCallId
          ? (returnByCall.get(entry.toolCallId) ?? null)
          : null
      }
      answer={
        entry.kind === "question" && entry.toolCallId
          ? (answersByCall.answers.get(entry.toolCallId) ?? null)
          : null
      }
      onAnswerQuestion={onAnswerQuestion}
      cwd={cwd}
      fileLinks={fileLinks}
      onOpenFile={onOpenFile}
      showTimestamps={showTimestamps}
      onEdit={entry.id === lastUserId ? onEditMessage : undefined}
    />
  );

  return (
    <div className="messages-wrap">
      <div className="messages" ref={containerRef}>
        {entries.length === 0 && !processing ? (
          <p className="muted empty">No messages yet. Say something below.</p>
        ) : null}

        {items.map((item) => {
          if (item.kind !== "steps") return renderEntry(item.entry);
          const open = openSteps.get(item.id) ?? item.id === liveStepsId;
          return (
            <StepsGroup
              key={`steps:${item.id}`}
              item={item}
              open={open}
              onToggle={() => toggleSteps(item.id, open)}
              showTimestamps={showTimestamps}
            >
              {open ? item.entries.map((entry) => renderEntry(entry, true)) : null}
            </StepsGroup>
          );
        })}

        {/* No working dots here: the composer's "Agent is working" line is the
            one indicator, and unlike these it does not scroll away. */}
      </div>

      {!stuck ? (
        <button
          type="button"
          className="jump"
          onClick={() => {
            setStuck(true);
            const container = containerRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          }}
        >
          <Icon name="arrow-down" /> Latest
        </button>
      ) : null}
    </div>
  );
}

/**
 * Memoised. A streamed token re-renders the list, and without this every
 * message in a long conversation would re-parse its markdown per token.
 * `sortedEntries` shallow-copies the still-streaming entries so the one row
 * that is actually changing has a new identity and does re-render.
 */
const MessageItem = memo(function MessageItem({
  entry,
  retn,
  answer = null,
  onAnswerQuestion,
  cwd,
  fileLinks,
  onOpenFile,
  showTimestamps,
  onEdit,
  narration = false,
}: {
  entry: TranscriptEntry;
  /** For a tool call: its matching return, folded into the same block. */
  retn?: TranscriptEntry | null;
  /** For a question card: the answer already in the transcript, if any. */
  answer?: AskUserQuestionResponse | null;
  onAnswerQuestion: (response: AskUserQuestionResponse) => void;
  cwd: string | null;
  fileLinks: FileLinks;
  onOpenFile: (path: string) => void;
  showTimestamps: boolean;
  /** Set only on your latest message. */
  onEdit?: (text: string) => void;
  /** The agent's text between steps: a caption inside the run, not a bubble. */
  narration?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  // Index into `entry.images` of the image shown full-size, if any.
  const [zoom, setZoom] = useState<number | null>(null);
  const label = KIND_LABEL[entry.kind] ?? entry.kind;

  // Look up every filename this entry mentions so `Markdown` can link the real
  // ones. Skipped while the bubble is still streaming — a half-typed name would
  // just fill the miss cache.
  const { note } = fileLinks;
  const scan = !entry.streaming ? entry.text : "";
  useEffect(() => {
    if (!scan) return;
    const tokens = collectFileTokens(scan);
    if (tokens.length > 0) note(tokens);
  }, [scan, note]);

  const md = (text: string) => (
    <Markdown text={text} cwd={cwd} resolve={fileLinks.resolve} onOpenFile={onOpenFile} />
  );

  if (narration) {
    return (
      <div className="entry narration">
        <div className="bubble narration">{md(entry.text)}</div>
        {showTimestamps ? <EntryTime date={entry.date} /> : null}
      </div>
    );
  }

  if (entry.kind === "notice") {
    return (
      <div className={`entry notice ${entry.level ?? "info"}${entry.dim ? " dim" : ""}`}>
        <pre>{entry.text}</pre>
        {/* The provider's raw payload, kept reachable but out of the way — it
            names the real fault often enough to be worth one tap. */}
        {entry.detail ? (
          <>
            <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
              <span className="tag">Details</span>
              <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
            </button>
            {open ? <pre className="tool-args">{entry.detail}</pre> : null}
          </>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "pi_run" && entry.piRunId) {
    return <PiRunCard runId={entry.piRunId} />;
  }

  if (entry.kind === "question" && entry.question) {
    return <QuestionCard receipt={entry.question} response={answer} onSubmit={onAnswerQuestion} />;
  }

  if (entry.kind === "tool_call" || entry.kind === "approval_request") {
    const args = formatArgs(entry.toolArgs);
    // Mid-stream the argument JSON is truncated and unparseable, so the summary
    // is absent until the call is whole; the raw args carry the preview until then.
    const summary = summarizeToolCall(entry.toolName, parseToolArgs(entry.toolArgs), cwd);
    // The question's real UI is the card below the fold; the step itself is
    // just the machine record, so the receipt JSON stays out of the preview.
    const askedQuestion = entry.toolName === "AskUserQuestion";
    const inPreview = askedQuestion
      ? "Questions posted — answer on the card"
      : summary?.headline || firstLine(entry.toolArgs);
    // `retn` is the folded return; null means it has not arrived yet.
    const status = retn?.status ?? null;
    const outText = retn?.text ?? "";
    const stderr = retn?.stderr?.join("\n") ?? "";
    const showStderr = stderr.length > 0 && !outText.includes(stderr);
    const outPreview = askedQuestion
      ? ""
      : firstLine(outText) || (showStderr ? firstLine(stderr) : "");
    const hasBody = Boolean(args) || Boolean(outText) || showStderr;
    return (
      <div className={`entry tool${status === "error" ? " error" : ""}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasBody}
        >
          <code>{entry.toolName ?? "…"}</code>
          {inPreview ? (
            <span className={`grow-text summary${(summary?.mono ?? true) ? " mono" : ""}`}>
              {clip(inPreview, 200)}
            </span>
          ) : null}
          {status === "error" ? <span className="tag bad">error</span> : null}
          {hasBody ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {summary?.subtitle ? <p className="tool-subtitle">{summary.subtitle}</p> : null}
        {open ? (
          <div className="rail">
            {args ? <span className="rail-label">In</span> : null}
            {args ? <pre className="tool-args">{args}</pre> : null}
            {outText || showStderr ? <span className="rail-label">Out</span> : null}
            {outText ? <pre className="tool-args">{outText}</pre> : null}
            {showStderr ? <pre className="tool-args stderr">{stderr}</pre> : null}
            {!retn ? <span className="tool-peek">Running…</span> : null}
          </div>
        ) : outPreview ? (
          <div className="rail peek">
            <span className="rail-label">Out</span>
            <span className="tool-peek">{clip(outPreview, 200)}</span>
          </div>
        ) : !retn ? (
          <div className="rail peek">
            <span className="tool-peek">Running…</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "tool_return") {
    // stdout and stderr arrive separately on the running snapshot but not on
    // the canonical frame that replaces it, so `text` is the reliable body and
    // the streams are only shown when they add something it does not carry.
    const stderr = entry.stderr?.join("\n") ?? "";
    const showStderr = stderr.length > 0 && !entry.text.includes(stderr);
    const long = entry.text.length > 400;
    const shown = open || !long ? entry.text : `${entry.text.slice(0, 400)}…`;
    return (
      <div className={`entry tool_return ${entry.status ?? "success"}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
          {entry.toolName ? <code>{entry.toolName}</code> : null}
          {entry.status === "error" ? <span className="tag bad">error</span> : null}
          {long ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {shown || showStderr ? (
          <div className="rail">
            <span className="rail-label">Out</span>
            {shown ? <pre className="tool-args">{shown}</pre> : null}
            {showStderr ? <pre className="tool-args stderr">{stderr}</pre> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <div className="entry reasoning">
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="step-name">Thinking</span>
          <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {open ? <div className="bubble thinking">{md(entry.text)}</div> : null}
      </div>
    );
  }

  if (entry.kind === "task") {
    // Header always readable — what finished and whether it worked — with the
    // result body (genuine markdown) behind the same disclosure tool output uses.
    const hasResult = entry.text.trim().length > 0;
    // A Codex worker's report is only its last message; the run itself —
    // every command and its output — is in Codex's rollout (CodexRunSheet).
    const codexThread = codexThreadInTaskText(entry.text);
    // Same for a Claude Code worker, whose transcript Claude Code keeps itself.
    const claudeSession = claudeSessionInTaskText(entry.text);
    return (
      <div className="entry task">
        <button
          type="button"
          className="tool-head"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasResult}
        >
          <Icon name="task" />
          <span className="tag">Task</span>
          {entry.status ? (
            <span className={`tag${entry.status === "error" ? " bad" : " ok-tag"}`}>
              {entry.status === "error" ? "failed" : "completed"}
            </span>
          ) : null}
          <span className="grow-text">{entry.title ?? ""}</span>
          {hasResult ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {open && hasResult ? <div className="bubble task-result">{md(entry.text)}</div> : null}
        {codexThread ? (
          <button type="button" className="link small pad-x" onClick={() => setCodexOpen(true)}>
            Show Codex run
          </button>
        ) : null}
        {codexThread && codexOpen ? (
          <CodexRunSheet threadId={codexThread} onClose={() => setCodexOpen(false)} />
        ) : null}
        {claudeSession ? (
          <button type="button" className="link small pad-x" onClick={() => setClaudeOpen(true)}>
            Show Claude run
          </button>
        ) : null}
        {claudeSession && claudeOpen ? (
          <ClaudeRunSheet sessionId={claudeSession} onClose={() => setClaudeOpen(false)} />
        ) : null}
      </div>
    );
  }

  if (entry.reminder) {
    // Machine payload, not prose: shown verbatim rather than through Markdown,
    // which would swallow the tags and the paragraph after them.
    return (
      <div className="entry system reminder">
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="step-name">System reminder</span>
          <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {open ? <pre className="tool-args">{entry.text}</pre> : null}
      </div>
    );
  }

  // A subagent's reply is a step, not the answer; it keeps the plain label.
  const who = entry.kind === "user" ? "You" : entry.subagentId ? "Subagent" : label;
  return (
    <div className={`entry ${entry.kind}${entry.subagentId ? " subagent" : ""}`}>
      <div className="role">
        <span className="who">{who}</span>
        {/* Arrived from Telegram/Slack rather than typed here — still you. */}
        {entry.channel ? <span className="role-tag">via {entry.channel}</span> : null}
        {/* Sent with a JSON-schema constraint on the reply. Client-side only: the
            wire never carries it back, so it is absent on reloaded history. */}
        {entry.structured ? <span className="role-tag">structured</span> : null}
        {showTimestamps ? <EntryTime date={entry.date} /> : null}
        <span className="msg-actions">
          <CopyButton text={entry.text} />
          {onEdit ? (
            <button
              type="button"
              className="msg-action"
              onClick={() => onEdit(entry.text)}
              title="Edit and send again"
              aria-label="Edit and send again"
            >
              <Icon name="edit" />
            </button>
          ) : null}
        </span>
      </div>
      {entry.images && entry.images.length > 0 ? (
        // Thumbnails above the text; tap opens the full image in the app.
        // A data: URL cannot be navigated to (browsers refuse top-level
        // `data:` from a click), so the preview lives in this entry.
        <div className="msg-images">
          {entry.images.map((image, index) => (
            <button
              type="button"
              key={index}
              className="msg-image-thumb"
              onClick={() => setZoom(index)}
              aria-label={`View image ${index + 1} full size`}
            >
              {/* The button's aria-label is the accessible name; the image
                  itself is decorative beside it. */}
              <img src={image.dataUrl} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      {zoom !== null && entry.images?.[zoom] ? (
        <ImageLightbox
          src={entry.images[zoom].dataUrl}
          alt={`Image ${zoom + 1}`}
          onClose={() => setZoom(null)}
        />
      ) : null}
      {/* An image-only message has no text bubble to draw; the thumbnails are
          the message. */}
      {entry.text.trim() || !entry.images?.length ? (
        <div className={`bubble ${entry.kind}`}>{md(entry.text)}</div>
      ) : null}
    </div>
  );
});

/** A message's time: short in the header, the full date and time on hover. */
function EntryTime({ date }: { date: string }) {
  const short = formatEntryTime(date);
  if (!short) return null;
  return (
    <time dateTime={date} title={formatEntryTimeFull(date)}>
      {short}
    </time>
  );
}

/**
 * A run of the agent's work between two messages, folded to one line:
 * "▸ 11 steps · Thinking ×6 · Bash ×5". Open, it shows every step as before.
 */
function StepsGroup({
  item,
  open,
  onToggle,
  showTimestamps,
  children,
}: {
  item: Extract<TranscriptItem, { kind: "steps" }>;
  open: boolean;
  onToggle: () => void;
  showTimestamps: boolean;
  children: ReactNode;
}) {
  const total = item.steps;
  const summary = item.counts
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(" · ");
  const counts = (
    <>
      <span className="steps-count">
        {total} step{total === 1 ? "" : "s"}
      </span>
      {summary ? <span className="steps-summary">· {summary}</span> : null}
    </>
  );
  const headline = item.headline ? plainLine(item.headline) : "";
  return (
    <div className={`steps${open ? " open" : ""}${headline ? " headed" : ""}`}>
      <button type="button" className="steps-head" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
        {headline ? (
          // The turn's latest narration names the run; the counts go under it.
          <span className="steps-stack">
            <span className="steps-headline">{headline}</span>
            <span className="steps-line">{counts}</span>
          </span>
        ) : (
          counts
        )}
        {showTimestamps ? <EntryTime date={item.date} /> : null}
      </button>
      {children}
    </div>
  );
}

/** Copies a message's raw text; the icon turns into a tick for a moment. */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    <button
      type="button"
      className={`msg-action${state === "copied" ? " ok" : state === "failed" ? " bad" : ""}`}
      onClick={() => void copyText(text).then((ok) => setState(ok ? "copied" : "failed"))}
      title={label}
      aria-label={label}
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
    </button>
  );
}
