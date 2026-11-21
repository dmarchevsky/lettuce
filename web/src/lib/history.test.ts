import { describe, expect, test } from "bun:test";
import {
  appendOlderPage,
  fetchHistoryPage,
  HISTORY_PAGE_SIZE,
  type HistoryRequest,
  loadHistoryPages,
  olderPageStalled,
} from "./history.ts";

/**
 * A stand-in for `conversation_messages_list`: a list of pages, each keyed by the
 * cursor that fetches it (`p1` is the first page, `p2` what `next_before` hands
 * back for it), answering in the shape the endpoint does.
 */
function server(
  pages: { messages: { id: string }[]; has_more: boolean; next_before: string | null }[],
) {
  const calls: (string | null)[] = [];
  const request = (async (_type: string, body?: Record<string, unknown>) => {
    const query = (body?.query ?? {}) as { before?: string; limit?: number };
    const cursor = query.before ?? null;
    calls.push(cursor);
    const index = cursor === null ? 0 : Number(cursor.slice(1)) - 1;
    return pages[index] ?? { messages: [], has_more: false, next_before: null };
  }) as HistoryRequest;
  return { request, calls };
}

const msgs = (...ids: string[]) => ids.map((id) => ({ id }));

describe("fetchHistoryPage", () => {
  test("asks for a page and reports what the cursor said", async () => {
    const { request, calls } = server([
      { messages: msgs("a", "b"), has_more: true, next_before: "p2" },
    ]);
    const page = await fetchHistoryPage(request, "conv-1");
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe("p2");
    expect(calls).toEqual([null]);
  });

  test("sends the page size the module owns, and the cursor when there is one", async () => {
    const seen: Record<string, unknown>[] = [];
    const request = (async (_type: string, body?: Record<string, unknown>) => {
      seen.push(body ?? {});
      return { messages: [], has_more: false, next_before: null };
    }) as HistoryRequest;
    await fetchHistoryPage(request, "conv-1");
    await fetchHistoryPage(request, "conv-1", "older-id");
    expect(seen[0]).toEqual({
      conversation_id: "conv-1",
      query: { limit: HISTORY_PAGE_SIZE },
    });
    expect(seen[1]).toEqual({
      conversation_id: "conv-1",
      query: { limit: HISTORY_PAGE_SIZE, before: "older-id" },
    });
  });

  test("a malformed answer is an empty page, not a crash", async () => {
    const request = (async () => ({ messages: "nope" })) as unknown as HistoryRequest;
    const page = await fetchHistoryPage(request, "conv-1");
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe("loadHistoryPages", () => {
  test("one page that says it is all, is all", async () => {
    const { request, calls } = server([
      { messages: msgs("c", "b", "a"), has_more: false, next_before: null },
    ]);
    const loaded = await loadHistoryPages(request, "conv-1");
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["c", "b", "a"]);
    expect(loaded.partial).toBe(false);
    expect(loaded.stalled).toBe(false);
    expect(calls).toEqual([null]);
  });

  test("follows next_before until the endpoint runs out", async () => {
    const { request, calls } = server([
      { messages: msgs("e", "d"), has_more: true, next_before: "p2" },
      { messages: msgs("c", "b"), has_more: true, next_before: "p3" },
      { messages: msgs("a"), has_more: false, next_before: null },
    ]);
    const loaded = await loadHistoryPages(request, "conv-1");
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["e", "d", "c", "b", "a"]);
    expect(loaded.partial).toBe(false);
    expect(calls).toEqual([null, "p2", "p3"]);
  });

  test("stops at the floor and says older messages are still out there", async () => {
    const { request, calls } = server([
      { messages: msgs("f", "e", "d"), has_more: true, next_before: "p2" },
      { messages: msgs("c", "b", "a"), has_more: true, next_before: "p3" },
      { messages: msgs("z"), has_more: true, next_before: "p4" },
    ]);
    const loaded = await loadHistoryPages(request, "conv-1", { floor: 4 });
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual([
      "f",
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
    // The third page was never asked for: the floor was reached with a usable
    // cursor still in hand, which is the one state that earns a wall.
    expect(calls).toEqual([null, "p2"]);
    expect(loaded.partial).toBe(true);
    expect(loaded.nextBefore).toBe("p3");
  });

  test("a cursor the server does not know stops the read, and is still reported partial", async () => {
    // Measured against the local backend: an unknown `before` answers with the
    // newest page again rather than refusing, so paging on it would never end.
    // Stopping is right; calling that a complete transcript would be the silent
    // truncation this module exists to prevent, because `has_more` said otherwise.
    const page = { messages: msgs("c", "b"), has_more: true, next_before: "p2" };
    const { request, calls } = server([page, page]);
    const loaded = await loadHistoryPages(request, "conv-1", { floor: 100 });
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["c", "b"]);
    expect(calls).toEqual([null, "p2"]);
    expect(loaded.partial).toBe(true);
    expect(loaded.stalled).toBe(true);
  });

  test("hands back the newest page and leaves the rest to the final commit", async () => {
    // Every commit re-renders the whole list, so the caller gets one early paint
    // (the newest page, so the transcript is not blank) and then the whole pile.
    const { request } = server([
      { messages: msgs("f", "e"), has_more: true, next_before: "p2" },
      { messages: msgs("d", "c"), has_more: true, next_before: "p3" },
      { messages: msgs("b", "a"), has_more: false, next_before: null },
    ]);
    const sizes: number[] = [];
    await loadHistoryPages(request, "conv-1", {
      onPage: (messages) => sizes.push(messages.length),
    });
    expect(sizes).toEqual([2]);
  });

  test("the pile handed to onPage is a copy", async () => {
    const { request } = server([
      { messages: msgs("c", "b"), has_more: true, next_before: "p2" },
      { messages: msgs("a"), has_more: false, next_before: null },
    ]);
    let firstLength = 0;
    await loadHistoryPages(request, "conv-1", {
      onPage: (messages) => {
        if (firstLength === 0) firstLength = messages.length;
      },
    });
    expect(firstLength).toBe(2);
  });
});

describe("olderPageStalled", () => {
  test("a page that adds nothing while more is promised is a dead cursor", () => {
    expect(olderPageStalled({ hasMore: true }, 0)).toBe(true);
  });

  test("a page that brings messages is not", () => {
    expect(olderPageStalled({ hasMore: true }, 200)).toBe(false);
  });

  test("the end of the conversation is not", () => {
    expect(olderPageStalled({ hasMore: false }, 0)).toBe(false);
  });
});

describe("appendOlderPage", () => {
  test("puts an older page under what is held and counts what is new", () => {
    const held = msgs("d", "c");
    const merged = appendOlderPage(held, msgs("b", "a"));
    expect(merged.added).toBe(2);
    expect(merged.messages.map((m) => (m as { id: string }).id)).toEqual(["d", "c", "b", "a"]);
    // The pile handed in is never mutated: a caller can discard the merge.
    expect(held.map((m) => (m as { id: string }).id)).toEqual(["d", "c"]);
  });

  test("drops records the pile already holds", () => {
    const merged = appendOlderPage(msgs("d", "c"), msgs("c", "b"));
    expect(merged.added).toBe(1);
    expect(merged.messages.map((m) => (m as { id: string }).id)).toEqual(["d", "c", "b"]);
  });

  test("keeps a record with no id rather than losing it to a dedupe", () => {
    const merged = appendOlderPage([{ id: "x" }, {}], [{}, { id: "y" }]);
    expect(merged.messages).toHaveLength(4);
  });

  test("two records sharing one id are two records, not a repeat", () => {
    // The transcript keeps both by namespaceing them on kind, so the paging dedupe
    // has to agree — deduping on the bare id here would drop one before it ever
    // got there, which is the loss `historyKey` exists to prevent.
    const merged = appendOlderPage(
      [{ id: "dup", message_type: "assistant_message" }],
      [{ id: "dup", message_type: "user_message" }],
    );
    expect(merged.added).toBe(1);
    expect(merged.messages).toHaveLength(2);
  });

  test("the same record arriving again is dropped", () => {
    const merged = appendOlderPage(
      [{ id: "dup", message_type: "user_message" }],
      [{ id: "dup", message_type: "user_message" }],
    );
    expect(merged.messages).toHaveLength(1);
  });
});
