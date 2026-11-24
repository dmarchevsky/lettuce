/**
 * The DOM half of the test suite: bun's runner has no DOM, so a render test needs one
 * registered before React is imported anywhere.
 *
 * `GlobalWindow` from happy-dom is a real `window` — it owns `document`, `matchMedia`,
 * observers, storage and event dispatch — and every attribute it declares is copied onto
 * `globalThis` so source under test can use bare globals exactly as it does in the browser.
 * `globalThis.window`/`document` are then set explicitly, because React and the app both
 * read those two by name.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is what makes `act()` quiet and correct: without it React
 * warns "the current testing environment is not configured to support act" on every
 * render, and the harness relies on `act` flushing effects synchronously.
 *
 * Registered via `web/bunfig.toml`, so it is loaded for `bun test` from the `web` workspace
 * and nowhere else — a plain `bun test` at the root (the pure tests) still runs with no DOM.
 */
import { GlobalWindow } from "happy-dom";

const window = new GlobalWindow({ url: "http://localhost/" });

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  try {
    Object.defineProperty(globalThis, key, {
      value: window[key as keyof GlobalWindow],
      writable: true,
      configurable: true,
    });
  } catch {
    // Window internals that refuse to be copied (getters bound to the window itself) are
    // simply unreachable as bare globals; a test that needs one goes through `window`.
  }
}

// The two names every browser script reaches for by hand. Cast through `any` here —
// `globals.d.ts` is where that assertion is made once for the whole render suite.
const globals = globalThis as any;
globals.window = window;
globals.document = window.document;
globals.IS_REACT_ACT_ENVIRONMENT = true;
