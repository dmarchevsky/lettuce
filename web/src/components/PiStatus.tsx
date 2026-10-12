import { copyText } from "../lib/clipboard.ts";
import { ago, type PiCheck, type PiCheckState } from "../lib/pi.ts";
import { toast } from "./Toast.tsx";

/**
 * The Remote Pi status row, shared by Settings → Remote Pi and Tools → Remote Pi
 * (two panes, one answer).
 *
 * It used to be one `.pill` carrying pi version, target, pinned fingerprint and
 * age on a single `nowrap` line, which on a phone ran off the edge and cut off the
 * one part that says whether the green is still true. So the state is a word of
 * its own, the rest wraps, and the fingerprint — which nobody compares from a
 * truncated tail — sits on its own line where it can be copied whole.
 *
 * The words name the failure rather than hiding behind "Failed": each is the verb
 * the operator has to do something about, and `PiCheckBanner` carries ssh's own
 * sentence next to it.
 */
type Tone = "ok" | "warn" | "bad" | "idle";

type Verb = "key" | "path" | "workdir" | "retry";

const STATES: Record<PiCheckState, { word: string; tone: Tone; verb?: Verb }> = {
  ready: { word: "Ready", tone: "ok" },
  unpinned: { word: "Not pinned", tone: "warn" },
  no_key: { word: "No key stored", tone: "warn", verb: "key" },
  auth_failed: { word: "Sign-in refused", tone: "bad", verb: "key" },
  no_pi: { word: "Pi not on PATH", tone: "bad", verb: "path" },
  no_workdir: { word: "Working folder missing", tone: "bad", verb: "workdir" },
  unreachable: { word: "Unreachable", tone: "bad", verb: "retry" },
};

/** `SHA256:abcdef…uvwxyz` — a fingerprint you can read at a glance. */
export function shortFingerprint(value: string | null): string {
  if (!value) return "none";
  const hex = value.replace(/^SHA256:/, "");
  return hex.length <= 12 ? value : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

interface StatusProps {
  check: PiCheck | null;
  /** The form or the target moved since the check, so its result is about another host. */
  stale: boolean;
  checking: boolean;
  /** Whose host this is, when that is not obvious: "inherited from Settings". */
  targetNote?: string | null;
}

export function PiStatusLine({ check, stale, checking, targetNote }: StatusProps) {
  const tail = (extra: string | null = null) => {
    const parts = [
      check?.target ?? null,
      targetNote ?? null,
      extra,
      check ? `checked ${ago(check.at)}` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  if (checking) {
    return (
      <div className="pi-status idle" role="status">
        <span className="pi-dot spinning" />
        <span className="pi-state">Checking…</span>
        <span className="pi-tail">{tail()}</span>
      </div>
    );
  }

  if (!check) {
    return (
      <div className="pi-status warn" role="status">
        <span className="pi-dot" />
        <span className="pi-state">Never checked</span>
        <span className="pi-tail">an unpinned host fails every run</span>
      </div>
    );
  }

  if (stale) {
    return (
      <div className="pi-status warn" role="status">
        <span className="pi-dot" />
        <span className="pi-state">Changed since the last check</span>
        <span className="pi-tail">check after saving · the last check was {check.target}</span>
      </div>
    );
  }

  const state = STATES[check.state];
  const fingerprint = check.pinnedFingerprint;
  return (
    <>
      <div className={`pi-status ${state.tone}`} role="status">
        <span className="pi-dot" />
        <span className="pi-state">{state.word}</span>
        {check.ok && check.piVersion ? (
          // piVersion is bare ("1.1.0"); on its own next to "Ready" that reads
          // like a count, so the tag names what the version belongs to.
          <span className="tag ok-tag">pi v{check.piVersion.replace(/^v/, "")}</span>
        ) : null}
        <span className="pi-tail">{tail(check.ok ? null : check.detail)}</span>
      </div>
      {fingerprint ? (
        <div className="pi-kv">
          <span>Pinned host key</span>
          <code title={fingerprint}>{shortFingerprint(fingerprint)}</code>
          <button
            type="button"
            className="link"
            onClick={() =>
              void copyText(fingerprint).then((ok) => {
                if (!ok)
                  toast("Clipboard blocked by the browser — select the value and copy", "bad");
              })
            }
          >
            Copy
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Why a check failed, in ssh's own words, with the one action that fixes it. The
 * banner — not a toast — because a failed check is a state of this screen and has
 * to stay on it while it is read.
 */
export function PiCheckBanner({
  check,
  stale,
  checking,
  onCopyKey,
  onFocusPath,
  onFocusWorkdir,
  onRetry,
}: {
  check: PiCheck | null;
  stale: boolean;
  checking: boolean;
  onCopyKey?: () => void;
  onFocusPath?: () => void;
  onFocusWorkdir?: () => void;
  onRetry?: () => void;
}) {
  if (checking || !check || check.ok || stale) return null;
  const verb = STATES[check.state].verb;
  const detail = check.detail || check.state.replace(/_/g, " ");
  return (
    <p className="warning small" role="alert">
      <span>{detail}</span>
      {verb === "key" && onCopyKey ? (
        <button type="button" className="link" onClick={onCopyKey}>
          Copy public key
        </button>
      ) : null}
      {verb === "path" && onFocusPath ? (
        <button type="button" className="link" onClick={onFocusPath}>
          Set PATH prefix
        </button>
      ) : null}
      {verb === "workdir" && onFocusWorkdir ? (
        <button type="button" className="link" onClick={onFocusWorkdir}>
          Set working folder
        </button>
      ) : null}
      {verb === "retry" && onRetry ? (
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </p>
  );
}
