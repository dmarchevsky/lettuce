import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  email: string | undefined;
}

/**
 * Dev-bypass warning, in the header rather than as a fixed banner.
 *
 * It used to be a full-width strip pinned to the bottom of the viewport at
 * z-index 50, which sat on top of the sidebar's controls and every sheet's
 * button row. As a header pill it costs no vertical space and covers nothing.
 */
export function AuthPill({ email }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* The icon is the warning at every width; on a desktop browser the top bar
          has room to name it, so the triangle is not a mystery glyph. */}
      <span className="topbar-status">
        <button
          type="button"
          className="auth-warning"
          onClick={() => setOpen(true)}
          title="Authentication is disabled"
          aria-label="Unauthenticated (dev bypass)"
        >
          <Icon name="warning" />
        </button>
        <span className="topbar-word">Dev bypass</span>
      </span>

      {open ? (
        <Sheet title="Unauthenticated (dev bypass)" size="compact" onClose={() => setOpen(false)}>
          <p className="warning">
            Developer sign-in is enabled. This does <strong>not</strong> authenticate anyone — any
            visitor becomes the configured user. Unset <code>DEV_BYPASS_EMAIL</code> to require
            Cloudflare Access sign-in.
          </p>
          {email ? (
            <p className="muted small">
              Acting as <code>{email}</code>
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}
