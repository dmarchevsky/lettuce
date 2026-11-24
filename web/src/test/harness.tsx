/**
 * The render-test harness: a component or hook mounted in a real DOM, asserted through
 * what a user would see.
 *
 * This exists because four flows shipped a **render claim proved by reading a component** — a picture dropped by
 * the row that renders it, an ack shown as the opposite of what happened, save-path defects surviving two review
 * rounds while pure-helper tests stayed green. Pure tests cannot see a mount: an effect that re-setStates in a
 * loop only misbehaves once something is rendered.
 *
 * What it gives a test: `mount`/`renderHook` (each returns a handle; anything still mounted when a
 * test ends is unmounted for it), `settle` to flush effects, and the three interactions a component
 * test actually needs (`click`, `type`, `pick`). What it deliberately is not: a testing-library clone.
 * One `querySelector` and `textContent` cover the assertions here; if a future test needs more,
 * growing this is cheaper than a dependency's indirection.
 *
 * The DOM itself comes from `dom-preload.ts` (registered in the ROOT `bunfig.toml`), so this file
 * assumes `document` exists and does not create one.
 */

import { afterEach } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Flush pending work: effects, promise chains, and any state they set. `act` is what makes React commit
 * synchronously; the extra macrotask lets a chain that chained past a microtask land too. Pass the action as
 * `fire` so the state it starts is flushed inside the same act scope — firing a listener from outside leaves
 * React warning that an update escaped `act`.
 */
export async function settle(fire?: () => void): Promise<void> {
  await act(async () => {
    fire?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export interface RenderHandle {
  /** The node the test was given to query within — the render's own scope. */
  readonly el: HTMLElement;
  /** Every element in scope matching `selector`. */
  all(selector: string): HTMLElement[];
  /** The first element matching `selector`, or null. */
  find(selector: string): HTMLElement | null;
  /** The element whose text contains `text` (button/label/link style lookups). */
  byText(text: string): HTMLElement | null;
  /** The button whose trimmed text equals `text` — `byText` matches substrings, and "Save" is also prose. */
  button(text: string): HTMLButtonElement | null;
  /** Trimmed text of the first node matching `selector` ("" when absent). */
  text(selector: string): string;
  /** Replace the tree rendered at this handle (same root, so React keeps its state). */
  rerender(node: ReactNode): Promise<void>;
  unmount(): void;
}

/** Number of renders a mount has done — the churn assertion's meter. */
export function renderCounter(): { onRender(): void; count(): number } {
  let n = 0;
  return {
    onRender: () => {
      n += 1;
    },
    count: () => n,
  };
}

/** Record every `console.error`/`console.warn` while `fn` runs (React warnings are test failures). */
export async function captureWarnings(fn: () => Promise<void> | void): Promise<string[]> {
  const seen: string[] = [];
  const errors = console.error;
  const warns = console.warn;
  console.error = (...args: unknown[]) => seen.push(`error: ${String(args[0] ?? "")}`);
  console.warn = (...args: unknown[]) => seen.push(`warn: ${String(args[0] ?? "")}`);
  try {
    await fn();
  } finally {
    console.error = errors;
    console.warn = warns;
  }
  return seen;
}

interface MountOptions {
  /** Assert the mount produced no React warning (act warnings mean the harness is wrong, not the app). */
  strict?: boolean;
}

/** Render `node` into a fresh element appended to `document.body`. */
export async function mount(node: ReactNode, options: MountOptions = {}): Promise<RenderHandle> {
  const host = document.createElement("div");
  document.body.append(host);
  let root: Root | null = null;
  const warnings =
    options.strict === false
      ? []
      : await captureWarnings(async () => {
          root = createRoot(host);
          await act(async () => {
            root?.render(node);
          });
          await settle();
        });
  if (warnings.length > 0) {
    const detail = warnings.slice(0, 4).join("\n  ");
    // Tear down before throwing: a leaked root keeps scheduling and the next test in the file
    // inherits its state — the one case where a red test must not leave a live mount behind.
    try {
      act(() => root?.unmount());
    } catch {
      // A root that will not unmount is already broken; the error below is the message that matters.
    }
    host.remove();
    throw new Error(`mount produced React output (fix the harness or the component):\n  ${detail}`);
  }

  const handle: RenderHandle = {
    el: host,
    all: (selector) => Array.from(host.querySelectorAll<HTMLElement>(selector)),
    find: (selector) => host.querySelector<HTMLElement>(selector),
    byText: (text) =>
      Array.from(host.querySelectorAll<HTMLElement>("button,label,a,span,p,option")).find((el) =>
        (el.textContent ?? "").includes(text),
      ) ?? null,
    button: (text) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (el) => (el.textContent ?? "").trim() === text,
      ) ?? null,
    text: (selector) => (host.querySelector(selector)?.textContent ?? "").trim(),
    rerender: async (next) => {
      await act(async () => {
        root?.render(next);
      });
      await settle();
    },
    unmount: () => {
      if (root) {
        act(() => root?.unmount());
        root = null;
      }
      host.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

/**
 * Mount `useHook` inside a probe component so a hook can be driven without a screen.
 * `render` re-renders the probe with new props — that is how a test changes the hook's inputs.
 */
export async function renderHook<T>(
  useHook: (props: Record<string, unknown>) => T,
  initial: Record<string, unknown> = {},
): Promise<{
  current(): T;
  props(): Record<string, unknown>;
  render(next: Record<string, unknown>): Promise<void>;
  unmount(): void;
}> {
  const box: { value: T } = { value: undefined as unknown as T };
  let current: Record<string, unknown> = initial;
  function Probe() {
    box.value = useHook(current);
    return null;
  }
  const handle = await mount(<Probe />);
  return {
    current: () => box.value,
    props: () => current,
    render: async (next) => {
      current = { ...current, ...next };
      await handle.rerender(<Probe />);
    },
    unmount: () => handle.unmount(),
  };
}

/** Dispatch a click the way a tap does (bubbles, so a delegated handler sees it). */
export async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

/**
 * Set an input's or textarea's value and fire the change React listens for. React tracks the last value
 * it wrote, so the assignment goes through the native setter OF THAT ELEMENT TYPE: a plain `el.value =`
 * is invisible to React, and reaching for the input setter on a `<textarea>` throws inside happy-dom
 * after assigning, so the event never fires and React silently sees no edit at all.
 */
export async function type(el: HTMLElement, value: string): Promise<void> {
  const field = el as HTMLInputElement;
  const prototype =
    field.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Choose an option in a `<select>` (the compaction-mode field's control). */
export async function pick(el: HTMLElement, value: string): Promise<void> {
  const select = el as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    if (setter) setter.call(select, value);
    else select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Every mount of the current test, so one cannot leak into the next. */
const mounted: RenderHandle[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});
