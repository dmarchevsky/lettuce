/**
 * The browser-push registration routes behind Settings → Notifications: which
 * VAPID key the client subscribes with, the subscriptions themselves, their
 * per-device preferences, and a route that proves delivery end to end.
 *
 * Everything is BFF-local — the subscriptions live on the `bff-data` volume —
 * so the only thing borrowed from `index.ts` is the store, the VAPID public key
 * and the log. `index.ts` calls `registerPushRoutes` where these sat, and its
 * `requireSession` middleware already gates `/push/*`.
 */

import type { Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnvWithEmail } from "../route-env.ts";
import { sendPush } from "./send.ts";
import type { PushSubscriptionStore } from "./store.ts";

export interface PushRouteDeps {
  /** Null when the three VAPID settings are absent, which switches push off. */
  store: PushSubscriptionStore | null;
  vapidPublicKey: string | null;
  log: (message: string) => void;
}

const NOT_CONFIGURED = "Push notifications are not configured on this instance";

/** The non-empty `endpoint` a push request body names, or null. */
function endpointOf(body: unknown): string | null {
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
}

export function registerPushRoutes<Env extends RouteEnvWithEmail>(
  app: Hono<Env>,
  deps: PushRouteDeps,
): void {
  const { store, vapidPublicKey, log } = deps;

  app.get("/push/vapid-key", (c) => {
    if (!vapidPublicKey) return c.text(NOT_CONFIGURED, 404);
    return c.json({ key: vapidPublicKey });
  });

  app.post("/push/subscribe", async (c) => {
    const session = c.get("session");
    if (!session) return c.text("Unauthorized", 401);
    if (!store) return c.text(NOT_CONFIGURED, 404);

    try {
      const body = await c.req.json();
      const record = store.add(
        body,
        session.email,
        (body as { preferences?: unknown })?.preferences,
      );
      return c.json({ ok: true, preferences: record.preferences });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Malformed subscription", 400);
    }
  });

  app.post("/push/unsubscribe", async (c) => {
    if (!store) return c.text(NOT_CONFIGURED, 404);

    const body = await c.req.json().catch(() => null);
    const endpoint = endpointOf(body);
    if (!endpoint) return c.text("Missing endpoint", 400);

    store.remove(endpoint);
    return c.json({ ok: true });
  });

  app.get("/push/preferences", (c) => {
    if (!store) return c.text(NOT_CONFIGURED, 404);

    const endpoint = c.req.query("endpoint");
    if (!endpoint) return c.text("Missing endpoint", 400);

    const preferences = store.getPreferences(endpoint);
    if (!preferences) return c.text("Unknown push subscription", 404);
    return c.json({ preferences });
  });

  app.post("/push/preferences", async (c) => {
    if (!store) return c.text(NOT_CONFIGURED, 404);

    const body = await c.req.json().catch(() => null);
    const endpoint = endpointOf(body);
    if (!endpoint) return c.text("Missing endpoint", 400);

    try {
      const record = store.updatePreferences(
        endpoint,
        (body as { preferences?: unknown }).preferences,
      );
      return c.json({ ok: true, preferences: record.preferences });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Unknown push subscription", 404);
    }
  });

  // Delivery, proven end to end, without staging an unwatched turn. Every real
  // trigger is suppressed while a visible session is on that conversation, so a
  // device that is subscribed but undeliverable is otherwise indistinguishable
  // from one that is simply being watched. This route skips that check and the
  // per-event preferences: it is the user asking for exactly this notification.
  app.post("/push/test", async (c) => {
    if (!store) return c.text(NOT_CONFIGURED, 404);

    const body = await c.req.json().catch(() => null);
    const endpoint = endpointOf(body);
    if (!endpoint) return c.text("Missing endpoint", 400);

    const record = store.all().find((candidate) => candidate.endpoint === endpoint);
    if (!record) return c.text("Unknown push subscription", 404);

    try {
      const result = await sendPush(record, {
        title: "Lettuce",
        body: "Test notification — push is working on this device.",
        url: "/",
      });
      if (result === "gone") {
        store.remove(endpoint);
        log(`Push test: ${endpoint} is gone; removed`);
        return c.text(
          "This device's subscription has expired — turn notifications off and on",
          410,
        );
      }
      log(`Push test: sent to ${endpoint}`);
      return c.json({ ok: true });
    } catch (error) {
      log(`Push test to ${endpoint} failed: ${errorMessage(error)}`);
      return c.text(errorMessage(error), 502);
    }
  });
}
