import { type ChannelSend, channelLabel } from "../lib/channel-send.ts";
import { formatEntryTime, formatEntryTimeFull } from "../lib/timestamps.ts";
import { Icon } from "./Icon.tsx";

/**
 * The card for a message the agent sent on a channel (`channel-send.ts`).
 *
 * A send otherwise hides: the call is one step among five inside a collapsed run,
 * its subtitle truncates mid-string, and the agent's closing line ("Done — the
 * digest is in your Telegram") is a claim, not a delivery fact. So the send is
 * promoted out of the run and rendered here, the way a pending question is,
 * because a message the user came here to read cannot hide behind a fold.
 *
 * It is a message **from the agent**, so it borrows the agent's own header
 * (`<glyph> Telegram · <time> · <status>`, the `.role` line and the agent tint)
 * rather than announcing a tool: nobody reads this as "MessageChannel", they read
 * it as "the agent sent this on Telegram". The panel stays quieter than an answer
 * — a tint rail and a faint wash, no box — so it reads as the agent's words with
 * a delivery fact attached, not as a second answer.
 *
 * Two rules the wire forced:
 *
 * - **a pending send shows no status glyph.** No return, no claim.
 * - the header is **one line that cannot wrap**; the channel name is what matters,
 *   so nothing on the row may push it out (`white-space: nowrap` end to end).
 */
export function ChannelSendCard({
  send,
  date,
  showTimestamps,
}: {
  send: ChannelSend;
  date: string;
  showTimestamps: boolean;
}) {
  const failed = send.delivery === "failed";
  const short = formatEntryTime(date);
  return (
    <div className={`entry channel-send${failed ? " failed" : ""}`}>
      <div className="role chan-head">
        <span className="who">
          <Icon name="send" className="chan-glyph" />
          {channelLabel(send.channel)}
        </span>
        {/* The one shared timestamp rule: with timestamps filtered off, no
            `<time>` element appears anywhere in the transcript. */}
        {short && showTimestamps ? (
          <time dateTime={date} title={formatEntryTimeFull(date)}>
            {short}
          </time>
        ) : null}
        {send.delivery === "sent" ? <Icon name="check" className="chan-status sent" /> : null}
        {failed ? <Icon name="warning" className="chan-status bad" /> : null}
      </div>
      <p className="chan-body">{send.body}</p>
    </div>
  );
}
