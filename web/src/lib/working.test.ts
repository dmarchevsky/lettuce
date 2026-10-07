import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./messages.ts";
import type { QueuedItem } from "./queue-actions.ts";
import {
  deriveWorking,
  drainingQueueCount,
  formatElapsed,
  middleEllipsis,
  STALL_AFTER_MS,
} from "./working.ts";

let seq = 0;
function entry(
  partial: Partial<TranscriptEntry> & { kind: TranscriptEntry["kind"] },
): TranscriptEntry {
  seq += 1;
  return {
    id: partial.id ?? `e${seq}`,
    date: "2026-01-01T00:00:00Z",
    seenAt: seq,
    text: "",
    ...partial,
    kind: partial.kind,
  };
}

function queued(paused: boolean): QueuedItem {
  return {
    id: `q${paused}`,
    content: "next thing",
    raw: "next thing",
    clientMessageId: `c${paused}`,
    source: "user",
    paused,
  };
}

const base = {
  processing: true,
  stopping: false,
  cwd: "/work/agent",
  now: 100_000,
  turnStartedAt: 40_000,
  lastActivityAt: 99_000,
};

describe("formatElapsed", () => {
  test("seconds and minutes", () => {
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(250_000)).toBe("4:10");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("middleEllipsis", () => {
  test("keeps the tail", () => {
    expect(middleEllipsis("short/path.ts", 40)).toBe("short/path.ts");
    expect(middleEllipsis("a".repeat(50), 11)).toBe(`${"a".repeat(5)}…${"a".repeat(5)}`);
  });
});

describe("deriveWorking", () => {
  test("idle means no line", () => {
    expect(deriveWorking({ ...base, processing: false, entries: [], queue: [] })).toBeNull();
  });

  test("stopping outranks everything", () => {
    const snap = deriveWorking({
      ...base,
      stopping: true,
      entries: [entry({ kind: "tool_call", toolName: "Bash" })],
      queue: [],
    });
    expect(snap?.state).toBe("stopping");
    expect(snap?.verb).toBe("Stopping…");
  });

  test("bare processing reads as thinking", () => {
    const snap = deriveWorking({ ...base, entries: [], queue: [] });
    expect(snap?.state).toBe("thinking");
    expect(snap?.verb).toBe("Thinking");
  });

  test("a streaming assistant entry reads as writing", () => {
    const snap = deriveWorking({
      ...base,
      entries: [entry({ kind: "assistant", streaming: true, text: "the answer" })],
      queue: [],
    });
    expect(snap?.state).toBe("writing");
  });

  test("an unanswered tool call is the activity", () => {
    const snap = deriveWorking({
      ...base,
      entries: [
        entry({
          kind: "tool_call",
          toolName: "Read",
          toolCallId: "c1",
          toolArgs: JSON.stringify({ file_path: "/work/agent/docker/compose.yml" }),
        }),
      ],
      queue: [],
    });
    expect(snap?.state).toBe("tool");
    expect(snap?.verb).toBe("Read");
    expect(snap?.object).toBe("docker/compose.yml");
    expect(snap?.icon).toBe("file");
  });

  test("a returned tool call no longer shows; the newest open one wins", () => {
    const snap = deriveWorking({
      ...base,
      entries: [
        entry({
          kind: "tool_call",
          toolName: "Read",
          toolCallId: "c1",
          toolArgs: JSON.stringify({ file_path: "/work/agent/a.ts" }),
        }),
        entry({ kind: "tool_return", toolCallId: "c1" }),
        entry({
          kind: "tool_call",
          toolName: "Bash",
          toolCallId: "c2",
          toolArgs: JSON.stringify({ command: "docker compose build" }),
        }),
      ],
      queue: [],
    });
    expect(snap?.state).toBe("tool");
    expect(snap?.verb).toBe("Run");
    expect(snap?.object).toBe("docker compose build");
  });

  test("subagent tool calls are not this turn's activity", () => {
    const snap = deriveWorking({
      ...base,
      entries: [entry({ kind: "tool_call", toolName: "Bash", subagentId: "s1" })],
      queue: [],
    });
    expect(snap?.state).toBe("thinking");
  });

  test("a codex Task names the worker", () => {
    const snap = deriveWorking({
      ...base,
      entries: [
        entry({
          kind: "tool_call",
          toolName: "Task",
          toolCallId: "c1",
          toolArgs: JSON.stringify({ subagent_type: "codex", description: "fix flaky test" }),
        }),
      ],
      queue: [],
    });
    expect(snap?.verb).toBe("Codex:");
    expect(snap?.object).toBe("fix flaky test");
  });

  test("silence with nothing running is a stall; a running tool never stalls", () => {
    const silent = {
      ...base,
      lastActivityAt: 100_000 - STALL_AFTER_MS - 1,
      entries: [],
      queue: [],
    };
    expect(deriveWorking(silent)?.state).toBe("stall");

    const tool = entry({
      kind: "tool_call",
      toolName: "Bash",
      toolCallId: "c1",
      toolArgs: JSON.stringify({ command: "docker compose build app-server" }),
    });
    expect(deriveWorking({ ...silent, entries: [tool] })?.state).toBe("tool");

    const stalled = deriveWorking({
      ...silent,
      entries: [
        entry({ kind: "tool_call", toolName: "web_search", toolCallId: "c9" }),
        entry({ kind: "tool_return", toolCallId: "c9" }),
      ],
    });
    expect(stalled?.state).toBe("stall");
    expect(stalled?.lastSeen).toBe("web_search");
  });

  test("stopping the stall clock on any recent frame", () => {
    const fresh = deriveWorking({ ...base, entries: [], queue: [], lastActivityAt: 99_999 });
    expect(fresh?.state).toBe("thinking");
  });
});

describe("drainingQueueCount", () => {
  test("paused items do not count", () => {
    expect(drainingQueueCount([queued(false), queued(true), queued(false)])).toBe(2);
  });
});
