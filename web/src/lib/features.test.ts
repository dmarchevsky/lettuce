import { describe, expect, test } from "bun:test";
import { type FeatureFlags, featureEnabled } from "./features.ts";

const ALL_ON: FeatureFlags = {
  web: true,
  google: true,
  codex: true,
  claude: true,
  pi: true,
  telegram: true,
};

describe("featureEnabled", () => {
  test("absent flags — an older BFF — mean everything is on", () => {
    for (const name of ["web", "google", "codex", "claude", "pi", "telegram"] as const) {
      expect(featureEnabled(undefined, name)).toBe(true);
    }
  });

  test("a token that is on is on, and one that is off is off", () => {
    expect(featureEnabled(ALL_ON, "web")).toBe(true);
    expect(
      featureEnabled(
        { web: false, google: true, codex: false, claude: true, pi: true, telegram: false },
        "web",
      ),
    ).toBe(false);
    expect(
      featureEnabled(
        { web: false, google: true, codex: false, claude: true, pi: true, telegram: false },
        "google",
      ),
    ).toBe(true);
    // An older BFF sends no `telegram` flag; hiding the section is right there,
    // because that BFF has no routes behind it either.
    expect(featureEnabled({ ...ALL_ON, telegram: false }, "telegram")).toBe(false);
  });
});
