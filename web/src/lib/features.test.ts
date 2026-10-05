import { describe, expect, test } from "bun:test";
import { type FeatureFlags, featureEnabled } from "./features.ts";

const ALL_ON: FeatureFlags = { web: true, google: true, codex: true, claude: true, pi: true };

describe("featureEnabled", () => {
  test("absent flags — an older BFF — mean everything is on", () => {
    for (const name of ["web", "google", "codex", "claude", "pi"] as const) {
      expect(featureEnabled(undefined, name)).toBe(true);
    }
  });

  test("a token that is on is on, and one that is off is off", () => {
    expect(featureEnabled(ALL_ON, "web")).toBe(true);
    expect(
      featureEnabled({ web: false, google: true, codex: false, claude: true, pi: true }, "web"),
    ).toBe(false);
    expect(
      featureEnabled({ web: false, google: true, codex: false, claude: true, pi: true }, "google"),
    ).toBe(true);
  });
});
