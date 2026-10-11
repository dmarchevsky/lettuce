import { useEffect, useRef } from "react";
import { BackStack, type Close } from "../lib/back-stack.ts";

// Created on first use, inside an effect: importing this module must not touch
// `window` (unit tests import components that use it, with no browser).
let stack: BackStack | null = null;
function backStack(): BackStack {
  if (!stack) {
    const created = new BackStack(window.history);
    window.addEventListener("popstate", () => created.onPopState());
    stack = created;
  }
  return stack;
}

/**
 * Make the phone's Back button close this overlay instead of the app, while
 * `active`. `onClose` returning `false` marks it undismissable: Back is
 * swallowed rather than closing it or leaving the app. See `lib/back-stack.ts`.
 */
export function useBackToClose(onClose: Close, active = true): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    return backStack().open(() => latest.current());
  }, [active]);
}
