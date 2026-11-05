import type { ChannelSend } from "../lib/channel-send.ts";
import { channelLabel } from "../lib/channel-send.ts";
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
 * It is an `.entry` like the question card's, so it joins the transcript's own
 * column rather than inventing a panel; the left rule matches the question card's
 * accent and flips to the error colour when the channel refused the message.
 *
 * Layout rules, each earned at 390px:
 *
 * - the header is **one line that cannot wrap**, and when it does not fit the
 *   **tool name yields first and the destination last**: `MessageChannel` may
 *   ellipsize, `→ Telegram` may not, and the pill never breaks internally or
 *   leaves the row. The first mock got the yield order backwards and cut the
 *   destination — the one token on that line worth reading.
 * - the body is message text at message size. The mock's muted 13px made the
 *   point of the card the hardest thing on screen.
 * - a pending send shows no pill at all. No return, no claim.
 */
export function ChannelSendCard({ send }: { send: ChannelSend }) {
  const failed = send.delivery === "failed";
  const destination =
    send.action === "upload-file"
      ? `→ ${channelLabel(send.channel)} · attachment`
      : `→ ${channelLabel(send.channel)}`;
  return (
    <div className={`entry channel-send${failed ? " failed" : ""}`}>
      <div className="chan-head">
        <code>MessageChannel</code>
        <span className="chan-dest">{destination}</span>
        {send.delivery === "sent" ? (
          <span className="chan-tag sent">
            sent <Icon name="check" />
          </span>
        ) : null}
        {failed ? <span className="chan-tag">not delivered</span> : null}
      </div>
      <p className="chan-body">{send.body}</p>
    </div>
  );
}
