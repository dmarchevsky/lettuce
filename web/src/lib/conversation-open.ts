/**
 * The sequencing of opening a conversation, kept apart from the hook so the
 * order — the one thing that decides how long the transcript takes to appear —
 * is testable on its own.
 *
 * `conversation_messages_list` answers in milliseconds and is all the user is
 * waiting for. `runtime_start` with `wait_for_replay` makes the app-server
 * replay the conversation before it answers, which blocks the whole server for
 * seconds on a slow disk, and everything queued behind it on the shared
 * connection waits too. So the history request goes first and the slow start
 * runs beside it: the transcript is painted by the fast request, and live state
 * (processing, queue, the status pill) still primes from the start's replay
 * when it lands.
 */

/**
 * Whether the loading row shows while the history is in flight. A conversation
 * just created in this session is known to be empty, and saying so at once
 * beats a row for messages that will never come.
 */
export function historyShowsLoadingRow(freshConversation: boolean): boolean {
  return !freshConversation;
}

export interface OpenSequence {
  /** Send the history request. Fire-and-forget; `onSettled` is its tail. */
  loadHistory: (onSettled: () => void) => void;
  /** Seed the workspace and start the runtime; may outlast the history. */
  startRuntime: () => Promise<void>;
  /** Take the loading row off, once the history has settled. */
  endLoadingRow: () => void;
}

/**
 * Fire the history request and the runtime start together, the history first.
 *
 * The loading row goes away when the history settles — a transcript on screen
 * is worth more than the runtime flag, and the start may still be replaying.
 * Whether the row was ever *shown* is a separate question
 * (`historyShowsLoadingRow`); a conversation created in this session simply
 * never showed one, and its load still runs, because live frames need it to
 * fold into whether or not the conversation had messages.
 */
export async function openConversation(open: OpenSequence): Promise<void> {
  // History handed over first, before the start is even attempted: everything
  // sent after a blocking command waits behind it, and the seed write and the
  // start are both file work on the app-server's slow disk.
  open.loadHistory(() => open.endLoadingRow());
  const started = open.startRuntime().then(
    () => {},
    () => {},
  );
  await started;
}
