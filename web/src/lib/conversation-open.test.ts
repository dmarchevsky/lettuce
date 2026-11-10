import { describe, expect, test } from "bun:test";
import { historyShowsLoadingRow, openConversation } from "./conversation-open.ts";

/**
 * The three things the hook hands `openConversation`, recorded so a test can
 * see what was asked for and when the loading row went away. The history tail
 * always runs when the load lands — the hook's own load catches its failures —
 * so a failed load still takes the row off.
 */
function harness() {
  const calls: string[] = [];
  let history = () => {
    calls.push("!! history never asked for");
  };
  let runtime = () => {
    calls.push("!! runtime never asked for");
  };
  const open = openConversation({
    loadHistory: (onSettled) => {
      calls.push("history asked for");
      history = () => {
        calls.push("history settled");
        onSettled();
      };
    },
    startRuntime: () => {
      calls.push("runtime asked for");
      return new Promise<void>((resolve) => {
        runtime = () => {
          calls.push("runtime settled");
          resolve();
        };
      });
    },
    endLoadingRow: () => calls.push("row cleared"),
  });
  return { calls, open, settleHistory: () => history(), settleRuntime: () => runtime() };
}

describe("opening a conversation", () => {
  test("the history is asked for before the runtime is started", async () => {
    // Not a tautology: `startRuntime` sends a file write and then the start,
    // and anything requested after them queues behind their freeze.
    const h = harness();
    expect(h.calls.slice(0, 2)).toEqual(["history asked for", "runtime asked for"]);
    h.settleHistory();
    h.settleRuntime();
    await h.open;
  });

  test("the transcript is in hand before the slow start is answered", async () => {
    const h = harness();
    h.settleHistory();
    // The point of the whole change: the history and the start are in flight
    // together, so the transcript lands while the start is still replaying.
    // The old code awaited the start first and the shared connection made the
    // history wait behind a seconds-long server-wide freeze.
    expect(h.calls).toContain("row cleared");
    expect(h.calls).not.toContain("runtime settled");
    h.settleRuntime();
    await h.open;
  });

  test("the row clears on the history, not on the start", async () => {
    const h = harness();
    h.settleHistory();
    expect(h.calls).toContain("row cleared");
    expect(h.calls).not.toContain("runtime settled");
    h.settleRuntime();
    await h.open;
    // One clear, no flicker when the start finally lands.
    expect(h.calls.filter((c) => c === "row cleared")).toHaveLength(1);
  });

  test("a start that never answers still shows the transcript", async () => {
    const h = harness();
    h.settleHistory();
    expect(h.calls).toContain("row cleared");
    h.settleRuntime();
    await h.open;
  });

  test("one open clears the row once whichever order they land in", async () => {
    const h = harness();
    h.settleRuntime();
    h.settleHistory();
    await h.open;
    expect(h.calls.filter((c) => c === "row cleared")).toHaveLength(1);
  });

  test("a conversation created in this session still loads, and its row never waits", async () => {
    // The load is what folds live frames into the transcript; skipping it for a
    // fresh conversation would drop a turn that started mid-open. Whether the
    // row shows is the hook's call (`historyShowsLoadingRow`), not this one.
    const h = harness();
    h.settleHistory();
    expect(h.calls).toContain("row cleared");
    h.settleRuntime();
    await h.open;
  });
});

describe("the loading row", () => {
  test("shows while an existing conversation's history is in flight", () => {
    expect(historyShowsLoadingRow(false)).toBe(true);
  });

  test("stays off for a conversation created in this session", () => {
    expect(historyShowsLoadingRow(true)).toBe(false);
  });
});
