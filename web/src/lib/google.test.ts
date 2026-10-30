import { expect, test } from "bun:test";
import { reachesAddresses, recipientLines, shortScope, wouldNarrow } from "./google.ts";

const base = { gmail: "send", calendar: "full", tasks: "manage", contacts: "full" };

test("wouldNarrow flags a lower level or a service turned off", () => {
  expect(wouldNarrow(base, { ...base, gmail: "readonly" })).toBe(true);
  expect(wouldNarrow(base, { ...base, calendar: null })).toBe(true);
  expect(wouldNarrow(base, { ...base, gmail: "full" })).toBe(false);
  expect(wouldNarrow(base, { ...base, contacts: "readonly" })).toBe(true);
  expect(wouldNarrow({ ...base, contacts: null }, { ...base })).toBe(false);
});

test("tasks manage and full share a scope, so neither direction narrows", () => {
  expect(wouldNarrow({ ...base, tasks: "full" }, base)).toBe(false);
  expect(wouldNarrow(base, { ...base, tasks: "full" })).toBe(false);
});

test("reachesAddresses: Gmail send or full, or Calendar full", () => {
  const off = { gmail: null, calendar: null, tasks: "full", contacts: "full" };
  expect(reachesAddresses(off)).toBe(false);
  expect(reachesAddresses({ ...off, gmail: "drafts", calendar: "readonly" })).toBe(false);
  expect(reachesAddresses({ ...off, gmail: "send" })).toBe(true);
  expect(reachesAddresses({ ...off, gmail: "full" })).toBe(true);
  expect(reachesAddresses({ ...off, calendar: "full" })).toBe(true);
});

test("recipientLines: one entry per line, trimmed, lowercased, no blanks or repeats", () => {
  expect(recipientLines(" A@Example.com \n\n@example.org\na@example.com\n")).toEqual([
    "a@example.com",
    "@example.org",
  ]);
  expect(recipientLines("")).toEqual([]);
});

test("shortScope", () => {
  expect(shortScope("https://www.googleapis.com/auth/gmail.readonly")).toBe("gmail.readonly");
  expect(shortScope("openid")).toBe("openid");
});
