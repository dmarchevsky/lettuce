/** Chromium's User-Agent Client Hints; not in TypeScript's DOM lib. */
type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

/**
 * The OS name the browser admits to: Chromium's `userAgentData.platform`, or
 * "Windows" from the user-agent string where that is absent (Firefox, and
 * any page served over plain HTTP, since the client hints need a secure
 * context). Anything else is undefined.
 */
export function detectPlatform(
  nav: { userAgentData?: { platform?: string }; userAgent?: string } | undefined,
): string | undefined {
  const hinted = nav?.userAgentData?.platform;
  if (hinted) return hinted;
  if (nav?.userAgent?.includes("Windows NT")) return "Windows";
  return undefined;
}

/** What `enterSends` decides from; passed in so a test never reads its runner's globals. */
export interface InputEnv {
  matchMedia?: (query: string) => { matches: boolean };
  platform?: string;
  /** The screen's shorter side in CSS pixels. */
  shortSide?: number;
}

/** The browser this page is running in, as `enterSends` reads it. */
export function currentInputEnv(): InputEnv {
  const screen = globalThis.screen as Screen | undefined;
  return {
    matchMedia: globalThis.matchMedia?.bind(globalThis),
    platform: detectPlatform(globalThis.navigator as NavigatorWithUAData | undefined),
    shortSide: screen ? Math.min(screen.width, screen.height) : undefined,
  };
}

/**
 * Whether Enter sends the message.
 *
 * On a phone the on-screen keyboard's Enter is where people reach for a new
 * line, and an accidental send cannot be taken back — so there Enter is a
 * newline and only the send button sends. A touch-first device is one whose
 * primary pointer is coarse and cannot hover. A Windows 2-in-1 (a Surface)
 * reports exactly that while its owner types on a hardware keyboard, and
 * Windows has no phones, so there the OS is the signal and Enter sends. That
 * includes a Surface with its keyboard detached, on the touch keyboard:
 * Chromium reports the same pointer either way, so nothing tells the two
 * postures apart, and Enter-to-send is the trade accepted. Where
 * `userAgentData` is absent (Firefox, plain HTTP) the user agent's
 * `Windows NT` is the fallback. iOS and iPadOS browsers report neither, so
 * they keep the media-query decision.
 *
 * Known edge: an Android browser's "desktop site" mode rewrites the user
 * agent. Chrome, Samsung Internet and Firefox claim "X11; Linux x86_64", which
 * is not Windows, so they are unaffected; some (Edge for Android) claim
 * "Windows NT". The short-side guard catches those: desktop mode cannot fake
 * the screen, a phone is some 360–430 CSS px across, and a Surface is far
 * above 600.
 */
export function enterSends(env: InputEnv = currentInputEnv()): boolean {
  if (env.platform === "Windows" && (env.shortSide === undefined || env.shortSide >= 600)) {
    return true;
  }
  if (!env.matchMedia) return true;
  return !env.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
