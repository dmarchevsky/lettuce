/**
 * The churn case r18 names: a hook that re-setStates under a mount is invisible to a pure test, because nothing
 * mounts it — the bug only exists while something is rendered. `use-wide` is the concrete hook: it reads a media
 * query on init and listens for changes, so it is exactly the shape that can loop (an effect that re-arms its own
 * listener, or a state write the query answers differently to, churns forever against the production bundle and
 * every pure test stays green).
 */
import { expect, test } from "bun:test";
import { mount, renderCounter, renderHook, settle } from "../test/harness.tsx";
import { useWide } from "./use-wide.ts";

/** A `matchMedia` a test can flip, recording every listener so a "resize" is one call. */
function stubMediaQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: "",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
  };
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (() => query) as unknown as typeof globalThis.matchMedia;
  return {
    query,
    fire() {
      for (const fn of [...listeners]) fn();
    },
    restore() {
      globalThis.matchMedia = previous;
    },
  };
}

test("a media-query hook settles: a change lands once, and repeats do not churn", async () => {
  const media = stubMediaQuery(false);
  try {
    const renders = renderCounter();
    let seen = false;
    function Probe() {
      renders.onRender();
      seen = useWide();
      return null;
    }
    const handle = await mount(<Probe />);

    // Two passes: the query read at init, and the committed answer. A loop is never two.
    expect(renders.count()).toBeLessThanOrEqual(2);
    expect(seen).toBe(false);

    // A real change lands once — and is visible in what the hook now reports.
    const before = renders.count();
    media.query.matches = true;
    await settle(() => media.fire());
    expect(seen).toBe(true);
    expect(renders.count()).toBe(before + 1);

    // The loop test: React may call a render once more when an update changes nothing (it bails out after
    // that call), so a fixed count would be a flaky contract. A churn loop is not: it never stops, so a
    // bounded ceiling over many identical events catches exactly the bug a pure test cannot see at all.
    const stable = renders.count();
    for (let i = 0; i < 10; i += 1) await settle(() => media.fire());
    expect(renders.count()).toBeLessThanOrEqual(stable + 1);
    expect(seen).toBe(true);

    // Unrelated input changes do not make the hook re-render either.
    const quiet = renders.count();
    await handle.rerender(<Probe />);
    await settle();
    expect(renders.count()).toBe(quiet + 1);

    handle.unmount();
  } finally {
    media.restore();
  }
});

test("the hook answers what the query says, through renderHook", async () => {
  const media = stubMediaQuery(true);
  try {
    const hook = await renderHook(() => useWide());
    expect(hook.current()).toBe(true);
    media.query.matches = false;
    await settle(() => media.fire());
    expect(hook.current()).toBe(false);
    hook.unmount();
  } finally {
    media.restore();
  }
});
