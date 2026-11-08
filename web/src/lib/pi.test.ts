import { expect, test } from "bun:test";
import { type PiRunSummary, piRunNumber, piRunOptions } from "./pi.ts";

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
