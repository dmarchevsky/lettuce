import { useEffect, useState } from "react";

type Kind = "ok" | "bad";

// The layer registers itself here, so any component can report without a prop
// path from the app root to wherever the action happened.
let emit: (text: string, kind: Kind) => void = () => {};

/** Report the outcome of something the operator just did. It dismisses itself. */
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

  if (!shown) return null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap only ends it early — it dismisses itself after 6s.
    <div className={`toast ${shown.kind}`} role="status" onClick={() => setShown(null)}>
      {shown.text}
    </div>
  );
}
