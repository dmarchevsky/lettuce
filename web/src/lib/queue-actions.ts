/**
 * The listener's message queue, as the UI sees it.
 *
 * Upstream queues every user message that arrives while a turn is in flight
 * and drains them in arrival order between turns; `update_queue` frames carry
 * the full snapshot after every mutation. There is no reorder or promote
 * command — `planForceSend` composes one client-side out of remove + resend.
 */

export interface QueuedItem {
  id: string;
  /** Display text: the content string, or the text parts of a content array. */
  content: string;
  /**
   * The original `content` verbatim (string or content-part array), so a
   * force-send resend does not lose images or other parts.
   */
  raw: unknown;
  clientMessageId: string;
  /** `user` | `cron` | `task_notification` | `subagent` | `system` | `channel`. */
  source: string;
  /** Parked by abort_message/Esc; needs resume_queue or a new message to drain. */
  paused: boolean;
}

/** One message a force-send resends: its raw content plus what to show for it. */
export interface ResendItem {
  raw: unknown;
  content: string;
}

/** Best-effort display text for a `QueueMessage.content` of either shape. */
function displayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let images = 0;
    const parts = content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "image") {
        images += 1;
        return [];
      }
      return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
    });
    if (parts.length > 0) return parts.join("\n");
    // An image-only queue chip must not show forty characters of base64.
    if (images > 0) return images === 1 ? "[image]" : `[${images} images]`;
  }
  return JSON.stringify(content ?? "");
}

export function readQueue(raw: unknown): QueuedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {
      id?: unknown;
      content?: unknown;
      client_message_id?: unknown;
      source?: unknown;
      paused?: unknown;
    };
    if (typeof entry.id !== "string") return [];
    return [
      {
        id: entry.id,
        content: displayText(entry.content),
        raw: entry.content,
        clientMessageId: typeof entry.client_message_id === "string" ? entry.client_message_id : "",
        source: typeof entry.source === "string" ? entry.source : "user",
        paused: entry.paused === true,
      },
    ];
  });
}

export interface ForceSendPlan {
  /** Queue ids to `remove_queue_item`, target included. */
  remove: string[];
  /** Messages to resend, in order: the target first, then the others. */
  resend: ResendItem[];
  /** The removed items, so their local transcript echoes can be cleaned up. */
  removed: QueuedItem[];
}

/**
 * The plan for "send this queued message next".
 *
 * Upstream has no promote command — the queue drains in arrival order and a
 * new message always lands at the back — so the only way to run an arbitrary
 * item first is to empty the user items out of the queue and resend them,
 * target first. The others keep their relative order behind it.
 *
 * System-originated items (cron prompts, task notifications) are never
 * touched: they are never paused, they drain first anyway, and resending one
 * as a user message would misrepresent it. A force-send cannot jump ahead of
 * one; that is why only user items offer the action.
 *
 * Returns null when there is nothing to do.
 */
export function planForceSend(
  queue: readonly QueuedItem[],
  targetId: string,
): ForceSendPlan | null {
  const target = queue.find((item) => item.id === targetId);
  if (target?.source !== "user") return null;
  const userItems = queue.filter((item) => item.source === "user");
  const others = userItems.filter((item) => item.id !== target.id);
  return {
    remove: userItems.map((item) => item.id),
    resend: [target, ...others].map((item) => ({ raw: item.raw, content: item.content })),
    removed: userItems,
  };
}
