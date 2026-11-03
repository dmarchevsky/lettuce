import { describe, expect, test } from "bun:test";
import { errorMessage, friendlyServerError } from "./errors.ts";

describe("errorMessage", () => {
  test("passes everything through — the raw wire string, unpolished", () => {
    expect(errorMessage(new Error("App-server is not connected"))).toBe(
      "App-server is not connected",
    );
    expect(errorMessage(new Error("Connection lost"))).toBe("Connection lost");
    expect(errorMessage("plain string")).toBe("plain string");
  });
});

describe("friendlyServerError", () => {
  test("the one retryable BFF rejection becomes app state, not blame", () => {
    expect(friendlyServerError("App-server is not connected")).toBe(
      "App-server is offline — retrying automatically.",
    );
  });

  test("everything else — including its lookalikes — passes through", () => {
    expect(friendlyServerError("Not connected")).toBe("Not connected");
    expect(friendlyServerError("Connection lost")).toBe("Connection lost");
    expect(friendlyServerError("")).toBe("");
  });
});
