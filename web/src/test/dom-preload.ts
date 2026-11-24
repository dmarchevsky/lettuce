/**
 * The DOM half of the test suite: bun's runner has no DOM, so a render test needs one
 * registered before React is imported anywhere.
 *
 * Registered in the ROOT `bunfig.toml`, so the window is installed once for the whole
 * `bun test` run and every file in the repo — bff included — shares it. That is on purpose
 * (one command, one pass: a render test can never be filtered out of a run and read green)
 * and it has two consequences a test author has to know:
 *
 * - Anything a test leaves on `window`/`globalThis` is visible to every later file. Nothing
 *   here stores anything on purpose; a test that must, cleans it up itself.
 * - The copy SKIPS names already defined on `globalThis`, plus the `NOT_COPIED` list below —
 *   globals the codebase deliberately has a branch for having absent.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is what makes `act()` quiet and correct: without it React warns
 * "the current testing environment is not configured to support act" on every render, and the
 * harness relies on `act` flushing effects synchronously.
 */
import { GlobalWindow } from "happy-dom";

// React picks its build from NODE_ENV where it is imported, and only the development build
// exports `act` — which the harness uses for every mount and every event. A caller whose
// environment says `production` (a CI step, a harness shell, `bun run`'s own default) would
// otherwise make each render test die inside React instead of failing on an assertion, so the
// suite pins the mode it needs before anything imports React.
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

/**
 * Globals the window must NOT install even though happy-dom has them, because code and tests
 * already treat their absence as a supported environment:
 *
 * - `localStorage`/`sessionStorage`: `web/src/lib/storage.ts` reports "no storage" when none
 *   exists, and the storage-backed tests hand in their own stand-ins for exactly that reason.
 *   A live `Storage` shared by the whole run would retire that branch and leak writes between files.
 * - `matchMedia`: `use-wide` reads a missing `matchMedia` as "not desktop", and a render test
 *   that cares about the breakpoint stubs it in the test, where the stub is visible.
 */
const NOT_COPIED = new Set(["localStorage", "sessionStorage", "matchMedia"]);

const window = new GlobalWindow({ url: "http://localhost/" });

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis || NOT_COPIED.has(key)) continue;
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

// The two names every browser script reaches for by hand. The cast is unavoidable and it stays
// local on purpose: happy-dom's window is structurally not `lib.dom`'s, and re-declaring
// `document` in a `declare global` block does not beat `lib: ["DOM"]` in tsconfig anyway — so
// app code keeps its real DOM types and only this assignment is loosened.
const globals = globalThis as any;
globals.window = window;
globals.document = window.document;
globals.IS_REACT_ACT_ENVIRONMENT = true;
