import { useEffect, useState } from "react";

type Kind = "ok" | "bad" | "warn";

// The layer registers itself here, so any component can report without a prop
// path from the app root to wherever the action happened.
let emit: (text: string, kind: Kind) => void = () => {};

/**
 * Report the outcome of something the operator just did. It dismisses itself.
 * `warn` is the one that means "stored, and the second half did not happen".
 */
export function toast(text: string, kind: Kind = "ok"): void {
  emit(text, kind);
}

/** Mounted once, in App. One line at a time, floating above sheets and all. */
export function ToastLayer() {
  const [shown, setShown] = useState<{ text: string; kind: Kind; at: number } | null>(null);

  useEffect(() => {
    emit = (text, kind) => setShown({ text, kind, at: Date.now() });
    return () => {
      emit = () => {};
    };
  }, []);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), 6000);
    return () => clearTimeout(timer);
  }, [shown]);

  // The live region is mounted from the first paint and only its text changes: a
  // region inserted at the same moment as its text is announced by some screen
  // readers and missed by others, which would undo the point of a toast. And one
  // role each — role="alert" is assertive, role="status" polite — rather than a
  // status whose aria-live says otherwise. The tap is handled by the region, since
  // a fixed-position child's click bubbles to it, so one handler covers both states.
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap only ends a toast early — it dismisses itself after 6s.
    // biome-ignore lint/a11y/noStaticElementInteractions: the box is a message, not a control.
    <div className="toast-live" onClick={shown ? () => setShown(null) : undefined}>
      {shown ? (
        <div className={`toast ${shown.kind}`} role={shown.kind === "ok" ? "status" : "alert"}>
          {shown.text}
        </div>
      ) : null}
    </div>
  );
}
