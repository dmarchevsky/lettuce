import { defaultStorage, type MaybeStorage, readStored } from "./storage.ts";

/**
 * The composer textarea's manual height, in CSS pixels.
 *
 * The box auto-fits its text by default; dragging the grip on the box's top
 * border pins it to a chosen height instead, and that height is remembered
 * per device — it is an ergonomic preference, not conversation state, so it
 * lives beside the other device preferences and survives conversations, tabs,
 * and sign-outs. `null` (the absence of a stored value) means auto-fit.
 */

const KEY = "lettuce:composer-height";

/** Below one comfortable line plus the grip, the box stops being usable. */
export const MIN_MANUAL_HEIGHT = 48;

/**
 * Pin the height between one line and a share of the viewport. `viewportHeight`
 * is a parameter so the rule is testable without a window; the caller passes
 * `window.innerHeight`, which covers rotation and window resize honestly.
 */
export function clampComposerHeight(px: number, viewportHeight: number): number {
  const max = Math.max(MIN_MANUAL_HEIGHT, Math.floor(viewportHeight * 0.5));
  return Math.min(Math.max(Math.round(px), MIN_MANUAL_HEIGHT), max);
}

export function readComposerHeight(storage: MaybeStorage = defaultStorage()): number | null {
  const raw = readStored(storage, KEY);
  if (raw === null) return null;
  const px = Number(raw);
  if (!raw || !Number.isFinite(px) || px < MIN_MANUAL_HEIGHT) return null;
  return Math.round(px);
}

/** Writing `null` forgets the height and returns the box to auto-fit; an
 * unparseable stored value reads back as auto-fit too. */
export function writeComposerHeight(
  px: number | null,
  storage: MaybeStorage = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY, px === null ? "" : String(Math.round(px)));
  } catch {
    // Same rule as every other stored preference: a throw means no memory,
    // never a failed send.
  }
}
