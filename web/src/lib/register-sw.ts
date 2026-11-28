let registration: Promise<ServiceWorkerRegistration> | null = null;

/** Foreground update checks closer together than this are dropped (ms). */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // Whether *this document* loaded under a worker's control. A page that loaded
  // uncontrolled (a first visit) must not reload when its own fresh install
  // claims it — only an already-controlled page whose controller *changes* is
  // looking at an update.
  const controlledAtLoad = navigator.serviceWorker.controller !== null;
  getServiceWorkerRegistration().catch((error: unknown) => {
    console.error("Service worker registration failed:", error);
  });
  // Armed synchronously, before the registration settles: a worker install left
  // over from a previous page can activate — and take this document over — at
  // any moment, and only `update()` actually needs the registration.
  watchForUpdates({
    container: navigator.serviceWorker,
    doc: document,
    controlledAtLoad,
    update: () => getServiceWorkerRegistration().then((reg) => reg.update()),
    reload: () => window.location.reload(),
  });
}

/**
 * This page's registration, or a rejection carrying the browser's own reason it
 * could not register. Push code awaits this instead of
 * `navigator.serviceWorker.ready`, which never settles when registration failed —
 * that is what left Settings → Notifications with a disabled button and no
 * explanation.
 */
export function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  registration ??= pageLoaded().then(() =>
    navigator.serviceWorker.register("/sw.js", {
      // Classic, not module, in the built app. Chrome fetches a *module*
      // service-worker script without cookies, so behind Cloudflare Access it
      // carries no CF_Authorization, gets redirected to the login page, and a
      // redirected worker script is a hard failure ("The script resource is
      // behind a redirect"). A classic script fetch sends the cookie. The build
      // emits sw.js as an IIFE (vite.config.ts `rollupFormat`) so it is valid as
      // a classic script. Dev stays "module": vite-plugin-pwa serves sw.ts
      // unbundled there, imports and all.
      type: import.meta.env.DEV ? "module" : "classic",
    }),
  );
  return registration;
}

/** The world `watchForUpdates` touches, as structural fakes can reach it. */
export interface UpdateWatchTargets {
  container: { addEventListener: (type: "controllerchange", listener: () => void) => void };
  doc: { visibilityState: string; addEventListener: (type: string, listener: () => void) => void };
  update: () => Promise<unknown>;
  controlledAtLoad: boolean;
  reload: () => void;
  now?: () => number;
}

let reloadBlocked = false;
let pendingReload: (() => void) | null = null;

/**
 * Hold the self-reload while the page holds work a reload would throw away with
 * no way back — today that is only staged attachments (typed text has its own
 * draft store). The app calls it with `false` the moment such work is gone; an
 * update that arrived while blocked reloads then, so the reload is never a
 * surprise *and* never a data loss.
 */
export function blockUpdateReload(blocked: boolean): void {
  reloadBlocked = blocked;
  if (!blocked && pendingReload) {
    const reload = pendingReload;
    pendingReload = null;
    reload();
  }
}

function takeReload(reload: () => void): void {
  if (reloadBlocked) pendingReload = reload;
  else reload();
}

/**
 * Make an open tab pick up a new build by itself.
 *
 * The worker side already activates immediately (`sw.ts` `skipWaiting` +
 * `clientsClaim`) and the BFF serves `sw.js` `no-store`, but an open document
 * keeps running the bundle it loaded until something reloads it — and a phone
 * PWA parked in the back stack for days never navigates. So:
 *
 * - **`controllerchange` → reload**, but only for a page that was already
 *   controlled at load: a controller change under an already-controlled page
 *   can only mean a new worker took over, i.e. an update landed. (The load-time
 *   guard is also what stops a reload loop: after the reload the page is
 *   controlled by the new worker and no further change fires.)
 * - **a foreground update check** at most once a minute: coming back into view
 *   is the moment a returning user expects "latest", and it beats waiting for
 *   the browser's own ≤ daily check. `update()` may reject (offline, abort) —
 *   the next navigation re-checks anyway, so the result is dropped.
 */
export function watchForUpdates(targets: UpdateWatchTargets): void {
  const now = targets.now ?? (() => Date.now());
  if (targets.controlledAtLoad) {
    targets.container.addEventListener("controllerchange", () =>
      takeReload(() => targets.reload()),
    );
  }
  let lastCheckAt = now();
  targets.doc.addEventListener("visibilitychange", () => {
    if (targets.doc.visibilityState !== "visible") return;
    const at = now();
    if (at - lastCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS) return;
    lastCheckAt = at;
    void targets.update().catch(() => {});
  });
}

/** Registering after `load` keeps the worker's install off the first paint. */
function pageLoaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}
