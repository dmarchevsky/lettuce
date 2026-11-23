import { expect, test } from "bun:test";
import { readTaskRunEntries } from "./task-runs.ts";

/** A record the way the event log writes it: `seq` and `at` first, then the type's fields. */
const record = (seq: number, fields: Record<string, unknown>) => ({ seq, at: "t", ...fields });

test("a call and its result fold into one entry", () => {
  const entries = readTaskRunEntries([
    record(1, { type: "tool_call", id: "c1", name: "Bash", input: { command: "ls" } }),
    record(2, { type: "tool_result", tool_call_id: "c1", is_error: false, output: "a\nb" }),
  ]);
  expect(entries).toHaveLength(1);
  const [call] = entries;
  expect(call?.kind === "call" && call.name).toBe("Bash");
  expect(call?.kind === "call" && call.input).toContain("ls");
  expect(call?.kind === "call" && call.output).toBe("a\nb");
  expect(call?.kind === "call" && call.isError).toBe(false);
});

test("an error result keeps the error state", () => {
  const [call] = readTaskRunEntries([
    record(1, { type: "tool_call", id: "c1", name: "Bash", input: {} }),
    record(2, { type: "tool_result", tool_call_id: "c1", is_error: true, output: "boom" }),
  ]);
  expect(call?.kind === "call" && call.isError).toBe(true);
});

test("a call whose result has not arrived renders with no output", () => {
  const [call] = readTaskRunEntries([
    record(1, { type: "tool_call", id: "c1", name: "Read", input: { file_path: "/x" } }),
  ]);
  expect(call?.kind === "call" && call.output).toBeNull();
});

test("a result whose call is off the page keeps itself", () => {
  // A page starts wherever the cursor says; dropping orphans would hide exactly
  // the output a reader scrolling back for came to read.
  const entries = readTaskRunEntries([
    record(9, {
      type: "tool_result",
      tool_call_id: "c0",
      name: "Grep",
      is_error: false,
      output: "found it",
    }),
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.kind === "call" && entries[0].name).toBe("Grep");
  expect(entries[0]?.kind === "call" && entries[0].output).toBe("found it");
});

test("upstream's cut marker marks the entry truncated", () => {
  const [call] = readTaskRunEntries([
    record(1, { type: "tool_call", id: "c1", name: "Read", input: "x".repeat(10) }),
    record(2, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: false,
      output: `body\n[truncated 248310 bytes]`,
    }),
  ]);
  expect(call?.kind === "call" && call.truncated).toBe(true);
});

test("text, reasoning and notification keep their kind", () => {
  const entries = readTaskRunEntries([
    record(1, { type: "text", text: "looking now" }),
    record(2, { type: "reasoning", text: "hmm" }),
    record(3, { type: "notification", text: "done" }),
  ]);
  expect(entries.map((entry) => entry.kind)).toEqual(["text", "text", "notification"]);
  expect(entries[1]?.kind === "text" && entries[1].reasoning).toBe(true);
});

test("a blank text record is no entry at all", () => {
  expect(readTaskRunEntries([record(1, { type: "text", text: "" })])).toEqual([]);
});

test("an events_missed record says how many", () => {
  const [notice] = readTaskRunEntries([record(1, { type: "events_missed", missed: 38 })]);
  expect(notice?.kind).toBe("notice");
  expect(notice?.kind === "notice" && notice.text).toContain("38");
});

test("the log-full status is a notice", () => {
  const [notice] = readTaskRunEntries([record(1, { type: "status", status: "event_log_full" })]);
  expect(notice?.kind).toBe("notice");
});

test("a record of an unknown type is dropped, not thrown", () => {
  const entries = readTaskRunEntries([
    record(1, { type: "whatever_we_haven't_seen", noise: true }),
    record(2, { type: "text", text: "still here" }),
  ]);
  expect(entries).toHaveLength(1);
});

test("a call whose arguments arrived as a string keeps them verbatim", () => {
  // A stream can hand arguments through unparsed; the summariser takes JSON.
  const [call] = readTaskRunEntries([
    record(1, { type: "tool_call", id: "c1", name: "Read", input: '{"file_path":"/x"}' }),
  ]);
  expect(call?.kind === "call" && call.input).toBe('{"file_path":"/x"}');
});
