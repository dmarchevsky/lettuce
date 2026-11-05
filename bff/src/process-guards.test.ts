import { expect, test } from "bun:test";
import { isTransientSocketError, uncaughtExceptionHandler } from "./process-guards.ts";

function withCode<T extends Error>(error: T, code: string): T {
  return Object.assign(error, { code });
}

test("reachability problems are not defects", () => {
  expect(isTransientSocketError(withCode(new Error("connect ECONNREFUSED"), "ECONNREFUSED"))).toBe(
    true,
  );
  for (const code of ["ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]) {
    expect(isTransientSocketError(withCode(new Error(code), code))).toBe(true);
  }
  // Bun's ws shim hands the handshake failure to EventEmitter, which throws this
  // wrapper — with the real ErrorEvent, and its message, on `.context`.
  expect(
    isTransientSocketError(
      withCode(
        new Error("Unhandled error. (ErrorEvent { isTrusted: [Getter] })"),
        "ERR_UNHANDLED_ERROR",
      ),
    ),
  ).toBe(true);
  if (typeof ErrorEvent !== "undefined")
    expect(isTransientSocketError(new ErrorEvent("boom"))).toBe(true);
});

test("a real bug stays fatal", () => {
  expect(isTransientSocketError(new TypeError("cannot read property of undefined"))).toBe(false);
  expect(isTransientSocketError(withCode(new Error("no such file"), "ENOENT"))).toBe(false);
  // A message that only names a code is not evidence of one.
  expect(isTransientSocketError(new Error("read ECONNRESET"))).toBe(false);
  expect(isTransientSocketError(undefined)).toBe(false);
  expect(isTransientSocketError("ECONNREFUSED")).toBe(false);
});

test("the handler drops the socket error and ends the process for anything else", () => {
  const logs: string[] = [];
  let fatal: unknown = null;
  const handler = uncaughtExceptionHandler({
    log: (message) => logs.push(message),
    onFatal: (error) => {
      fatal = error;
    },
  });

  handler(withCode(new Error("connect ECONNREFUSED 127.0.0.1:4500"), "ECONNREFUSED"));
  expect(fatal).toBe(null);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("Ignoring a transient socket error");

  const bug = new TypeError("cannot read property of undefined");
  handler(bug);
  expect(fatal).toBe(bug);
  expect(logs[1]).toContain("the process is ending");
});
