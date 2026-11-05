import { describe, expect, test } from "bun:test";
import { channelLabel, readChannelSend } from "./channel-send.ts";
import {
  applyStreamDelta,
  createStreamIndex,
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

  test("the card reads delivery from status, never from the return's wording", () => {
    // Live returns are not always the canonical
    // `Message sent to telegram (message_id: …)` — the app-server also answers
    // `Message sent to Telegram` with no ids at all. Paraphrasing that string
    // would drop the card on real data, so only `status` decides.
    const c = call(SEND_ARGS);
    expect(
      readChannelSend(c, retn("success", "Message sent to Telegram", c.toolCallId!))?.delivery,
    ).toBe("sent");
    // A failure naming the channel in caps is still a failure.
    const c2 = call(SEND_ARGS);
    expect(
      readChannelSend(
        c2,
        retn("error", "Error: Sending message to Telegram failed: bot blocked", c2.toolCallId!),
      )?.delivery,
    ).toBe("failed");
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
    // Never double-capitalize a destination the wire already capitalized.
    expect(channelLabel("Telegram")).toBe("Telegram");
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

/* ── The wire shape, not a hand-built one ──────────────────────────────────
 * These drive `applyStreamDelta` with real frames instead of assembling
 * `TranscriptEntry` objects by hand. The first version of this feature shipped
 * with hand-built `kind: "tool_call"` fixtures and passed every test while the
 * running app showed nothing: a tool call reaches the client as an
 * `approval_request_message` whether or not it needed approval, so the guard
 * that accepted only `tool_call` matched no real traffic. Any future test here
 * that does not go through the wire is testing a shape the app never sees.
 */

function streamed(frames: unknown[]): Transcript {
  const transcript: Transcript = new Map();
  const index = createStreamIndex();
  frames.forEach((frame, seq) => {
    applyStreamDelta(transcript, index, frame, seq);
  });
  return transcript;
}

function callFrame(id: string, toolCallId: string, args: object) {
  return {
    type: "message",
    message_type: "approval_request_message",
    id,
    date: "2026-11-05T10:42:00.000Z",
    tool_call: {
      tool_call_id: toolCallId,
      name: "MessageChannel",
      arguments: JSON.stringify(args),
    },
  };
}

function returnFrame(id: string, toolCallId: string, status: "success" | "error", text: string) {
  return {
    type: "message",
    message_type: "tool_return_message",
    id,
    date: "2026-11-05T10:42:01.000Z",
    status,
    tool_call_id: toolCallId,
    tool_return: text,
    tool_returns: [{ tool_call_id: toolCallId, status, tool_return: text }],
  };
}

describe("channel send on the wire", () => {
  test("an approval_request_message send gets the card — the shape the app actually gets", () => {
    const entries = sortedEntries(
      streamed([
        callFrame("msg-call-1", "tc-1", SEND_ARGS),
        returnFrame("msg-ret-1", "tc-1", "success", SENT),
      ]),
    );
    const card = entries.find((e) => e.kind === "channel_send");
    expect(card?.channelSend?.delivery).toBe("sent");
    expect(card?.channelSend?.body).toBe("Morning digest.");
  });

  test("a failed wire send is marked failed", () => {
    const entries = sortedEntries(
      streamed([
        callFrame("msg-call-2", "tc-2", SEND_ARGS),
        returnFrame("msg-ret-2", "tc-2", "error", FAILED),
      ]),
    );
    expect(entries.find((e) => e.kind === "channel_send")?.channelSend?.delivery).toBe("failed");
  });

  test("the card arrives with the call, before its return lands", () => {
    const entries = sortedEntries(streamed([callFrame("msg-call-3", "tc-3", SEND_ARGS)]));
    expect(entries.find((e) => e.kind === "channel_send")?.channelSend?.delivery).toBe("pending");
  });

  test("one call gets one card even if both call frames show up for it", () => {
    const both = streamed([
      callFrame("msg-call-4", "tc-4", SEND_ARGS),
      { ...callFrame("msg-call-4b", "tc-4", SEND_ARGS), message_type: "tool_call_message" },
      returnFrame("msg-ret-4", "tc-4", "success", SENT),
    ]);
    expect(sortedEntries(both).filter((e) => e.kind === "channel_send")).toHaveLength(1);
  });

  test("an approval_request frame for another tool gets nothing", () => {
    const entries = sortedEntries(
      streamed([
        {
          ...callFrame("msg-call-5", "tc-5", { command: "ls" }),
          tool_call: { tool_call_id: "tc-5", name: "Bash", arguments: '{"command":"ls"}' },
        },
        returnFrame("msg-ret-5", "tc-5", "success", "total 0"),
      ]),
    );
    expect(entries.some((e) => e.kind === "channel_send")).toBe(false);
  });
});
