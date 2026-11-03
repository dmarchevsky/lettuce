/**
 * Conversations created in this session are known to be empty before their
 * first history load has settled: the transcript should read "No messages
 * yet" during that window, not the loading row, because `runtime_start` runs
 * inside the same effect and often outlasts the load itself. Mark at
 * creation; `use-conversation` consumes the mark once, on the first start.
 */
const fresh = new Set<string>();

export function markFreshConversation(id: string): void {
  fresh.add(id);
}

/** True once per marked id — an existing conversation is never treated as fresh. */
export function consumeFreshConversation(id: string | null | undefined): boolean {
  if (!id || !fresh.has(id)) return false;
  fresh.delete(id);
  return true;
}
