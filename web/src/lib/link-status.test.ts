import { describe, expect, test } from "bun:test";
import { deriveLinkStatus } from "./link-status.ts";

describe("deriveLinkStatus", () => {
  test("both axes healthy: today's Live", () => {
    expect(deriveLinkStatus("live", "connected")).toEqual({
      label: "Live",
      tone: "ok",
      favicon: "live",
    });
  });

  test("app-server gone while the browser's own socket is fine names the server", () => {
    // The case the single-axis dot showed as green "Live".
    expect(deriveLinkStatus("live", "disconnected")).toEqual({
      label: "App-server offline",
      tone: "bad",
      favicon: "offline",
    });
  });

  test("an offline link with a dead server says the server, not the device", () => {
    // `__bff_upstream_state` sets link "offline" on the transition; the word
    // must still say which side went away.
    expect(deriveLinkStatus("offline", "disconnected").label).toBe("App-server offline");
  });

  test("upstream reconnecting is amber whatever the link is doing", () => {
    expect(deriveLinkStatus("live", "connecting")).toEqual({
      label: "Connecting to app-server…",
      tone: "warn",
      favicon: "reconnecting",
    });
    expect(deriveLinkStatus("reconnecting", "connecting").label).toBe(
      "Connecting to app-server…",
    );
  });

  test("device-side states keep their labels when the server is connected", () => {
    expect(deriveLinkStatus("reconnecting", "connected").label).toBe("Reconnecting…");
    expect(deriveLinkStatus("resyncing", "connected").label).toBe("Resyncing…");
    expect(deriveLinkStatus("connecting", "connected").label).toBe("Connecting…");
    // Socket down but the BFF last saw the server up: still the device's fault.
    expect(deriveLinkStatus("offline", "connected").label).toBe("Offline");
  });

  test("signed-out outranks a server-side outage: it is the one state the user can fix", () => {
    expect(deriveLinkStatus("signed-out", "disconnected")).toEqual({
      label: "Sign in again",
      tone: "bad",
      favicon: "signed-out",
    });
  });
});
