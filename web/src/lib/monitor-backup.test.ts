import { describe, expect, test } from "bun:test";
import { findMonitorBackupWake, monitorBackupWakeName } from "./monitor-backup.ts";

interface Task {
  name: string;
  recurring: boolean;
  status: string;
  scheduled_for: string | null;
}

const wake = (over: Partial<Task> = {}): Task => ({
  name: monitorBackupWakeName("Gmail inbox"),
  recurring: false,
  status: "active",
  scheduled_for: "2026-10-19T16:32:00Z",
  ...over,
});

describe("monitorBackupWakeName", () => {
  test("mirrors upstream wakeName", () => {
    expect(monitorBackupWakeName("Gmail inbox")).toBe("Monitor backup: Gmail inbox");
    const long = "x".repeat(100);
    const name = monitorBackupWakeName(long);
    expect(name.length).toBe(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("findMonitorBackupWake", () => {
  test("matches the armed one-shot wake", () => {
    const armed = wake();
    const tasks = [wake({ name: "Morning brief", recurring: true }), armed];
    expect(findMonitorBackupWake("Gmail inbox", tasks)).toBe(armed);
  });

  test("matches the truncated name for a long description", () => {
    const long = "x".repeat(100);
    const armed = wake({ name: monitorBackupWakeName(long) });
    expect(findMonitorBackupWake(long, [armed])).toBe(armed);
  });

  test("ignores recurring, non-active and unscheduled tasks", () => {
    expect(findMonitorBackupWake("Gmail inbox", [wake({ recurring: true })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ status: "paused" })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ status: "completed" })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ scheduled_for: null })])).toBeNull();
  });

  test("ignores a different monitor's wake", () => {
    expect(findMonitorBackupWake("Other watch", [wake()])).toBeNull();
  });

  /**
   * A `WatchPR` row shows no "Backup wake armed" line because upstream arms one
   * only from the `Monitor` tool (letta-code `tools/impl/monitor.ts` → `armMonitorBackup`;
   * `tools/impl/watch-pr.ts` never calls it). The join is by name alone, so what the
   * row can prove is only this: a watch's description never picks up a wake armed for
   * some other monitor.
   */
  test("a GitHub watch matches no monitor's wake", () => {
    const pr = "PR dmarchevsky/lettuce#142 checks, reviews, and mergeability";
    expect(findMonitorBackupWake(pr, [wake()])).toBeNull();
    expect(findMonitorBackupWake(pr, [wake(), wake({ name: "Nightly build" })])).toBeNull();
  });
});
