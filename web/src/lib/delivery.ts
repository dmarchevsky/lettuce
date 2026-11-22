/**
 * The delivery state a user message can carry, and how it changes.
 *
 * A user message is echoed locally before the app-server has said anything about it (the ordinary path
 * produces no frame at all — see `addLocalUserMessage`). That echo used to be a silent lie when the
 * message never arrived: the BFF's one upstream socket can drop mid-send, and the bubble stayed on screen
 * claiming a message that would never be answered. The BFF now answers the send's request with a code
 * instead of letting it hang (`bff/src/session/inflight.ts`), and this module is where that code becomes
 * something the transcript can hold and `MessageList` can render.
 *
 * Two truths, mirroring the BFF's two codes:
 *
 * - `unsent` — the frame demonstrably never left the BFF, so nothing ran and sending again is free.
 * - `uncertain` — it was written and the socket died before anything answered, so it may have run.
 *
 * Both offer the same action, because a resend is safe in both: it re-sends under the *same*
 * `client_message_id`, and the app-server de-dupes an input on that id
 * (`letta-code/src/websocket/listener/input-disposition.ts`), so a message that did land is ignored and
 * one that did not is finally delivered. Minting a fresh id would be the double-send.
 *
 * Live-session state only: history does not carry an undelivered message, so neither does a reload —
 * same lifetime as the local echo itself.
 */
import type { Transcript, TranscriptEntry } from "./messages.ts";

/** What the BFF said about a request's delivery, as `BffRequestError` carries it. */
export type DeliveryCode = "not_sent" | "delivery_uncertain";

/** Read a thrown value's delivery verdict, if it carries one. */
export function deliveryCode(error: unknown): DeliveryCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "not_sent" || code === "delivery_uncertain" ? code : null;
}

/** The entry state a verdict maps to — the two names differ because the UI's wording is plainer. */
export function deliveryForCode(code: DeliveryCode): NonNullable<TranscriptEntry["delivery"]> {
  return code === "not_sent" ? "unsent" : "uncertain";
}

/**
 * Mark a message's entry with a delivery state, replacing it so the row re-renders.
 *
 * False when the entry is gone — a reload, or a force-send that erased the echo, and there is nothing to
 * annotate.
 */
export function markDelivery(
  transcript: Transcript,
  clientMessageId: string,
  delivery: NonNullable<TranscriptEntry["delivery"]>,
): boolean {
  const entry = transcript.get(clientMessageId);
  if (!entry) return false;
  if (entry.delivery === delivery) return true;
  transcript.set(clientMessageId, { ...entry, delivery });
  return true;
}

/**
 * Forget a message's delivery state — it was acknowledged, or sent again.
 *
 * Returns whether anything changed, so callers can skip the repaint. A plain mutation of the existing
 * entry would not repaint at all: rows are memoised on entry identity.
 */
export function clearDelivery(transcript: Transcript, clientMessageId: string): boolean {
  const entry = transcript.get(clientMessageId);
  if (!entry?.delivery) return false;
  const { delivery: _gone, ...rest } = entry;
  transcript.set(clientMessageId, rest);
  return true;
}
