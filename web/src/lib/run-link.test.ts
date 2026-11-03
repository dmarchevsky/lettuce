import { describe, expect, test } from "bun:test";
import type { LiveSubagent } from "./subagents.ts";
import {
  type LinkableRun,
  resolveLiveWorkerRun,
  workerKindOf,
  LINK_FRESH_MS,
} from "./run-link.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function worker(over: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    status: "running",
    subagentType: "codex",
    description: "refactor the parser",
    toolCalls: [],
    startTime: NOW - 60_000,
    durationMs: 60_000,
    totalTokens: 0,
    ...over,
  };
}

function run(over: Partial<LinkableRun> = {}): LinkableRun {
  return {
    status: "running",
    startedAt: iso(-60_000),
    lastActivityAt: iso(-2_000),
    ...over,
  };
}

describe("workerKindOf", () => {
  test("only the two external kinds link", () => {
    expect(workerKindOf("codex")).toBe("codex");
    expect(workerKindOf("claude-code")).toBe("claude");
    expect(workerKindOf("general-purpose")).toBeNull();
    expect(workerKindOf("")).toBeNull();
  });
});

describe("resolveLiveWorkerRun", () => {
  test("one live worker, one fresh running run, starts agree → linked", () => {
    const w = worker();
    const r = run();
    expect(resolveLiveWorkerRun(w, [w], [r], NOW, "codex")).toBe(r);
  });

  test("a plain snapshot never resolves", () => {
    const w = worker({ subagentType: "general-purpose" });
    expect(resolveLiveWorkerRun(w, [w], [run()], NOW, "codex")).toBeNull();
  });

  test("two live workers of the kind → no link for either", () => {
    const a = worker();
    const b = worker({ startTime: NOW - 30_000 });
    const r = run();
    expect(resolveLiveWorkerRun(a, [a, b], [r], NOW, "codex")).toBeNull();
    expect(resolveLiveWorkerRun(b, [a, b], [r], NOW, "codex")).toBeNull();
  });

  test("two running runs → no link (fan-out stays with the Runs tab)", () => {
    const w = worker();
    expect(resolveLiveWorkerRun(w, [w], [run(), run({ startedAt: iso(-58_000) })], NOW, "codex")).toBeNull();
  });

  test("completed runs are not candidates", () => {
    const w = worker();
    const r = run({ status: "completed" });
    expect(resolveLiveWorkerRun(w, [w], [r], NOW, "codex")).toBeNull();
  });

  test("a crashed run keeps running status but goes stale", () => {
    const w = worker();
    const stale = run({ lastActivityAt: iso(-(LINK_FRESH_MS + 1_000)) });
    expect(resolveLiveWorkerRun(w, [w], [stale], NOW, "codex")).toBeNull();
  });

  test("start clocks too far apart → no link (it is someone else's run)", () => {
    const w = worker({ startTime: NOW - 10 * 60_000 });
    expect(resolveLiveWorkerRun(w, [w], [run()], NOW, "codex")).toBeNull();
  });

  test("durationMs covers a snapshot without start_time", () => {
    const w = worker({ startTime: undefined, durationMs: 61_000 });
    const r = run();
    expect(resolveLiveWorkerRun(w, [w], [r], NOW, "codex")).toBe(r);
  });

  test("a run with no timestamps at all is never a candidate", () => {
    const w = worker();
    expect(
      resolveLiveWorkerRun(w, [w], [run({ startedAt: null, lastActivityAt: null })], NOW, "codex"),
    ).toBeNull();
  });

  test("the claude kind reads claude runs only", () => {
    const w = worker({ subagentType: "claude-code" });
    const r = run();
    expect(resolveLiveWorkerRun(w, [w], [r], NOW, "claude")).toBe(r);
    expect(resolveLiveWorkerRun(w, [w], [r], NOW, "codex")).toBeNull();
  });
});
