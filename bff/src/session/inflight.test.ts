import { describe, expect, test } from "bun:test";
import { classify, type InFlightEntry, InFlightJournal } from "./inflight.ts";

/**
 * The journal is the whole retry-after-close decision, so it is pinned here apart from any socket: what
 * may be sent again, what may only be reported, and what is too old to do either.
 */
function entry(over: Partial<InFlightEntry> = {}): InFlightEntry {
  return {
    requestId: "bff-s-1",
    originalId: "web-1",
    sessionId: "s",
    scopeKey: "agent-1::conv-1",
    frame: { type: "read_file", request_id: "bff-s-1" },
    kind: "retry",
    sentAt: 1_000,
    ...over,
  };
}

describe("classify", () => {
  test("an input whose message carries a client_message_id is safe to re-send", () => {
    // The listener de-dupes on exactly that id, which is what makes the re-send harmless.
    expect(
      classify({
        type: "input",
        request_id: "bff-1",
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hi", client_message_id: "cm-1" }],
        },
      }),
    ).toBe("retry");
  });

  test("an input without the de-dupable id is only reported", () => {
    expect(
      classify({
        type: "input",
        request_id: "bff-1",
        payload: { kind: "create_message", messages: [{ role: "user", content: "hi" }] },
      }),
    ).toBe("uncertain");
  });

  test("an input where any message lacks the id is only reported", () => {
    // One de-dupable message out of two would still run the second twice.
    expect(
      classify({
        type: "input",
        request_id: "bff-1",
        payload: {
          kind: "create_message",
          messages: [
            { role: "user", content: "a", client_message_id: "cm-1" },
            { role: "user", content: "b" },
          ],
        },
      }),
    ).toBe("uncertain");
  });

  test("a read is safe to re-send, a mutation is not", () => {
    expect(classify({ type: "read_file", request_id: "bff-1", path: "/work/a" })).toBe("retry");
    expect(classify({ type: "conversation_list", request_id: "bff-1" })).toBe("retry");
    expect(classify({ type: "sync", request_id: "bff-1" })).toBe("retry");
    expect(classify({ type: "write_file", request_id: "bff-1", path: "/work/a" })).toBe(
      "uncertain",
    );
    expect(classify({ type: "agent_update", request_id: "bff-1" })).toBe("uncertain");
  });

  test("a command with no request id is not journaled at all", () => {
    // Nothing can be answered back to its caller, so keeping it would only grow the journal.
    expect(
      classify({ type: "input", payload: { kind: "create_message", messages: [] } }),
    ).toBeNull();
    expect(classify({ type: "change_device_state" })).toBeNull();
  });
});

describe("InFlightJournal", () => {
  test("a settled request is no longer anyone's to retry", () => {
    const journal = new InFlightJournal();
    journal.record(entry());
    journal.settle("bff-s-1");
    expect(journal.size).toBe(0);
    expect(journal.takeForReconnect(2_000)).toEqual({
      resend: [],
      report: [],
      expired: [],
    });
  });

  test("closing a session drops everything it had in flight", () => {
    const journal = new InFlightJournal();
    journal.record(entry({ requestId: "a", sessionId: "s1" }));
    journal.record(entry({ requestId: "b", sessionId: "s2" }));
    journal.settleSession("s1");
    expect(journal.get("a")).toBeUndefined();
    expect(journal.get("b")).toBeDefined();
  });

  test("the journal is bounded, oldest first", () => {
    const journal = new InFlightJournal();
    for (let i = 0; i < 520; i += 1) journal.record(entry({ requestId: `r${i}` }));
    expect(journal.size).toBe(500);
    expect(journal.get("r0")).toBeUndefined();
    expect(journal.get("r519")).toBeDefined();
  });

  test("a reconnect re-sends what is eligible and reports what is not", () => {
    const journal = new InFlightJournal();
    journal.record(entry({ requestId: "read" }));
    journal.record(entry({ requestId: "write", kind: "uncertain" }));
    const pass = journal.takeForReconnect(2_000);
    expect(pass.resend.map((e) => e.requestId)).toEqual(["read"]);
    expect(pass.report.map((e) => e.requestId)).toEqual(["write"]);
    // Everything left the journal: a second reconnect cannot turn one request into two re-sends.
    expect(journal.size).toBe(0);
  });

  test("an entry older than the TTL is dropped rather than replayed", () => {
    const journal = new InFlightJournal();
    journal.record(entry({ requestId: "old" }));
    const pass = journal.takeForReconnect(1_000 + 25_001, 25_000);
    expect(pass.resend).toEqual([]);
    expect(pass.report).toEqual([]);
    expect(pass.expired.map((e) => e.requestId)).toEqual(["old"]);
  });

  test("a frame already re-sent once is reported on the next drop, never re-sent twice", () => {
    // The same one-retry rule upstream uses: a second attempt cannot tell "not delivered" from
    // "delivered twice".
    const journal = new InFlightJournal();
    journal.record(entry({ requestId: "twice", resent: true }));
    const pass = journal.takeForReconnect(2_000);
    expect(pass.resend).toEqual([]);
    expect(pass.report.map((e) => e.requestId)).toEqual(["twice"]);
  });
});
