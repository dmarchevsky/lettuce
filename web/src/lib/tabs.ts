import type { FeatureFlags } from "./features.ts";
import { featureEnabled } from "./features.ts";

/**
 * The panes, in rail order. Chat is the primary one — the default, the only one
 * with a composer, and the one the conversation drawer belongs to — and the rest
 * are secondary, reached from the desktop rail or the phone's bottom bar.
 *
 * `Settings` is a pane like any other — it used to be a modal over the pane you
 * were reading, which meant the app had two navigation systems and one of them hid
 * the other. It is in this list so the phone's More row lands where the desktop
 * rail's foot cell does, but the rail does not show it among the pane cells: with
 * Settings open, its sections replace the pane list, and that column's Back cell
 * (or the corner X) is the way out — to Chat.
 */
export const TABS = ["Chat", "Files", "Tasks", "Runs", "Tools", "Agent", "Settings"] as const;
export type Tab = (typeof TABS)[number];

/** `Runs` is a pane only where a coding worker is deployed; elsewhere it is absent. */
export function runsEnabled(features: FeatureFlags | undefined): boolean {
  return (
    featureEnabled(features, "codex") ||
    featureEnabled(features, "claude") ||
    featureEnabled(features, "pi")
  );
}

/** The pane a `?tab=` value names, or Chat. */
export function tabFor(name: string | null | undefined): Tab {
  return (TABS as readonly string[]).includes(name ?? "") ? (name as Tab) : "Chat";
}

/**
 * Whether the desktop conversation panel is pinned, per device.
 *
 * Pinned is the default because that is the layout the app shipped with: the
 * panel is a column and Chat opens with it. Unpinned it is a peek the rail
 * summons, which gives the transcript the panel's width back — a taste, not a
 * migration.
 */
const PANEL_PIN_KEY = "lettuce:panel-pinned";

export function readPanelPin(): boolean {
  try {
    // The drawer starts SHUT: the rail carries the agent names now, so the column
    // of conversations is a thing you reach for rather than one you live beside.
    // Only an explicit "1" — someone pressed the pin — makes it a standing column.
    return globalThis.localStorage?.getItem(PANEL_PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writePanelPin(pinned: boolean): void {
  try {
    globalThis.localStorage?.setItem(PANEL_PIN_KEY, pinned ? "1" : "0");
  } catch {
    /* Private mode: the choice just does not survive the reload. */
  }
}
