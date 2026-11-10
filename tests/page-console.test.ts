/**
 * The console gate `ui-check` runs every page through.
 *
 * The suite once stayed green over a render loop that shipped broken, so the
 * console became an assertion surface — and an allowlist with no test is how that
 * kind of gate quietly stops asserting: a broad entry forgives the failure it was
 * written to catch. These are the lines the listener actually sees, judged without
 * a browser in the way.
 */
import { expect, test } from "bun:test";
import { classifyConsoleError, newTrouble, record } from "../scripts/page-console.ts";

const sample = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

test("a thrown error with no message body is still not forgiven", () => {
  expect(classifyConsoleError("TypeError: x is not a function")).toContain("console: TypeError");
});

test("a 5xx off the API is a failure, not a failed load", () => {
  // Chromium reports every failed request under one prefix; only the harness's own
  // missing icon is noise.
  const text = "Failed to load resource: the server responded with a status of 500";
  expect(classifyConsoleError(text, "http://127.0.0.1:8090/api/conversations")).toBeTruthy();
  expect(classifyConsoleError(text, "http://127.0.0.1:8090/favicon.ico")).toBeNull();
  expect(
    classifyConsoleError(
      "Failed to load resource: net::ERR_CONNECTION_REFUSED",
      "/site.webmanifest",
    ),
  ).toBeNull();
});

test("the harness's own noise is forgiven", () => {
  expect(
    classifyConsoleError("Failed to load resource: net::ERR_FILE_NOT_FOUND", "/favicon-32.png"),
  ).toBeNull();
  expect(
    classifyConsoleError(
      "The script has an unsupported MIME type ('text/html') for a service worker",
    ),
  ).toBeNull();
  expect(
    classifyConsoleError("ResizeObserver loop completed with undelivered notifications."),
  ).toBeNull();
  expect(classifyConsoleError("AbortError: The user aborted a request.")).toBeNull();
  expect(
    classifyConsoleError("WebSocket is closed before the connection is established"),
  ).toBeNull();
});

test("the render-loop message a real React dev build logs is caught", () => {
  expect(
    classifyConsoleError(
      "Uncaught Error: Maximum update depth exceeded. This can happen when a " +
        "component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.",
    ),
  ).toContain("Maximum update depth exceeded");
});

test("a loop keeps its true count but stops filling the report", () => {
  const entry = newTrouble("page 1 (390px)");
  for (const line of sample(40)) record(entry, line);
  expect(entry.fatal).toBe(40);
  expect(entry.errors.length).toBe(3);
  expect(entry.errors[0]).toBe("line 0");
});
