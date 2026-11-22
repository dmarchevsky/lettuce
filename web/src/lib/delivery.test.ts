import { describe, expect, test } from "bun:test";
import { clearDelivery, deliveryCode, deliveryForCode, markDelivery } from "./delivery.ts";
import { addLocalUserMessage, createStreamIndex, type Transcript } from "./messages.ts";
import { BffRequestError } from "./session-client.ts";

/** One local echo, exactly as `sendContent` makes it — the note hangs off that entry. */
function echo(text = "Check the CI job"): { transcript: Transcript; id: string } {
  const transcript: Transcript = new Map();
  const id = "web-1700000000000-abcdef";
  addLocalUserMessage(transcript, createStreamIndex(), id, text, 1);
  return { transcript, id };
}

describe("the delivery verdict", () => {
  test("the BFF's two codes map to the two states the bubble shows", () => {
    expect(deliveryForCode("not_sent")).toBe("unsent");
    expect(deliveryForCode("delivery_uncertain")).toBe("uncertain");
  });

  test("a refusal that says nothing about delivery carries no verdict", () => {
    // A timeout is this case, and it must stay this case: no answer is not evidence.
    expect(deliveryCode(new Error("Timed out waiting for input"))).toBeNull();
    expect(deliveryCode(undefined)).toBeNull();
    expect(deliveryCode({ code: "rate_limited" })).toBeNull();
  });

  test("a rejected request carries its code through to the verdict", async () => {
    const error = new BffRequestError("did not run", "not_sent");
    expect(error.message).toBe("did not run");
    expect(deliveryCode(error)).toBe("not_sent");
  });
});

describe("delivery state on the transcript entry", () => {
  test("marking replaces the entry, because rows are memoised on identity", () => {
    const { transcript, id } = echo();
    const before = transcript.get(id);
    expect(markDelivery(transcript, id, "unsent")).toBe(true);
    const after = transcript.get(id);
    expect(after?.delivery).toBe("unsent");
    expect(after).not.toBe(before);
    // Marking is an annotation, not a rewrite: the message itself is untouched.
    expect(after?.text).toBe("Check the CI job");
    expect(after?.local).toBe(true);
  });

  test("marking an entry that is gone changes nothing", () => {
    // The tab was reloaded, or a force-send erased the echo, and the verdict arrived for nobody.
    const { transcript } = echo();
    expect(markDelivery(transcript, "web-nope", "uncertain")).toBe(false);
  });

  test("unsent then uncertain, then cleared on the ack", () => {
    const { transcript, id } = echo();
    markDelivery(transcript, id, "unsent");
    expect(transcript.get(id)?.delivery).toBe("unsent");

    // Re-sent and lost again, this time after the write: the harsher truth wins.
    markDelivery(transcript, id, "uncertain");
    expect(transcript.get(id)?.delivery).toBe("uncertain");

    // The resend was acknowledged: the note is gone, the bubble stays.
    expect(clearDelivery(transcript, id)).toBe(true);
    expect(transcript.get(id)?.delivery).toBeUndefined();
    expect(transcript.get(id)?.text).toBe("Check the CI job");
    // The bubble is a plain message again, and the note's absence is the point.
    expect(Object.keys(transcript.get(id)!)).not.toContain("delivery");
    // Clearing twice does not claim a second change, so the caller skips the repaint.
    expect(clearDelivery(transcript, id)).toBe(false);
  });
});
