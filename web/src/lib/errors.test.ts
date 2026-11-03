import { describe, expect, test } from "bun:test";
import { errorMessage } from "./errors.ts";

describe("errorMessage", () => {
  test("the app-server-down rejection reads as the app's own state, with the retry it promises", () => {
    expect(errorMessage(new Error("App-server is not connected"))).toBe(
      "App-server is offline — retrying automatically.",
    );
  });

  test("every other message passes through untouched", () => {
    expect(errorMessage(new Error("Connection lost"))).toBe("Connection lost");
    expect(errorMessage("plain string")).toBe("plain string");
    // The client's own pre-socket rejection is a different string and stays.
    expect(errorMessage(new Error("Not connected"))).toBe("Not connected");
  });
});
