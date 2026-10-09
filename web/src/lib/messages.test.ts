import { describe, expect, test } from "bun:test";
import { prepareAskUserQuestionNotif } from "@letta-ai/letta-code/ask-user-question";
import {
  addLocalUserMessage,
  applyStreamDelta,
  createStreamIndex,
  FILTER_ORDER,
  type FilterGroup,
  filterEntries,
  groupTranscript,
  isShown,
  mergeTurnErrors,
  readContentParts,
  readQuestionReceipt,
  settleStreaming,
  sortedEntries,
  splitErrorDetail,
  stripInjectedBlocks,
  type Transcript,
  type TranscriptEntry,
  toggleShown,
  transcriptFromHistory,
} from "./messages.ts";

function streamed(deltas: unknown[]): Transcript {
  const transcript: Transcript = new Map();
  const index = createStreamIndex();
  deltas.forEach((delta, seq) => {
    applyStreamDelta(transcript, index, delta, seq);
  });
  return transcript;
}

/**
 * One assistant text delta exactly as the local backend puts it on the wire.
 *
 * `id` is minted fresh per chunk by `createStoredChunk`, which also strips the
 * provider's own id; `otid` is memoized per contiguous content segment and is
 * the only field stable across a message. A real capture showed 98 deltas with
 * 98 distinct ids and 1 otid.
 */
let wireSeq = 400;
function textDelta(otid: string, text: string, messageType = "assistant_message") {
  wireSeq += 1;
  const key = messageType === "reasoning_message" ? "reasoning" : "content";
  return {
    type: "message",
    id: `letta-msg-${wireSeq}`,
    date: new Date(wireSeq).toISOString(),
    message_type: messageType,
    otid,
    [key]: messageType === "reasoning_message" ? text : [{ type: "text", text }],
  };
}

describe("streaming accumulation", () => {
  test("assistant text fragments concatenate into one entry", () => {
    // Every delta carries a DIFFERENT id and the SAME otid — the real wire.
    const transcript = streamed([
      textDelta("provider-assistant-1-aaa", "Hel"),
      textDelta("provider-assistant-1-aaa", "lo "),
      textDelta("provider-assistant-1-aaa", "there"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Hello there");
    expect(entries[0]!.kind).toBe("assistant");
  });

  test("a new otid starts a new entry", () => {
    const transcript = streamed([
      textDelta("provider-assistant-1-aaa", "first"),
      textDelta("provider-assistant-3-bbb", "second"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("reasoning deltas group by otid too", () => {
    const transcript = streamed([
      textDelta("provider-reasoning-0-ccc", "think", "reasoning_message"),
      textDelta("provider-reasoning-0-ccc", "ing", "reasoning_message"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("thinking");
    expect(entries[0]!.kind).toBe("reasoning");
  });

  test("a delta with an otid but no id is kept, not dropped", () => {
    const transcript = streamed([
      { type: "message", message_type: "assistant_message", otid: "o1", content: "raw " },
      { type: "message", message_type: "assistant_message", otid: "o1", content: "chunk" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("raw chunk");
  });

  test("a stream mixing id-only and otid-only chunks stays one entry", () => {
    const transcript = streamed([
      { type: "message", id: "m1", message_type: "assistant_message", otid: "o9", content: "a" },
      { type: "message", id: "m1", message_type: "assistant_message", content: "b" },
      { type: "message", message_type: "assistant_message", otid: "o9", content: "c" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("abc");
  });

  test("assistant and reasoning sharing one otid do not merge", () => {
    const transcript = streamed([
      textDelta("shared-otid", "spoken"),
      textDelta("shared-otid", "thought", "reasoning_message"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind).sort()).toEqual(["assistant", "reasoning"]);
  });

  test("tool call arguments accumulate across deltas", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "letta-msg-500",
        date: "d",
        message_type: "tool_call_message",
        otid: "provider-tool-0-ddd",
        tool_call: { name: "Read", tool_call_id: "c1", arguments: '{"path":' },
      },
      {
        type: "message",
        id: "letta-msg-501",
        date: "d",
        message_type: "tool_call_message",
        otid: "provider-tool-0-ddd",
        tool_call: { arguments: '"/tmp/x"}' },
      },
    ]);
    const entry = sortedEntries(transcript)[0]!;
    expect(entry.toolName).toBe("Read");
    expect(entry.toolCallId).toBe("c1");
    expect(entry.toolArgs).toBe('{"path":"/tmp/x"}');
  });

  test("content arrays flatten to text", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "u1",
        date: "d",
        message_type: "user_message",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    ]);
    expect(sortedEntries(transcript)[0]!.text).toBe("part one part two");
  });

  test("history replaces rather than appends, so a replay cannot double text", () => {
    const history = transcriptFromHistory([
      { id: "m1", date: "d", message_type: "assistant_message", content: "Hello there" },
      { id: "m1", date: "d", message_type: "assistant_message", content: "Hello there" },
    ]);
    expect(sortedEntries(history)[0]!.text).toBe("Hello there");
  });

  test("tool returns carry status", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "r1",
        date: "d",
        message_type: "tool_return_message",
        tool_call_id: "c1",
        status: "error",
        tool_return: "boom",
      },
    ]);
    const entry = sortedEntries(transcript)[0]!;
    expect(entry.status).toBe("error");
    expect(entry.text).toBe("boom");
  });

  test("hidden reasoning is marked redacted", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "h1",
        date: "d",
        message_type: "hidden_reasoning_message",
        state: "redacted",
      },
    ]);
    expect(sortedEntries(transcript)[0]!.redacted).toBe(true);
  });

  test("ordering follows first appearance, not id", () => {
    const transcript = streamed([
      { type: "message", id: "zzz", date: "d", message_type: "user_message", content: "first" },
      {
        type: "message",
        id: "aaa",
        date: "d",
        message_type: "assistant_message",
        content: "second",
      },
    ]);
    expect(sortedEntries(transcript).map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("settleStreaming clears in-flight markers", () => {
    const transcript = streamed([
      { type: "message", id: "m1", date: "d", message_type: "assistant_message", content: "hi" },
    ]);
    expect(sortedEntries(transcript)[0]!.streaming).toBe(true);
    settleStreaming(transcript);
    expect(sortedEntries(transcript)[0]!.streaming).toBe(false);
  });
});

describe("lifecycle notices", () => {
  test("errors and retries surface with a level", () => {
    const transcript = streamed([
      { message_type: "loop_error", id: "e1", date: "d", message: "context overflow" },
      { message_type: "retry", id: "r1", date: "d", message: "retrying in 2s" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries.map((e) => e.level)).toEqual(["error", "warning"]);
  });

  test("bare start markers are dropped", () => {
    const transcript = streamed([
      { message_type: "command_start", id: "c1", date: "d", command_id: "clear", input: "" },
    ]);
    expect(sortedEntries(transcript)).toHaveLength(0);
  });

  test("command output renders with its command name", () => {
    const transcript = streamed([
      {
        message_type: "command_end",
        id: "c1",
        date: "d",
        command_id: "compact",
        input: "",
        output: "done",
        success: true,
      },
    ]);
    expect(sortedEntries(transcript)[0]!.text).toBe("/compact\ndone");
  });
});

/**
 * One failure emits two loop_error deltas — a non-terminal one while the stream
 * drains and a terminal one at the stop, carrying the same text because the
 * local backend fills a chunk's `message` and `detail` from one normalized
 * error. Both carry their own lifecycle uuid, so only the text plus the run can
 * tell them apart from a genuine second failure.
 */
describe("duplicated error notices", () => {
  const DEVICE_LOST = "decode() failed: vk::Queue::submit: ErrorDeviceLost";

  const loopError = (id: string, message: string, runId?: string) => ({
    message_type: "loop_error",
    id,
    date: "d",
    message,
    ...(runId ? { run_id: runId } : {}),
  });

  test("the terminal half folds into the non-terminal one", () => {
    const transcript = streamed([
      loopError("lifecycle-a", DEVICE_LOST, "local-run-37"),
      loopError("lifecycle-b", DEVICE_LOST, "local-run-37"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe(DEVICE_LOST);
    expect(entries[0]!.level).toBe("error");
  });

  test("the surviving entry keeps the first one's position", () => {
    const transcript = streamed([
      loopError("lifecycle-a", DEVICE_LOST, "local-run-37"),
      { message_type: "status", id: "s1", date: "d", message: "wrapping up" },
      loopError("lifecycle-b", DEVICE_LOST, "local-run-37"),
    ]);
    expect(sortedEntries(transcript).map((e) => e.text)).toEqual([DEVICE_LOST, "wrapping up"]);
  });

  test("the same error in a different run stays its own entry", () => {
    const transcript = streamed([
      loopError("lifecycle-a", DEVICE_LOST, "local-run-37"),
      loopError("lifecycle-b", DEVICE_LOST, "local-run-38"),
    ]);
    expect(sortedEntries(transcript)).toHaveLength(2);
  });

  test("without a run id, only an adjacent repeat folds", () => {
    const adjacent = streamed([
      loopError("lifecycle-a", DEVICE_LOST),
      loopError("lifecycle-b", DEVICE_LOST),
    ]);
    expect(sortedEntries(adjacent)).toHaveLength(1);

    // Something else happened in between, so this is a second failure, not the
    // terminal half of the first: both errors survive, either side of the status.
    const separated = streamed([
      loopError("lifecycle-a", DEVICE_LOST),
      { message_type: "status", id: "s1", date: "d", message: "retrying" },
      loopError("lifecycle-b", DEVICE_LOST),
    ]);
    expect(sortedEntries(separated).map((e) => e.text)).toEqual([
      DEVICE_LOST,
      "retrying",
      DEVICE_LOST,
    ]);

    // An assistant message counts as "something else" too — the turn carried on.
    const afterReply = streamed([
      loopError("lifecycle-a", DEVICE_LOST),
      { type: "message", id: "a1", date: "d", message_type: "assistant_message", content: "hi" },
      loopError("lifecycle-b", DEVICE_LOST),
    ]);
    expect(afterReply.size).toBe(3);
  });

  test("different error text in the same run stays two entries", () => {
    const transcript = streamed([
      loopError("lifecycle-a", DEVICE_LOST, "local-run-37"),
      loopError("lifecycle-b", "context window exceeded", "local-run-37"),
    ]);
    expect(sortedEntries(transcript)).toHaveLength(2);
  });

  test("status and retry notices are untouched", () => {
    const transcript = streamed([
      { message_type: "status", id: "s1", date: "d", message: "same" },
      { message_type: "status", id: "s2", date: "d", message: "same" },
      { message_type: "retry", id: "r1", date: "d", message: "same" },
      { message_type: "retry", id: "r2", date: "d", message: "same" },
    ]);
    expect(sortedEntries(transcript)).toHaveLength(4);
  });
});

describe("filtering", () => {
  const transcript = streamed([
    { type: "message", id: "u", date: "d", message_type: "user_message", content: "u" },
    { type: "message", id: "a", date: "d", message_type: "assistant_message", content: "a" },
    { type: "message", id: "rs", date: "d", message_type: "reasoning_message", reasoning: "r" },
    {
      type: "message",
      id: "t",
      date: "d",
      message_type: "tool_call_message",
      tool_call: { name: "Bash" },
    },
    { type: "message", id: "s", date: "d", message_type: "system_message", content: "s" },
  ]);
  const entries = sortedEntries(transcript);

  test("no active filters shows everything", () => {
    expect(filterEntries(entries, new Set())).toHaveLength(5);
  });

  test("reasoning groups with agent responses", () => {
    const agent = filterEntries(entries, new Set<FilterGroup>(["agent"]));
    expect(agent.map((e) => e.id).sort()).toEqual(["a", "rs"]);
  });

  test("tools and system are separable", () => {
    expect(filterEntries(entries, new Set<FilterGroup>(["tools"])).map((e) => e.id)).toEqual(["t"]);
    expect(filterEntries(entries, new Set<FilterGroup>(["system"])).map((e) => e.id)).toEqual([
      "s",
    ]);
  });
});

describe("system-reminder extraction", () => {
  // The opening line is what react-markdown swallows when the tag reaches it,
  // so every assertion below checks it explicitly.
  const REMINDER =
    "<system-reminder>\nThis is an automated message providing context about the user's environment.\n\nMore detail here.\n</system-reminder>";

  test("a reminder is split out of the user message as a System entry", () => {
    const transcript = transcriptFromHistory([
      {
        id: "u1",
        message_type: "user_message",
        content: [{ type: "text", text: `${REMINDER}\n\nWhat is the weather?` }],
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(["system", "user"]);
    expect(entries[0]!.text).toContain("This is an automated message");
    expect(entries[0]!.text).not.toContain("<system-reminder>");
    expect(entries[1]!.text).toBe("What is the weather?");
  });

  test("a reminder-only message produces no empty user entry", () => {
    const transcript = transcriptFromHistory([
      { id: "u2", message_type: "user_message", content: REMINDER },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("system");
  });

  test("letta-guide blocks are extracted the same way", () => {
    const transcript = transcriptFromHistory([
      {
        id: "u3",
        message_type: "user_message",
        content: "<letta-guide>\n# Skill Directory\nstuff\n</letta-guide>\nhello",
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toContain("Skill Directory");
    expect(entries[1]!.text).toBe("hello");
  });

  test("extraction survives a reminder arriving across streaming deltas", () => {
    const transcript = streamed([
      { type: "message", id: "a", otid: "o1", message_type: "user_message", content: "<system-" },
      {
        type: "message",
        id: "b",
        otid: "o1",
        message_type: "user_message",
        content: "reminder>\nbody text\n</system-",
      },
      {
        type: "message",
        id: "c",
        otid: "o1",
        message_type: "user_message",
        content: "reminder>\nreal question",
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toBe("body text");
    expect(entries[1]!.text).toBe("real question");
  });

  test("reminders join the System filter group, not You", () => {
    const transcript = transcriptFromHistory([
      { id: "u4", message_type: "user_message", content: `${REMINDER}\n\nhi` },
    ]);
    const entries = sortedEntries(transcript);
    const system = filterEntries(entries, new Set<FilterGroup>(["system"]));
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toContain("This is an automated message");
    const you = filterEntries(entries, new Set<FilterGroup>(["user"]));
    expect(you).toHaveLength(1);
    expect(you[0]!.text).toBe("hi");
  });

  test("a plain user message is untouched", () => {
    const transcript = transcriptFromHistory([
      { id: "u5", message_type: "user_message", content: "just a question" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[0]!.text).toBe("just a question");
  });
});

describe("local user echo", () => {
  test("the user's own message shows immediately", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-123", "tell me about your capabilities", 0);

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[0]!.text).toBe("tell me about your capabilities");
    expect(entries[0]!.streaming).toBe(false);
  });

  test("a later server echo lands on the same entry, not a second one", () => {
    // The queued path DOES echo, carrying otid === client_message_id.
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-123", "hello", 0);

    applyStreamDelta(
      transcript,
      index,
      {
        type: "message",
        id: "user-msg-abc",
        otid: "web-123",
        message_type: "user_message",
        content: "hello",
      },
      1,
    );

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("hello");
  });

  test("a chunked echo replaces once, then accumulates", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-9", "placeholder", 0);

    const echo = (content: string, seq: number) =>
      applyStreamDelta(
        transcript,
        index,
        {
          type: "message",
          id: `user-msg-${seq}`,
          otid: "web-9",
          message_type: "user_message",
          content,
        },
        seq,
      );
    echo("real ", 1);
    echo("text", 2);

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    // First chunk replaced the local placeholder; the second appended.
    expect(entries[0]!.text).toBe("real text");
  });

  test("history reload replaces the local entry with the server record", () => {
    const transcript = transcriptFromHistory([
      { id: "ui-msg-16", message_type: "user_message", content: "hello" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.local).toBeUndefined();
  });
});

describe("history ordering", () => {
  test("newest-first history renders oldest-first", () => {
    // conversation_messages_list returns descending by date.
    const transcript = transcriptFromHistory([
      { id: "m3", message_type: "assistant_message", content: "third" },
      { id: "m2", message_type: "user_message", content: "second" },
      { id: "m1", message_type: "assistant_message", content: "first" },
    ]);
    expect(sortedEntries(transcript).map((e) => e.text)).toEqual(["first", "second", "third"]);
  });

  test("a question sorts above the answer it prompted", () => {
    const transcript = transcriptFromHistory([
      { id: "a1", message_type: "assistant_message", content: "Here is the answer" },
      { id: "u1", message_type: "user_message", content: "What is it?" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[1]!.kind).toBe("assistant");
  });
});

describe("task notifications", () => {
  /** Captured verbatim from local-conv-38; only the result prose is truncated. */
  const TASK = `<task-notification>
<task-id>task_2</task-id>
<status>completed</status>
<summary>Agent "Search weather in Redmond, WA using DuckDuckGo MCP" completed</summary>
<result>subagent_type=general-purpose subagent_id=subagent-1787612610887-2 subagent_status=success agent_id=agent-local-1ccda99b-db50-424f-91f9-6b09771512bf conversation_id=default

The requested command to l
…truncated for the fixture…</result>
<usage>total_tokens: 146416
tool_uses: 9
duration_ms: 972873</usage>
</task-notification>
Full transcript available at: /tmp/letta-background-tRlfjO/task_2.log`;

  const entriesFor = (text: string) =>
    sortedEntries(
      transcriptFromHistory([{ id: "u1", message_type: "user_message", content: text }]),
    );

  test("the real payload becomes one Task entry, not a user message", () => {
    const entries = entriesFor(TASK);
    expect(entries).toHaveLength(1);
    const task = entries[0]!;
    expect(task.kind).toBe("task");
    expect(task.taskId).toBe("task_2");
    expect(task.status).toBe("success");
    expect(task.title).toBe('Agent "Search weather in Redmond, WA using DuckDuckGo MCP" completed');
    // No XML survives into anything rendered.
    expect(task.text).not.toContain("<result>");
    expect(task.text).not.toContain("</task-notification>");
    expect(task.text).toContain("subagent_type=general-purpose");
  });

  test("it lands in the Tasks filter group, not You", () => {
    const entries = entriesFor(TASK);
    expect(filterEntries(entries, new Set<FilterGroup>(["tasks"]))).toHaveLength(1);
    expect(filterEntries(entries, new Set<FilterGroup>(["user"]))).toHaveLength(0);
  });

  test("the trailing transcript pointer does not leak as a user message", () => {
    // Upstream appends this line OUTSIDE the closing tag.
    const entries = entriesFor(`${TASK}\nFull transcript available at: /tmp/letta/task_2.log`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("task");
  });

  test("the Monitor variant has no status, so it must not read as failed", () => {
    const entries = entriesFor(
      "<task-notification>\n<task-id>task_9</task-id>\n<summary>Monitor fired</summary>\n<result><event>errors in deploy.log</event></result>\n</task-notification>",
    );
    const task = entries[0]!;
    expect(task.kind).toBe("task");
    expect(task.status).toBeUndefined();
    expect(task.title).toBe("Monitor fired");
  });

  test("the reflection variant is summary-only and still renders", () => {
    const entries = entriesFor(
      "<task-notification><summary>Reflection complete</summary><reflection-agent-id>agent-x</reflection-agent-id></task-notification>",
    );
    const task = entries[0]!;
    expect(task.kind).toBe("task");
    expect(task.title).toBe("Reflection complete");
    expect(task.text).toBe("");
  });

  test("a notification with no summary still produces a usable card", () => {
    const entries = entriesFor("<task-notification>something unparseable</task-notification>");
    expect(entries[0]!.kind).toBe("task");
    expect(entries[0]!.title).toContain("something unparseable");
  });

  test("a task notification never titles a conversation", () => {
    expect(stripInjectedBlocks(TASK)).toBe("");
  });
});

describe("skill blocks with open-ended tag names", () => {
  const entriesFor = (text: string) =>
    sortedEntries(
      transcriptFromHistory([{ id: "u1", message_type: "user_message", content: text }]),
    );

  test("an arbitrary skill id is treated as injected, not typed", () => {
    // The tag name IS the skill id, so there is no fixed list to match.
    const entries = entriesFor("<some-other-skill>\n# Skill Directory\nbody\n</some-other-skill>");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toContain("Skill Directory");
  });

  test("ordinary prose containing a < is left alone", () => {
    // The case that would wreck real messages.
    for (const text of ["is 3 < 5 or not?", "use <div> in html", "a < b and c > d"]) {
      const entries = entriesFor(text);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.kind).toBe("user");
      expect(entries[0]!.text).toBe(text);
    }
  });

  test("a message that is only an HTML tag stays a user message", () => {
    const entries = entriesFor("<p>hello</p>");
    expect(entries[0]!.kind).toBe("user");
  });
});

describe("channel messages", () => {
  test("an inbound channel message stays yours, labelled with the channel", () => {
    const entries = sortedEntries(
      transcriptFromHistory([
        {
          id: "u1",
          message_type: "user_message",
          content:
            '<channel-notification channel="telegram"><mention>what is the weather?</mention></channel-notification>',
        },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[0]!.channel).toBe("telegram");
    expect(filterEntries(entries, new Set<FilterGroup>(["user"]))).toHaveLength(1);
  });
});

/**
 * A tool return exactly as a live turn puts it on the wire.
 *
 * Captured from a real turn against the running app-server: ONE Bash call
 * produced TWO frames with different ids — a `synthetic-tool-return-stream-…`
 * snapshot while the command ran, then a `synthetic-tool-return-<uuid>`
 * canonical one — and both carried the singular fields AND a `tool_returns`
 * array. Neither carries an `otid`.
 */
function toolReturnFrame(
  id: string,
  toolCallId: string,
  status: "success" | "error",
  text: string,
  streams?: { stdout?: string[]; stderr?: string[] },
) {
  return {
    type: "message",
    message_type: "tool_return_message",
    id,
    date: "2026-08-29T02:46:21.743Z",
    run_id: "local-run-40",
    status,
    tool_call_id: toolCallId,
    tool_return: text,
    tool_returns: [{ tool_call_id: toolCallId, status, tool_return: text, ...streams }],
  };
}

function toolCallFrame(id: string, toolCallId: string, name: string, args: string) {
  return {
    type: "message",
    message_type: "approval_request_message",
    id,
    date: "2026-08-29T02:46:21.690Z",
    tool_call: { tool_call_id: toolCallId, name, arguments: args },
  };
}

describe("tool returns", () => {
  test("repeated snapshots of one call collapse into a single entry", () => {
    const transcript = streamed([
      toolReturnFrame("synthetic-tool-return-stream-abc", "abc", "success", "hi", {
        stdout: ["hi"],
      }),
      toolReturnFrame("synthetic-tool-return-uuid-1", "abc", "success", "hi\n"),
    ]);

    const returns = sortedEntries(transcript).filter((entry) => entry.kind === "tool_return");
    expect(returns).toHaveLength(1);
    expect(returns[0]?.text).toBe("hi\n");
  });

  test("the corrected status on the later frame wins", () => {
    // The running snapshot reports success even for a command that then failed;
    // only the canonical frame that follows says error.
    const transcript = streamed([
      toolReturnFrame("synthetic-tool-return-stream-def", "def", "success", "ls: cannot access", {
        stderr: ["ls: cannot access"],
      }),
      toolReturnFrame(
        "synthetic-tool-return-uuid-2",
        "def",
        "error",
        "Exit code: 2\nls: cannot access\n",
      ),
    ]);

    const returns = sortedEntries(transcript).filter((entry) => entry.kind === "tool_return");
    expect(returns).toHaveLength(1);
    expect(returns[0]?.status).toBe("error");
  });

  test("a streamed return and its history record land on the same key", () => {
    const live = streamed([
      toolReturnFrame("synthetic-tool-return-stream-ghi", "ghi", "success", "out"),
    ]);
    const history = transcriptFromHistory([
      {
        message_type: "tool_return_message",
        id: "ui-msg-719",
        date: "2026-08-29T02:46:21.796Z",
        tool_call_id: "ghi",
        status: "success",
        tool_return: "out",
      },
    ]);

    const liveId = sortedEntries(live)[0]?.id;
    expect(liveId).toBeDefined();
    expect(sortedEntries(history)[0]?.id).toBe(liveId as string);
  });

  test("one interrupt frame settling several calls expands to one entry each", () => {
    const transcript = streamed([
      {
        type: "message",
        message_type: "tool_return_message",
        id: "lifecycle-interrupt",
        date: "2026-08-29T02:46:21.796Z",
        tool_returns: [
          { tool_call_id: "one", status: "error", tool_return: "Interrupted by user" },
          { tool_call_id: "two", status: "error", tool_return: "Interrupted by user" },
        ],
      },
    ]);

    const returns = sortedEntries(transcript).filter((entry) => entry.kind === "tool_return");
    expect(returns).toHaveLength(2);
    expect(returns.map((entry) => entry.toolCallId).sort()).toEqual(["one", "two"]);
  });

  test("a return is named after the call it answers", () => {
    const transcript = streamed([
      toolCallFrame("letta-msg-1", "abc", "Bash", '{"command":"echo hi"}'),
      toolReturnFrame("synthetic-tool-return-stream-abc", "abc", "success", "hi"),
    ]);

    const returns = sortedEntries(transcript).filter((entry) => entry.kind === "tool_return");
    expect(returns[0]?.toolName).toBe("Bash");
  });

  test("a return with no tool_call_id anywhere is dropped rather than mis-keyed", () => {
    const transcript = streamed([
      {
        type: "message",
        message_type: "tool_return_message",
        id: "orphan",
        tool_return: "nothing to attach this to",
      },
    ]);
    expect(sortedEntries(transcript)).toHaveLength(0);
  });
});

describe("provider error notices", () => {
  test("lifts the model's own message out of a raw JSON body", () => {
    expect(
      splitErrorDetail(
        '500 status code (no body)\n{"error":{"code":500,"message":"vk::Queue::submit: ErrorDeviceLost","type":"server_error"}}',
      ),
    ).toEqual({
      headline: "vk::Queue::submit: ErrorDeviceLost",
      detail:
        '{"error":{"code":500,"message":"vk::Queue::submit: ErrorDeviceLost","type":"server_error"}}',
    });
  });

  test("a plain sentence is left alone and gains no detail", () => {
    expect(splitErrorDetail("Request timed out.")).toEqual({ headline: "Request timed out." });
  });

  test("a JSON body with no message still keeps the prose headline", () => {
    expect(splitErrorDetail('Connection refused\n{"code":"ECONNREFUSED"}')).toEqual({
      headline: "Connection refused",
      detail: '{"code":"ECONNREFUSED"}',
    });
  });

  test("something that only looks like JSON is not lost", () => {
    const result = splitErrorDetail("{not actually json");
    expect(result.headline).toBe("{not actually json");
  });

  test("loop_error notices carry the headline and the payload separately", () => {
    const transcript: Transcript = new Map();
    applyStreamDelta(
      transcript,
      createStreamIndex(),
      {
        message_type: "loop_error",
        id: "lifecycle-1",
        message: 'Error\n{"error":{"message":"context window exceeded"}}',
      },
      0,
    );

    const notice = sortedEntries(transcript)[0];
    expect(notice?.text).toBe("context window exceeded");
    expect(notice?.detail).toBe('{"error":{"message":"context window exceeded"}}');
    expect(notice?.level).toBe("error");
  });
});

describe("mergeTurnErrors", () => {
  // Newest first, as conversation_messages_list returns them.
  const history = () =>
    transcriptFromHistory([
      {
        id: "a2",
        date: "2026-09-25T16:39:05Z",
        message_type: "assistant_message",
        content: "Done",
      },
      {
        id: "a1",
        date: "2026-09-25T14:40:00Z",
        message_type: "assistant_message",
        content: "Scanning",
      },
      { id: "u1", date: "2026-09-25T14:31:18Z", message_type: "user_message", content: "Run it" },
    ]);

  test("a failed turn lands between the entries it happened between", () => {
    const transcript = history();
    mergeTurnErrors(transcript, [
      {
        turn_id: "t1",
        run_id: "run-1",
        error: "Conversation is still busy",
        at: "2026-09-25T16:38:42.803Z",
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries.map((e) => e.text)).toEqual([
      "Run it",
      "Scanning",
      "Conversation is still busy",
      "Done",
    ]);
    expect(entries[2]?.level).toBe("error");
    expect(entries[2]?.kind).toBe("notice");
  });

  test("a provider body is demoted to the detail", () => {
    const transcript = history();
    mergeTurnErrors(transcript, [
      {
        turn_id: "t1",
        run_id: null,
        error: 'Boom\n{"error":{"message":"device lost"}}',
        at: "2026-09-25T17:00:00Z",
      },
    ]);
    const last = sortedEntries(transcript).at(-1);
    expect(last?.text).toBe("device lost");
    expect(last?.detail).toContain("device lost");
  });

  test("an error older than all history goes first; a bad date is skipped", () => {
    const transcript = history();
    mergeTurnErrors(transcript, [
      { turn_id: "old", run_id: null, error: "early", at: "2026-09-24T00:00:00Z" },
      { turn_id: "bad", run_id: null, error: "nope", at: "not a date" },
    ]);
    const texts = sortedEntries(transcript).map((e) => e.text);
    expect(texts[0]).toBe("early");
    expect(texts).not.toContain("nope");
  });
});

describe("groupTranscript", () => {
  let n = 0;
  const e = (
    kind: TranscriptEntry["kind"],
    extra: Partial<TranscriptEntry> = {},
  ): TranscriptEntry => ({
    id: `e${++n}`,
    kind,
    date: "2026-09-25T15:08:00Z",
    seenAt: n,
    text: "x",
    ...extra,
  });

  test("steps between messages fold into one run with per-label counts", () => {
    const items = groupTranscript([
      e("user"),
      e("reasoning"),
      e("approval_request", { toolName: "Bash" }),
      e("reasoning"),
      e("approval_request", { toolName: "Bash" }),
      e("tool_call", { toolName: "Read" }),
      e("assistant"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "steps", "message"]);
    const steps = items[1];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.entries).toHaveLength(5);
    expect(steps.counts).toEqual([
      ["Thinking", 2],
      ["Bash", 2],
      ["Read", 1],
    ]);
  });

  test("a notice stands alone and splits the run around it", () => {
    const items = groupTranscript([
      e("reasoning"),
      e("notice", { level: "error" }),
      e("reasoning"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps", "notice", "steps"]);
  });

  test("reminders and subagent replies are steps, not messages", () => {
    const items = groupTranscript([
      e("system", { reminder: true }),
      e("assistant", { subagentId: "sub-1" }),
      e("user"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps", "message"]);
    const steps = items[0];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.counts).toEqual([
      ["Reminder", 1],
      ["Subagent", 1],
    ]);
  });

  test("a run keeps its id and start date as it grows at the tail", () => {
    const first = e("reasoning", { date: "2026-09-25T15:08:00Z" });
    const before = groupTranscript([first]);
    const after = groupTranscript([first, e("tool_call", { date: "2026-09-25T15:09:00Z" })]);
    expect(before[0]).toMatchObject({ kind: "steps", id: first.id, date: first.date });
    expect(after[0]).toMatchObject({ kind: "steps", id: first.id, date: first.date });
  });

  test("blank agent text between tool calls is dropped and the runs join", () => {
    // The stored shape: [thinking, toolCall, "\n", toolCall] per step.
    const items = groupTranscript([
      e("user"),
      e("reasoning"),
      e("tool_call", { toolName: "Read" }),
      e("assistant", { text: "\n" }),
      e("tool_call", { toolName: "Read" }),
      e("reasoning"),
      e("assistant", { text: "  " }),
      e("tool_call", { toolName: "Read" }),
      e("assistant", { text: "Done." }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "steps", "message"]);
    const steps = items[1];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.steps).toBe(5);
    expect(steps.headline).toBeUndefined();
  });

  test("narration folds into the turn's one run, headed by the latest line", () => {
    const first = e("assistant", { text: "Evidence loaded. Checking scan:" });
    const second = e("assistant", { text: "Scan done. Selecting the batch:" });
    const answer = e("assistant", { text: "Drafted two resumes." });
    const items = groupTranscript([
      e("user"),
      e("reasoning"),
      first,
      e("tool_call", { toolName: "Bash" }),
      second,
      e("tool_call", { toolName: "Bash" }),
      answer,
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "steps", "message"]);
    const steps = items[1];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.entries.map((x) => x.id)).toContain(first.id);
    expect(steps.steps).toBe(3);
    expect(steps.counts).toEqual([
      ["Thinking", 1],
      ["Bash", 2],
    ]);
    expect(steps.headline).toBe("Scan done. Selecting the batch:");
    expect(items[2]).toMatchObject({ kind: "message", entry: { id: answer.id } });
  });

  test("an answer stays an answer when the next turn starts with a task or reminder", () => {
    for (const next of [e("task"), e("system", { reminder: true }), e("user")]) {
      const answer = e("assistant", { text: "Awaiting scan." });
      const items = groupTranscript([e("reasoning"), answer, next, e("reasoning")]);
      expect(items.some((i) => i.kind === "message" && i.entry.id === answer.id)).toBe(true);
    }
  });

  test("live, the newest text is an answer until a step follows it", () => {
    const text = e("assistant", { text: "Fetching:" });
    const live = groupTranscript([e("user"), e("reasoning"), text]);
    expect(live.at(-1)).toMatchObject({ kind: "message", entry: { id: text.id } });
    const later = groupTranscript([e("user"), e("reasoning"), text, e("tool_call")]);
    expect(later.map((i) => i.kind)).toEqual(["message", "steps"]);
  });

  test("a subagent's reply is still a counted step, never narration", () => {
    const items = groupTranscript([
      e("assistant", { subagentId: "sub-1" }),
      e("tool_call", { toolName: "Bash" }),
    ]);
    const steps = items[0];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.steps).toBe(2);
    expect(steps.headline).toBeUndefined();
  });
});

describe("toggleShown (the Filter sheet: ticked = shown)", () => {
  const everything = new Set<FilterGroup>();
  test("from everything, unticking hides only that group", () => {
    const next = toggleShown(everything, "tools");
    expect([...next].sort()).toEqual(["agent", "system", "tasks", "user"]);
    expect(isShown(next, "tools")).toBe(false);
    expect(isShown(next, "user")).toBe(true);
  });
  test("ticking the last hidden group returns to the empty 'everything' set", () => {
    expect(toggleShown(toggleShown(everything, "tools"), "tools").size).toBe(0);
  });
  test("the last shown group cannot be unticked", () => {
    const onlyUser = new Set<FilterGroup>(["user"]);
    expect([...toggleShown(onlyUser, "user")]).toEqual(["user"]);
  });
  test("every box reads ticked when nothing is filtered", () => {
    for (const group of FILTER_ORDER) expect(isShown(everything, group)).toBe(true);
  });
});

describe("image content parts", () => {
  const imagePart = {
    type: "image",
    source: { type: "base64", media_type: "image/webp", data: "aW1hZ2U=" },
  };
  const imageExpectation = {
    mediaType: "image/webp",
    dataUrl: "data:image/webp;base64,aW1hZ2U=",
  };

  test("readContentParts reads text parts and lifts base64 images", () => {
    expect(readContentParts("plain")).toEqual({ text: "plain", images: [] });
    expect(
      readContentParts([
        { type: "text", text: "look " },
        imagePart,
        { type: "text", text: "here" },
      ]),
    ).toEqual({ text: "look here", images: [imageExpectation] });
  });

  test("readContentParts skips malformed and non-renderable parts", () => {
    expect(
      readContentParts([
        null,
        "string part",
        { type: "image", source: { type: "url", url: "https://x/y.png" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
        { type: "text" },
      ]),
    ).toEqual({ text: "string part", images: [] });
  });

  test("history records carry image parts onto the entry", () => {
    const transcript = transcriptFromHistory([
      {
        id: "u1",
        message_type: "user_message",
        content: [{ type: "text", text: "what is this?" }, imagePart],
      },
    ]);
    expect(transcript.get("u1")?.images).toEqual([imageExpectation]);
    expect(transcript.get("u1")?.text).toBe("what is this?");
  });

  test("the queued echo replaces the local echo's images with the server's copy", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    const localImages = [{ mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bG9jYWw=" }];
    addLocalUserMessage(transcript, index, "web-9", "look", 0, false, localImages);
    expect(transcript.get("web-9")?.images).toEqual(localImages);

    // The dequeued echo arrives under the same otid with the normalized bytes.
    wireSeq += 1;
    applyStreamDelta(
      transcript,
      index,
      {
        type: "message",
        id: `letta-msg-${wireSeq}`,
        date: new Date(wireSeq).toISOString(),
        message_type: "user_message",
        otid: "web-9",
        content: [{ type: "text", text: "look" }, imagePart],
      },
      1,
    );

    const entry = transcript.get("web-9");
    expect(entry?.text).toBe("look"); // not doubled
    expect(entry?.images).toEqual([imageExpectation]);
  });

  test("a text-only frame does not erase images already on the entry", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    const localImages = [{ mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bG9jYWw=" }];
    addLocalUserMessage(transcript, index, "web-10", "hi", 0, false, localImages);
    wireSeq += 1;
    applyStreamDelta(
      transcript,
      index,
      {
        type: "message",
        id: `letta-msg-${wireSeq}`,
        date: new Date(wireSeq).toISOString(),
        message_type: "user_message",
        otid: "web-10",
        content: [{ type: "text", text: "hi" }],
      },
      1,
    );
    expect(transcript.get("web-10")?.images).toEqual(localImages);
  });
});

describe("async AskUserQuestion (0.34.1 receipt flow)", () => {
  const QUESTIONS = [
    {
      question: "Which approach?",
      header: "Approach",
      options: [
        { label: "A", description: "the A way" },
        { label: "B", description: "the B way" },
      ],
      multiSelect: false,
    },
  ];
  const RECEIPT = {
    type: "ask_user_question",
    version: 2,
    toolCallId: "call-q1",
    questions: QUESTIONS,
    message: "Questions posted.",
  };

  const questionFrames = () => [
    toolCallFrame(
      "letta-msg-q",
      "call-q1",
      "AskUserQuestion",
      JSON.stringify({ questions: QUESTIONS }),
    ),
    toolReturnFrame("synthetic-tool-return-q", "call-q1", "success", JSON.stringify(RECEIPT)),
  ];

  test("a question receipt promotes a standalone question entry after its return", () => {
    const entries = sortedEntries(streamed(questionFrames()));
    const question = entries.find((entry) => entry.kind === "question");
    expect(question).toBeDefined();
    expect(question?.toolCallId).toBe("call-q1");
    expect(question?.question?.questions).toEqual(QUESTIONS);
    // The promoted entry sits immediately after the tool return it answers.
    const returnIndex = entries.findIndex((entry) => entry.kind === "tool_return");
    expect(entries.indexOf(question as TranscriptEntry)).toBe(returnIndex + 1);
  });

  test("history rebuild promotes the same question as live streaming", () => {
    const live = sortedEntries(streamed(questionFrames()));
    const history = transcriptFromHistory([
      {
        message_type: "tool_call_message",
        id: "h-q1",
        tool_call: {
          tool_call_id: "call-q1",
          name: "AskUserQuestion",
          arguments: JSON.stringify({ questions: QUESTIONS }),
        },
      },
      {
        message_type: "tool_return_message",
        id: "h-q2",
        tool_call_id: "call-q1",
        status: "success",
        tool_return: JSON.stringify(RECEIPT),
      },
    ]);
    // `date` differs between a wire capture and a fixture with no date, so
    // compare the identity that promotion has to agree on.
    const promoted = (list: TranscriptEntry[]) =>
      list
        .filter((e) => e.kind === "question")
        .map((e) => ({ id: e.id, toolCallId: e.toolCallId, question: e.question }));
    expect(promoted(sortedEntries(history))).toEqual(promoted(live));
  });

  test("the question stands alone in the transcript, never inside a steps run", () => {
    const items = groupTranscript(sortedEntries(streamed(questionFrames())));
    expect(items.map((item) => item.kind)).toEqual(["steps", "message"]);
    const message = items[1];
    expect(message?.kind === "message" && message.entry.kind).toBe("question");
  });

  test("a receipt for a different tool call id is not promoted", () => {
    const transcript = streamed([
      toolCallFrame("letta-msg-y", "call-q2", "AskUserQuestion", "{}"),
      toolReturnFrame(
        "r",
        "call-q2",
        "success",
        JSON.stringify({ ...RECEIPT, toolCallId: "someone-else" }),
      ),
    ]);
    expect(sortedEntries(transcript).some((entry) => entry.kind === "question")).toBe(false);
  });

  test("readQuestionReceipt rejects malformed returns", () => {
    const base: TranscriptEntry = {
      id: "x",
      kind: "tool_return",
      date: "",
      seenAt: 0,
      text: "",
      toolCallId: "call-q1",
      toolName: "AskUserQuestion",
    };
    expect(readQuestionReceipt(base)).toBeNull(); // empty text
    expect(
      readQuestionReceipt({ ...base, text: '{"ask_user_question": "not a receipt"}' }),
    ).toBeNull();
    expect(
      readQuestionReceipt({ ...base, text: JSON.stringify({ ...RECEIPT, questions: [] }) }),
    ).toBeNull(); // no questions
    expect(
      readQuestionReceipt({ ...base, toolName: "Bash", text: JSON.stringify(RECEIPT) }),
    ).toBeNull(); // named like some other tool
    expect(readQuestionReceipt({ ...base, text: JSON.stringify(RECEIPT) })).not.toBeNull();
  });

  const answerNotif = prepareAskUserQuestionNotif({
    type: "ask_user_question_response",
    version: 2,
    toolCallId: "call-q1",
    questions: QUESTIONS,
    status: "answered",
    answers: { "Which approach?": "A" },
  });

  test("the answer arrives as a task entry carrying the full response", () => {
    const entries = sortedEntries(
      transcriptFromHistory([{ id: "u-a", message_type: "user_message", content: answerNotif }]),
    );
    expect(entries).toHaveLength(1);
    const task = entries[0]!;
    expect(task.kind).toBe("task");
    expect(task.questionResponse?.status).toBe("answered");
    expect(task.questionResponse?.answers).toEqual({ "Which approach?": "A" });
    // Never rendered as a raw XML user bubble.
    expect(stripInjectedBlocks(answerNotif)).toBe("");
  });

  test("a dismissal parses with no answers", () => {
    const dismissed = prepareAskUserQuestionNotif({
      type: "ask_user_question_response",
      version: 2,
      toolCallId: "call-q1",
      questions: QUESTIONS,
      status: "dismissed",
    });
    const entries = sortedEntries(
      transcriptFromHistory([{ id: "u-d", message_type: "user_message", content: dismissed }]),
    );
    expect(entries[0]?.questionResponse?.status).toBe("dismissed");
    expect(entries[0]?.questionResponse?.answers).toBeUndefined();
  });

  test("an ordinary task notification carries no question response", () => {
    const entries = sortedEntries(
      transcriptFromHistory([
        {
          id: "u-t",
          message_type: "user_message",
          content:
            "<task-notification><task-id>t1</task-id><summary>Done</summary></task-notification>",
        },
      ]),
    );
    expect(entries[0]?.kind).toBe("task");
    expect(entries[0]?.questionResponse).toBeUndefined();
  });
});

describe("remote-pi run cards", () => {
  const entry = (over: Partial<TranscriptEntry> & { id: string; seenAt: number }) =>
    ({
      kind: "tool_return",
      date: "2026-01-01T00:00:00Z",
      text: "",
      ...over,
    }) as TranscriptEntry;

  test("a pi_run return gets its card entry right after it", () => {
    const runId = "0f4c3a2b-1111-4222-8333-444444444444";
    const transcript: Transcript = new Map([
      [
        "c",
        entry({ id: "c", seenAt: 1, kind: "tool_call", toolName: "pi_run", toolCallId: "call1" }),
      ],
      [
        "r",
        entry({
          id: "r",
          seenAt: 2,
          toolCallId: "call1",
          text: `Started remote-pi run ${runId} on worker@h`,
        }),
      ],
    ]);
    const entries = sortedEntries(transcript);
    expect(entries.map((e) => e.kind)).toEqual(["tool_call", "tool_return", "pi_run"]);
    expect(entries[2]?.piRunId).toBe(runId);
  });

  test("pi_wait about the same run adds no second card; other tools never match", () => {
    const runId = "0f4c3a2b-1111-4222-8333-444444444444";
    const other = "9e8d7c6b-5555-4aaa-8bbb-cccccccccccc";
    const transcript: Transcript = new Map([
      [
        "c",
        entry({ id: "c", seenAt: 1, kind: "tool_call", toolName: "pi_run", toolCallId: "call1" }),
      ],
      [
        "r",
        entry({
          id: "r",
          seenAt: 2,
          toolCallId: "call1",
          text: `Started remote-pi run ${runId} on worker@h`,
        }),
      ],
      [
        "wc",
        entry({ id: "wc", seenAt: 3, kind: "tool_call", toolName: "pi_wait", toolCallId: "call2" }),
      ],
      [
        "wr",
        entry({
          id: "wr",
          seenAt: 4,
          toolCallId: "call2",
          text: `run ${runId} — completed (exit 0)`,
        }),
      ],
      [
        "bc",
        entry({ id: "bc", seenAt: 5, kind: "tool_call", toolName: "Bash", toolCallId: "call3" }),
      ],
      ["br", entry({ id: "br", seenAt: 6, toolCallId: "call3", text: `wrote run ${other} notes` })],
    ]);
    const cards = sortedEntries(transcript).filter((e) => e.kind === "pi_run");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.piRunId).toBe(runId);
  });
});
