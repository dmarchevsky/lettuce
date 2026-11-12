import { type ReactNode, useState } from "react";
import { type AvatarPref, resolveAvatar } from "../lib/agent-tint.ts";

interface Props {
  agentId: string;
  name: string;
  /** What the user chose for this agent, if anything (`bff/src/agents/avatar-prefs.ts`). */
  pref?: AvatarPref;
  /**
   * The surface's own class. Size and shape belong to where the face sits, so the
   * component brings the tint and the content and nothing else — and every surface
   * that shows a MARK (rail both ways, band, phone header, switcher) sizes it from
   * one `--avatar-face`, while the picker keeps its own judgment sizes.
   */
  className?: string;
  /** What a surface hangs on the face, like the header's responding dot. */
  children?: ReactNode;
  ariaHidden?: boolean;
}

/**
 * An agent's face: the tint it was given (or the one its id hashes to) with the
 * glyph it was given (or the letter of its name) on top — or, when one was
 * uploaded, the picture over that same tint, so its transparency reads as the
 * agent's colour rather than as a white box.
 *
 * Every surface that shows an agent renders through this one component, because
 * the four of them used to each call `tintFor`/`initialOf` by hand and a
 * preference read in one of them would have shown up in one list only. It is also
 * why one CSS rule for an uploaded face covers the rail, the switcher, the header
 * and the picker's own preview at once.
 *
 * A picture that cannot be drawn shows the letter instead. The BFF now refuses a
 * preference naming a face it does not hold, but a lost `avatars/` directory, a
 * second tab deleting the file, or a proxy that eats the response all leave the
 * same artifact: an empty circle where an agent's face was. A letter on the right
 * tint is a worse-looking face; an empty circle is a broken one.
 */
export function AgentAvatar({
  agentId,
  name,
  pref,
  className = "agent-avatar",
  children,
  ariaHidden,
}: Props) {
  const face = resolveAvatar(agentId, name, pref);
  // Keyed on the url rather than a boolean, so putting a different face on an
  // agent draws immediately instead of staying on the letter it failed onto.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = face.image !== undefined && failedUrl !== face.image;
  return (
    <span
      className={className}
      style={{ background: face.background }}
      aria-hidden={ariaHidden || undefined}
    >
      {showImage ? (
        <img
          className="agent-avatar-img"
          src={face.image}
          alt=""
          onError={() => setFailedUrl(face.image ?? null)}
        />
      ) : (
        face.content
      )}
      {children}
    </span>
  );
}
