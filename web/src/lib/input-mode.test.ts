import { describe, expect, test } from "bun:test";
import { detectPlatform, enterSends } from "./input-mode.ts";

const media = (touch: boolean) => (query: string) => ({
  matches: touch && query === "(hover: none) and (pointer: coarse)",
});

const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const SAFARI_IPAD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("enterSends", () => {
  test("a phone with no platform hint, as on iOS: Enter is a newline", () => {
    expect(enterSends({ matchMedia: media(true) })).toBe(false);
  });
  test("a desktop: Enter sends", () => {
    expect(enterSends({ matchMedia: media(false), platform: "macOS" })).toBe(true);
  });
  test("no matchMedia at all: Enter sends", () => {
    expect(enterSends({})).toBe(true);
  });
  test("a Windows touch device (a Surface): Enter sends", () => {
    expect(enterSends({ matchMedia: media(true), platform: "Windows", shortSide: 912 })).toBe(true);
  });
  test("Windows without matchMedia: Enter sends", () => {
    expect(enterSends({ platform: "Windows" })).toBe(true);
  });
  test("a phone claiming Windows (Edge for Android, desktop site): Enter is a newline", () => {
    expect(enterSends({ matchMedia: media(true), platform: "Windows", shortSide: 412 })).toBe(
      false,
    );
  });
  test("an Android phone: Enter is a newline", () => {
    expect(enterSends({ matchMedia: media(true), platform: "Android" })).toBe(false);
  });
});

describe("detectPlatform", () => {
  test("userAgentData names the platform", () => {
    expect(detectPlatform({ userAgentData: { platform: "Windows" } })).toBe("Windows");
  });
  test("userAgentData wins over the user-agent string", () => {
    expect(
      detectPlatform({ userAgentData: { platform: "Android" }, userAgent: FIREFOX_WINDOWS }),
    ).toBe("Android");
  });
  test("an empty userAgentData platform falls back to the user agent", () => {
    expect(detectPlatform({ userAgentData: { platform: "" }, userAgent: FIREFOX_WINDOWS })).toBe(
      "Windows",
    );
  });
  test("Firefox on Windows: the user agent's Windows NT", () => {
    expect(detectPlatform({ userAgent: FIREFOX_WINDOWS })).toBe("Windows");
  });
  test("Chrome on Android without userAgentData: no platform", () => {
    expect(detectPlatform({ userAgent: CHROME_ANDROID })).toBeUndefined();
  });
  test("Safari on iPad: no platform", () => {
    expect(detectPlatform({ userAgent: SAFARI_IPAD })).toBeUndefined();
  });
  test("no navigator: no platform", () => {
    expect(detectPlatform(undefined)).toBeUndefined();
  });
});
