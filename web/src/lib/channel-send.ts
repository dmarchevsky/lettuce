import type { TranscriptEntry } from "./messages.ts";
import { parseToolArgs } from "./tool-summary.ts";

/**
 * What a `MessageChannel` call did, read off the call and the return that
 * answers it.
 *
 * The tool is the agent's only way to put a message on Telegram (or Slack), and
 * the turn's whole point is often exactly that — yet the call renders as one step
 * line inside a collapsed run, so the digest a cron sent at 7am is invisible in
 * the transcript that holds it. This reads the three facts the UI needs —
 * *where*, *what*, and *whether it arrived* — from data already on the wire:
 *
 * - the call's own args (`channel`, `action`, `message`);
 * - the paired `tool_return`, which upstream fills with
 *   `Message sent to telegram (message_id: …)` on success and an `Error: …`
 *   string on failure, with `is_error` set from the same test
 *   (`letta-code/src/channels/message-channel-executor.ts`), which is how the
 *   entry's `status` reads `error`.
 *
 * `MessageChannel` is *not* only a send — the same tool drives reactions, thread
 * binding and file downloads (`…/telegram/message-action-contract.ts` advertises
 * `send`, `send-rich`, `react`, `upload-file`), so only the outbound actions get
 * a card. Calling `react` must never produce a "sent" badge.
 */

/** The actions that put content on a channel for a human to read. */
const OUTBOUND_ACTIONS: ReadonlySet<string> = new Set(["send", "send-rich", "upload-file"]);

export type ChannelDelivery = "pending" | "sent" | "failed";

export interface ChannelSend {
  /** The raw channel id from the args (`telegram`, `slack`). */
  channel: string;
  /** The action as sent, for the label (`send`, `upload-file`). */
  action: string;
  /** The message body; for an attachment, the file name. Never empty. */
  body: string;
  /** Whether the channel took the message. `pending` until the return lands. */
  delivery: ChannelDelivery;
}

/** `telegram` → `Telegram`. The wire id is lowercase and is all we have. */
export function channelLabel(channel: string): string {
  return channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : "Channel";
}

/**
 * The send card behind a `MessageChannel` call, or null when the call is not an
 * outbound message (another action, a half-streamed call whose args are not
 * parseable yet, or a call with neither a destination nor a body).
 *
 * Cheap-guarded on the tool name before parsing anything: this runs over the
 * whole transcript on every flush.
 */
export function readChannelSend(
  call: TranscriptEntry,
  retn: TranscriptEntry | null,
): ChannelSend | null {
  if (call.toolName !== "MessageChannel") return null;
  const args = parseToolArgs(call.toolArgs);
  if (!args) return null;

  const action = typeof args.action === "string" ? args.action : "";
  if (!OUTBOUND_ACTIONS.has(action)) return null;

  const channel = typeof args.channel === "string" ? args.channel : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const file = typeof args.filename === "string" ? args.filename : "";
  const media = typeof args.media === "string" ? args.media : "";
  const body = message || file || (media ? (media.split("/").pop() ?? media) : "");
  if (!body) return null;

  // No return yet is not a failure: a send settles within the same turn, and a
  // badge that claims "sent" before the channel answered is the lie this whole
  // feature exists to stop.
  const delivery: ChannelDelivery = !retn ? "pending" : retn.status === "error" ? "failed" : "sent";
  return { channel, action, body, delivery };
}
