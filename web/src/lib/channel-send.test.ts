import { describe, expect, test } from "bun:test";
import { channelLabel, readChannelSend } from "./channel-send.ts";
import {
  groupTranscript,
  sortedEntries,
  type Transcript,
  type TranscriptEntry,
} from "./messages.ts";

/**
 * The fixtures are the wire text itself, not a paraphrase of it:
 * `Message sent to telegram (message_id: …)` is what
 * `letta-code/src/channels/telegram/message-action-contract.ts` returns, and the
 * failure strings are the executor's own (`…/message-channel-executor.ts`),
 * which is also what sets `is_error` — the app-server then reports the return
 * with `status: "error"`, which is the only failure signal the UI gets.
 */

let seq = 0;
function call(args: unknown, over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  seq += 1;
  return {
    id: `call-${seq}`,
    kind: "tool_call",
    date: new Date(seq).toISOString(),
    seenAt: seq,
    text: "",
    toolName: "MessageChannel",
    toolCallId: `tc-${seq}`,
    toolArgs: typeof args === "string" ? args : JSON.stringify(args),
    ...over,
  };
}

function retn(status: "success" | "error", text: string, toolCallId: string): TranscriptEntry {
  seq += 1;
  return {
    id: `ret-${seq}`,
    kind: "tool_return",
    date: new Date(seq).toISOString(),
    seenAt: seq,
    text,
    toolCallId,
    status,
    toolName: "MessageChannel",
  };
}

const SEND_ARGS = { channel: "telegram", action: "send", message: "Morning digest." };
const SENT = "Message sent to telegram (message_id: 123)";
const FAILED = "Error: Sending message to telegram failed: 403 Forbidden";

describe("readChannelSend", () => {
  test("a delivered send carries destination, body and the sent state", () => {
    const c = call(SEND_ARGS);
    const send = readChannelSend(c, retn("success", SENT, c.toolCallId!));
    expect(send).toEqual({
      channel: "telegram",
      action: "send",
      body: "Morning digest.",
      delivery: "sent",
    });
  });

  test("an errored return is a failed delivery, not a missing one", () => {
    const c = call(SEND_ARGS);
    expect(readChannelSend(c, retn("error", FAILED, c.toolCallId!))?.delivery).toBe("failed");
  });

  test("no return is pending — the card may not claim a send the channel has not taken", () => {
    expect(readChannelSend(call(SEND_ARGS), null)?.delivery).toBe("pending");
  });

  test("only outbound actions produce a card", () => {
    // The same tool reacts, binds threads and downloads files; none of those is
    // a message, and a "sent" badge on a reaction would be a lie.
    for (const action of ["react", "download-file", "update-binding", "list-custom-emojis"]) {
      expect(readChannelSend(call({ channel: "telegram", action, message: "x" }), null)).toBeNull();
    }
    // The actions that are outbound: send, rich send, and an attachment.
    expect(readChannelSend(call({ ...SEND_ARGS, action: "send-rich" }), null)).not.toBeNull();
    expect(readChannelSend(call({ channel: "telegram", action: "upload-file" }), null)).toBeNull();
    expect(
      readChannelSend(
        call({ channel: "telegram", action: "upload-file", filename: "chart.png" }),
        null,
      )?.body,
    ).toBe("chart.png");
  });

  test("a half-streamed call whose args will not parse yields no card", () => {
    // Mid-stream the argument JSON is truncated (see MessageList's summary note).
    const c = call('{"channel":"telegram","action":"send","message":"Morning d');
    expect(readChannelSend(c, null)).toBeNull();
  });

  test("a send with neither a message nor a file yields no card", () => {
    expect(readChannelSend(call({ channel: "telegram", action: "send" }), null)).toBeNull();
  });

  test("channelLabel capitalises the wire id", () => {
    expect(channelLabel("telegram")).toBe("Telegram");
    expect(channelLabel("")).toBe("Channel");
  });
});

/** A Transcript as the store holds it: keyed by id, ordered by seenAt. */
function transcriptOf(entries: TranscriptEntry[]): Transcript {
  const t: Transcript = new Map();
  for (const e of entries) t.set(e.id, e);
  return t;
}

describe("channel send promotion", () => {
  test("the send is promoted to its own entry, right after the call", () => {
    const c = call(SEND_ARGS);
    const entries = sortedEntries(transcriptOf([c, retn("success", SENT, c.toolCallId!)]));
    const cards = entries.filter((e) => e.kind === "channel_send");
    expect(cards).toHaveLength(1);
    expect(entries.indexOf(cards[0]!)).toBe(entries.indexOf(c) + 1);
    expect(cards[0]!.channelSend?.delivery).toBe("sent");
    expect(cards[0]!.id).toBe(`channel-send:${c.toolCallId}`);
  });

  test("the raw call and its return stay put — the card is added, not swapped in", () => {
    const c = call(SEND_ARGS);
    const r = retn("success", SENT, c.toolCallId!);
    const entries = sortedEntries(transcriptOf([c, r]));
    expect(entries.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(entries.filter((e) => e.kind === "tool_return")).toHaveLength(1);
  });

  test("one call gets one card however many flushes recompute it", () => {
    const c = call(SEND_ARGS);
    const r = retn("success", SENT, c.toolCallId!);
    const once = sortedEntries(transcriptOf([c, r]));
    const twice = sortedEntries(transcriptOf([c, r]));
    expect(twice.filter((e) => e.kind === "channel_send")).toHaveLength(1);
    expect(once.map((e) => e.id)).toEqual(twice.map((e) => e.id));
  });

  test("a non-MessageChannel return is untouched", () => {
    const bash: TranscriptEntry = {
      id: "b1",
      kind: "tool_call",
      date: new Date().toISOString(),
      seenAt: 1,
      text: "",
      toolName: "Bash",
      toolCallId: "b1c",
      toolArgs: JSON.stringify({ command: "ls" }),
    };
    const entries = sortedEntries(
      transcriptOf([
        bash,
        { ...retn("success", "total 0", "b1c"), toolName: "Bash", toolCallId: "b1c" },
      ]),
    );
    expect(entries.some((e) => e.kind === "channel_send")).toBe(false);
  });

  test("a subagent's send stays scoped to that subagent", () => {
    const c = call(SEND_ARGS, { subagentId: "sub-1" });
    const card = sortedEntries(transcriptOf([c])).find((e) => e.kind === "channel_send");
    expect(card?.subagentId).toBe("sub-1");
  });
});

describe("channel send grouping", () => {
  test("the card never folds inside a collapsed run", () => {
    // A step before and after the send: the card must stand alone, not join the
    // run — the same guarantee a pending question gets.
    const before = call({ channel: "telegram", action: "react", message: "x" });
    const send = call(SEND_ARGS);
    const after = call({ channel: "telegram", action: "react", message: "y" });
    const items = groupTranscript(sortedEntries(transcriptOf([before, send, after])));
    const kinds = items.map((i) => (i.kind === "message" ? i.entry.kind : i.kind));
    expect(kinds).toContain("channel_send");
    for (const item of items) {
      if (item.kind === "steps") {
        expect(item.entries.some((e) => e.kind === "channel_send")).toBe(false);
      }
    }
  });
});
