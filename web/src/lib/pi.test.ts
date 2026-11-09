import { expect, test } from "bun:test";
import { type PiRunSummary, piRunNumber, piRunOptions, piRunWave } from "./pi.ts";

function run(runId: string, prompt: string, status: PiRunSummary["status"] = "completed") {
  return {
    runId,
    agentId: null,
    session: "s",
    target: "worker@pi.example.invalid",
    kind: "send",
    status,
    startedAt: "2026-10-05T12:00:00.000Z",
    endedAt: null,
    prompt,
    model: null,
    eventCount: 3,
    bytesCaptured: 0,
    lastEventAt: null,
  } satisfies PiRunSummary;
}

test("the run dropdown lists the newest run first, labelled enough to choose from", () => {
  const runs = [
    run("a", "refactor the parser", "completed"),
    run("b", "fix the date test", "running"),
  ];
  const options = piRunOptions(runs);
  expect(options.map((option) => option.runId)).toEqual(["b", "a"]);
  expect(options[0]?.label).toBe("Run 2 · Running · fix the date test");
  expect(options[1]?.label).toBe("Run 1 · Finished · refactor the parser");
});

test("a run dropdown never has a blank option", () => {
  expect(piRunOptions([run("a", "\n", "failed")])[0]?.label).toContain("(no prompt recorded)");
  // Multi-line prompts are one line, whatever the prompt did.
  expect(piRunOptions([run("a", "first\nsecond")])[0]?.label).toBe("Run 1 · Finished · first");
});

test("the number a run is called is the same in the dropdown and on its own line", () => {
  const runs = [run("a", "one"), run("b", "two"), run("c", "three")];
  expect(piRunNumber(runs, "a")).toBe(1);
  expect(piRunNumber(runs, "c")).toBe(3);
  // A run the listing does not carry (swept, or a deep link to another session)
  // still gets a number rather than `NaN` leaking into the boundary line.
  expect(piRunNumber(runs, "zz")).toBe(3);
});

const six = ["r1", "r2", "r3", "r4", "r5", "r6"].map((id) => run(id, `p ${id}`));

test("piRunWave loads a window around the focus, nearest first", () => {
  expect(piRunWave(six, "r6", () => false, 2)).toEqual(["r5", "r4"]);
  expect(piRunWave(six, "r3", () => false, 2)).toEqual(["r4", "r2", "r5", "r1"]);
});

test("piRunWave never reaches past the window, however long the session", () => {
  // The regression this bounds: a wave sized by count and re-derived after each
  // arrival walked the whole session outward, reading every capture in turn.
  expect(piRunWave(six, "r6", () => false, 3)).toEqual(["r5", "r4", "r3"]);
});

test("piRunWave skips what is loaded without shrinking the window", () => {
  expect(piRunWave(six, "r6", (id) => id === "r5", 2)).toEqual(["r4"]);
  expect(piRunWave(six, "r6", () => true, 3)).toEqual([]);
});

test("piRunWave loads nothing for a one-run session or an unknown focus", () => {
  expect(piRunWave([run("only", "p")], "only", () => false, 3)).toEqual([]);
  expect(piRunWave(six, "nope", () => false, 3)).toEqual([]);
});
