import { describe, expect, test } from "bun:test";
import {
  blockUpdateReload,
  registerServiceWorker,
  UPDATE_CHECK_MIN_INTERVAL_MS,
  type UpdateWatchTargets,
  watchForUpdates,
} from "./register-sw.ts";

/** Structural fakes for the browser pieces `watchForUpdates` touches. */
function fakes(overrides: Partial<UpdateWatchTargets> = {}) {
  const listeners = new Map<string, Array<() => void>>();
  const docListeners = new Map<string, Array<() => void>>();
  const state = {
    reloads: 0,
    updates: 0,
    updateRejects: false,
    visibility: "visible",
    now: 1_000,
  };
  const targets: UpdateWatchTargets = {
    container: {
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    },
    doc: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (type, listener) => {
        docListeners.set(type, [...(docListeners.get(type) ?? []), listener]);
      },
    },
    update: async () => {
      state.updates += 1;
      if (state.updateRejects) throw new Error("offline");
    },
    controlledAtLoad: true,
    reload: () => {
      state.reloads += 1;
    },
    now: () => state.now,
    ...overrides,
  };
  const fire = (map: Map<string, Array<() => void>>, type: string) => {
    for (const listener of map.get(type) ?? []) listener();
  };
  return {
    targets,
    state,
    fireControllerChange: () => fire(listeners, "controllerchange"),
    fireVisibilityChange: () => fire(docListeners, "visibilitychange"),
  };
}

describe("watchForUpdates controllerchange reload", () => {
  test("a page already controlled reloads when a new worker takes over", () => {
    const f = fakes();
    watchForUpdates(f.targets);
    expect(f.state.reloads).toBe(0);
    f.fireControllerChange();
    expect(f.state.reloads).toBe(1);
  });

  test("a page that loaded uncontrolled never arms the reload", () => {
    // First visit: the fresh install claims the tab and fires controllerchange —
    // reloading there would reload every new install on its own first visit.
    const f = fakes({ controlledAtLoad: false });
    watchForUpdates(f.targets);
    f.fireControllerChange();
    expect(f.state.reloads).toBe(0);
  });

  test("an update landing while reloads are blocked lands when they unblock", () => {
    // The app blocks self-reloads while staged attachments hold work a reload
    // would throw away (App.tsx wires this to the composer tray).
    const f = fakes();
    watchForUpdates(f.targets);
    blockUpdateReload(true);
    f.fireControllerChange();
    expect(f.state.reloads).toBe(0);
    blockUpdateReload(false);
    expect(f.state.reloads).toBe(1);
    blockUpdateReload(false); // the pending reload was spent, not stored twice
    expect(f.state.reloads).toBe(1);
  });
});

describe("watchForUpdates foreground update check", () => {
  test("a tab coming back after the window asks the registration for an update", () => {
    const f = fakes();
    watchForUpdates(f.targets);
    // The page just loaded, so the browser already revalidated sw.js at
    // navigation; a foreground inside the window would buy nothing.
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.fireVisibilityChange();
    expect(f.state.updates).toBe(1);
  });

  test("hiding the page checks nothing", () => {
    const f = fakes();
    watchForUpdates(f.targets);
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.state.visibility = "hidden";
    f.fireVisibilityChange();
    expect(f.state.updates).toBe(0);
  });

  test("two foregrounds inside the throttle window check once", () => {
    const f = fakes();
    watchForUpdates(f.targets);
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.fireVisibilityChange();
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS - 1;
    f.fireVisibilityChange();
    expect(f.state.updates).toBe(1);
  });

  test("a foreground after the window checks again", () => {
    const f = fakes();
    watchForUpdates(f.targets);
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.fireVisibilityChange();
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.fireVisibilityChange();
    expect(f.state.updates).toBe(2);
  });

  test("a rejected update is swallowed and still counts as the window's attempt", async () => {
    const f = fakes();
    f.state.updateRejects = true;
    watchForUpdates(f.targets);
    f.state.now += UPDATE_CHECK_MIN_INTERVAL_MS;
    f.fireVisibilityChange();
    await Promise.resolve();
    // Nothing threw out of the listener; the throttled attempt is spent.
    f.fireVisibilityChange();
    expect(f.state.updates).toBe(1);
  });
});

describe("registerServiceWorker wiring", () => {
  // The module caches its registration promise, so the whole wiring test is
  // one call; happy-dom (root bunfig preload) supplies `document`/`window`.
  test("arms the reload on navigator.serviceWorker, keyed on the load-time controller", async () => {
    const nav = savedNavigator();
    const loc = Object.getOwnPropertyDescriptor(globalThis.window, "location");
    try {
      const fake = fakeContainer({ controller: {} as ServiceWorker });
      Object.defineProperty(globalThis, "navigator", {
        value: { serviceWorker: fake },
        configurable: true,
        writable: true,
      });
      const reloads: number[] = [];
      stubLocation(() => reloads.push(1));
      registerServiceWorker();
      // Let the registration promise settle while the fake is still installed —
      // after the finally restores the real navigator, its register is gone.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fake.fire();
      expect(reloads.length).toBe(1);

      // Uncontrolled load: the same event must not reload a first visit.
      const fake2 = fakeContainer({ controller: null });
      Object.defineProperty(globalThis, "navigator", {
        value: { serviceWorker: fake2 },
        configurable: true,
        writable: true,
      });
      registerServiceWorker();
      fake2.fire();
      expect(reloads.length).toBe(1);
    } finally {
      restoreNavigator(nav);
      if (loc) Object.defineProperty(globalThis.window, "location", loc);
    }
  });
});

function savedNavigator(): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(globalThis, "navigator");
}

function restoreNavigator(desc: PropertyDescriptor | undefined): void {
  if (desc) Object.defineProperty(globalThis, "navigator", desc);
  else delete (globalThis as Record<string, unknown>).navigator;
}

function fakeContainer(opts: { controller: ServiceWorker | null }) {
  const listeners: Array<() => void> = [];
  return {
    controller: opts.controller,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    register: () => Promise.resolve({ update: () => Promise.resolve() }),
    fire: () => listeners.forEach((l) => void l()),
  };
}

function stubLocation(reload: () => void): void {
  Object.defineProperty(globalThis.window, "location", {
    value: { reload },
    configurable: true,
  });
}
