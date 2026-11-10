import { describe, expect, test } from "bun:test";
import { historyShowsLoadingRow, openConversation } from "./conversation-open.ts";

/**
 * The three things the hook hands `openConversation`, recorded so a test can
 * see what was asked for and when the loading row went away. The history tail
 * always runs when the load lands — the hook's own load catches its failures —
 * so a failed load still takes the row off.
 */
function harness(options: { freshConversation?: boolean } = {}) {
  const calls: string[] = [];
  let history = () => {
    calls.push("!! history never asked for");
  };
  let runtime = () => {
    calls.push("!! runtime never asked for");
  };
  const open = openConversation(
    {
      // The hook calls this first, before it starts the runtime; the helper
      // keeps that order so the record below matches what really happens.
      loadHistory: (onSettled) => {
        calls.push("history asked for");
        if (options.freshConversation) {
          onSettled();
          return;
        }
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
    },
    options,
  );
  return { calls, open, settleHistory: () => history(), settleRuntime: () => runtime() };
}

describe("opening a conversation", () => {
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
});

describe("a conversation created in this session", () => {
  test("has no history to wait for, so its row clears with the start", async () => {
    const h = harness({ freshConversation: true });
    expect(h.calls).not.toContain("row cleared");
    h.settleRuntime();
    await h.open;
    expect(h.calls).toContain("row cleared");
    expect(h.calls.indexOf("row cleared")).toBeGreaterThan(h.calls.indexOf("runtime settled"));
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
