import { describe, expect, test } from "bun:test";
import { describeImagesStatus, type ImagesStatus } from "./images.ts";

const BASE: ImagesStatus = {
  enabled: true,
  configured: true,
  baseUrl: "http://192.0.2.10:8731/v1",
  model: "flux.1-dev",
  size: "512x512",
  hasKey: false,
  modErrors: [],
  modInstalled: true,
};

describe("describeImagesStatus", () => {
  test("ready, before anyone has drawn a test picture", () => {
    expect(describeImagesStatus(BASE)).toBe("Configured & ready.");
  });

  test("the last test draw's own time is the proof, when there was one", () => {
    expect(
      describeImagesStatus(BASE, {
        ok: true,
        dataUrl: "data:image/png;base64,AA",
        durationSeconds: 3.4,
      }),
    ).toBe("Configured & ready — last test draw took 3.4 s.");
  });

  test("a failed draw says so with the server's words", () => {
    expect(describeImagesStatus(BASE, { ok: false, error: "size 512x512 is not supported" })).toBe(
      "Last test draw failed: size 512x512 is not supported",
    );
  });

  test("a complete but switched-off endpoint says what the toggle is holding back", () => {
    expect(describeImagesStatus({ ...BASE, enabled: false, configured: false })).toBe(
      "Configured but switched off — the agents have no generate_image yet.",
    );
  });

  test("nothing configured yet, whatever the toggle claims", () => {
    expect(describeImagesStatus({ ...BASE, baseUrl: "", model: null, configured: false })).toBe(
      "Not configured yet — an endpoint URL and a model are both required.",
    );
  });
});
