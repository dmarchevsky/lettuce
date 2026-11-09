import type { ReactNode } from "react";
import { type AvatarPref, resolveAvatar } from "../lib/agent-tint.ts";

interface Props {
  agentId: string;
  name: string;
  /** What the user chose for this agent, if anything (`bff/src/agents/avatar-prefs.ts`). */
  pref?: AvatarPref;
  /**
   * The surface's own class. Size and shape belong to where the face sits — the
   * rail is 34px, the switcher 32, the header 22 — so the component brings the
   * tint and the content and nothing else.
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
  return (
    <span
      className={className}
      style={{ background: face.background }}
      aria-hidden={ariaHidden || undefined}
    >
      {face.image ? <img className="agent-avatar-img" src={face.image} alt="" /> : face.content}
      {children}
    </span>
  );
}
