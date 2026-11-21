/**
 * Reading a conversation's history out of the app-server.
 *
 * `conversation_messages_list` is a paged, newest-first endpoint: one call
 * answers with a page and a cursor (`next_before`) plus `has_more`, and it never
 * complains when the caller stops reading. Asking for one page of a long
 * conversation therefore *silently loses its beginning* — the transcript renders
 * as if nothing were missing, and the reader cannot tell the difference between
 * "this is the whole conversation" and "the oldest 800 messages were dropped".
 * That is what this module exists to prevent: it pages back to the floor, and it
 * says honestly whether older messages are still out there.
 *
 * The floor is not politeness. Each page is a round trip and each message is a
 * transcript row, so paging all the way through a four-thousand-message
 * conversation would spend both before the reader has scrolled anywhere. What is
 * loaded automatically is capped; what is beyond it becomes a visible choice
 * ("Load older messages") rather than an invisible loss.
 */

/** How many messages one request asks for. */
export const HISTORY_PAGE_SIZE = 200;

/** How many messages a cold start loads on its own before the wall appears. */
export const HISTORY_MESSAGE_FLOOR = 1000;

/** The SPA's session `request`, narrowed to what paging needs. */
export type HistoryRequest = <T = Record<string, unknown>>(
  type: string,
  body?: Record<string, unknown>,
) => Promise<T>;

interface PageResponse {
  messages?: unknown[];
  has_more?: boolean;
  next_before?: string | null;
}

export interface HistoryPage {
  /** Newest-first, exactly as the endpoint answered. */
  messages: unknown[];
  hasMore: boolean;
  nextBefore: string | null;
}

/** One page, oldest end marked by `before` (exclusive). */
export async function fetchHistoryPage(
  request: HistoryRequest,
  conversationId: string,
  before?: string | null,
): Promise<HistoryPage> {
  const response = await request<PageResponse>("conversation_messages_list", {
    conversation_id: conversationId,
    query: { limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) },
  });
  const messages = Array.isArray(response?.messages) ? response.messages : [];
  return {
    messages,
    hasMore: response?.has_more === true,
    nextBefore: typeof response?.next_before === "string" ? response.next_before : null,
  };
}

export interface HistoryLoad extends HistoryPage {
  /** Older messages exist and were deliberately not loaded. */
  partial: boolean;
}

/**
 * The identity a record is deduped by — its kind and id, not its id alone.
 *
 * Two records in one conversation can share an `id`, and the transcript keeps both
 * by namespaceing them on kind (see `historyKey` in `messages.ts`). Deduping on the
 * bare id here would drop the second one before it ever reached that step, which
 * would re-create the silent loss this whole path exists to prevent.
 */
function identityOf(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { id?: unknown; message_type?: unknown };
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const kind = typeof record.message_type === "string" ? record.message_type : "";
  return `${kind}\u0000${record.id}`;
}

/** Append a page to a newest-first pile, skipping any record already held. */
function append(into: unknown[], seen: Set<string>, page: readonly unknown[]): number {
  let added = 0;
  for (const message of page) {
    const identity = identityOf(message);
    // A record with no id cannot be recognised as a repeat, so it is kept: losing
    // a message to a dedupe is worse than showing one twice.
    if (identity !== null) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    into.push(message);
    added += 1;
  }
  return added;
}

/**
 * Add an older page to a newest-first pile.
 *
 * The pile is rebuilt rather than mutated so a caller can try the merge and throw
 * the result away if the request it came from has since been superseded.
 */
export function appendOlderPage(
  into: readonly unknown[],
  page: readonly unknown[],
): { messages: unknown[]; added: number } {
  const messages = into.slice();
  const seen = new Set<string>();
  for (const message of messages) {
    const identity = identityOf(message);
    if (identity !== null) seen.add(identity);
  }
  return { messages, added: append(messages, seen, page) };
}

/**
 * Read a conversation's history, newest-first, up to `floor` messages.
 *
 * `onPage` runs with the pile after the pages arrive, so the caller can paint the
 * newest page immediately instead of holding a blank transcript through every round
 * trip. It is deliberately called once, not per page: every commit rebuilds the
 * transcript and re-renders every row, so a fifth page would cost a fifth full
 * render for messages the reader has not asked for yet.
 *
 * `partial` is true whenever older messages are known to exist with a cursor to
 * reach them — including the case where that cursor stops answering. Claiming a
 * transcript is complete when the server said there was more is the silent
 * truncation this module exists to prevent, so it is reported as partial and the
 * caller keeps offering the wall.
 */
export async function loadHistoryPages(
  request: HistoryRequest,
  conversationId: string,
  options: {
    floor?: number;
    onPage?: (messages: unknown[], page: HistoryPage) => void;
  } = {},
): Promise<HistoryLoad> {
  const floor = options.floor ?? HISTORY_MESSAGE_FLOOR;
  const messages: unknown[] = [];
  const seen = new Set<string>();

  let page = await fetchHistoryPage(request, conversationId);
  append(messages, seen, page.messages);
  let { hasMore, nextBefore } = page;
  options.onPage?.(messages.slice(), page);

  while (hasMore && nextBefore && messages.length < floor) {
    page = await fetchHistoryPage(request, conversationId, nextBefore);
    const added = append(messages, seen, page.messages);
    hasMore = page.hasMore;
    nextBefore = page.nextBefore;
    // A cursor the server does not recognise answers with the newest page again
    // (measured against the local backend), so paging on it would loop and show the
    // same messages twice. Stop — but do not call that the end of the conversation:
    // `has_more` said otherwise, and the wall stays up.
    if (added === 0) break;
  }

  return { messages, hasMore, nextBefore, partial: hasMore && nextBefore !== null };
}
