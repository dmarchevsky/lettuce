import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  getPushPreferences,
  isIOS,
  isPushSupported,
  isStandalone,
  isSubscribed,
  type PushPreferences,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
  updatePushPreferences,
} from "../lib/push.ts";
import { MenuRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

const NOTIFICATION_EVENT_TYPES: { key: keyof PushPreferences; label: string }[] = [
  { key: "completed", label: "Turn completed" },
  { key: "failed", label: "Turn failed" },
  { key: "approval", label: "Approval needed" },
];

export function NotificationsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  /** Only "this device cannot push", which is a state — every press reports itself
   * as a toast, so nothing else may leave this box filled. */
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!isPushSupported()) {
      setEnabled(false);
      return;
    }
    setStatus("");
    try {
      // Without the catch a failed service worker left `enabled` null forever —
      // a disabled button with no reason given. Surface the browser's own error;
      // the button stays usable, and pressing it reports the same failure again.
      const subscribed = await isSubscribed();
      setEnabled(subscribed);
      if (subscribed) setPreferences(await getPushPreferences());
    } catch (cause) {
      setEnabled(false);
      setStatus(`Notifications are unavailable: ${errorMessage(cause)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    try {
      if (enabled) {
        await unsubscribeFromPush();
        setEnabled(false);
        setPreferences(null);
        toast("Notifications off on this device.");
      } else {
        await subscribeToPush();
        setEnabled(true);
        setPreferences(await getPushPreferences());
        toast("Notifications on for this device.");
      }
    } catch (cause) {
      toast(
        `Could not ${enabled ? "turn off" : "turn on"} notifications on this device: ${errorMessage(cause)}`,
        "bad",
      );
    }
  };

  const togglePreference = async (key: keyof PushPreferences, value: boolean) => {
    const previous = preferences;
    if (!previous) return;
    setPreferences({ ...previous, [key]: value });
    try {
      await updatePushPreferences({ [key]: value });
    } catch (cause) {
      setPreferences(previous);
      toast(`Could not save that: ${errorMessage(cause)}`, "bad");
    }
  };

  const sendTest = async () => {
    try {
      await sendTestPush();
      toast(
        "Test notification sent — if it did not appear, check this device's own settings",
        "warn",
      );
    } catch (cause) {
      toast(`Could not send the test: ${errorMessage(cause)}`, "bad");
    }
  };

  // Web Push only reaches an iOS PWA actually added to the Home Screen — a
  // Safari tab (or any browser other than Safari, which is the only one that
  // can install a PWA on iOS at all) never receives it, silently.
  if (isIOS() && !isStandalone()) {
    return (
      <p className="muted small pad">
        Add this app to your Home Screen (Safari's Share menu → Add to Home Screen) to enable
        notifications on iPhone or iPad — Web Push only reaches an installed app there, never a
        browser tab.
      </p>
    );
  }

  if (!isPushSupported()) {
    return <p className="muted small pad">Push notifications are not supported in this browser.</p>;
  }

  return (
    <>
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      <p className="muted small pad">
        Sends a notification to this device when the agent finishes a turn, hits an error, or needs
        a tool approval — while you're not watching that conversation.
      </p>
      <div className="pad-x">
        <button
          type="button"
          className="button"
          disabled={enabled === null}
          onClick={() => void toggle()}
        >
          {enabled ? "Disable notifications" : "Enable notifications"}
        </button>
      </div>
      {enabled ? (
        <div className="pad-x">
          <button type="button" className="button" onClick={() => void sendTest()}>
            Send a test notification
          </button>
        </div>
      ) : null}
      {enabled && preferences ? (
        <ul className="menu-list pad-x">
          {NOTIFICATION_EVENT_TYPES.map(({ key, label }) => (
            <MenuRow
              key={key}
              title={label}
              mark="checkbox"
              selected={preferences[key]}
              onClick={() => void togglePreference(key, !preferences[key])}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
