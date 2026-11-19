import { describe, expect, test } from "bun:test";
import { monitorChip, readStartedAtMs, readWatchTarget } from "./pr-watch.ts";

describe("monitor row vocabulary", () => {
  test("the source is what says WatchPR", () => {
    expect(monitorChip("github_pull_request")).toBe("WatchPR");
    expect(monitorChip("command")).toBe("Monitor");
    expect(monitorChip("websocket")).toBe("Monitor");
    expect(monitorChip("script")).toBe("Monitor");
    // A frame with no source is still a row; it just cannot claim to be a watch.
    expect(monitorChip(undefined)).toBe("Monitor");
  });

  test("a start time that is not a date is no start time", () => {
    // Upstream's own sentinel for "no startTime" is 0 (background-process-snapshot.ts),
    // and anything outside ECMAScript's Date range would make the row throw when it
    // formatted it — so both have to be dropped here, not handled at render.
    expect(readStartedAtMs(0)).toBeUndefined();
    expect(readStartedAtMs(-1)).toBeUndefined();
    expect(readStartedAtMs(1e300)).toBeUndefined();
    expect(readStartedAtMs(Number.NaN)).toBeUndefined();
    expect(readStartedAtMs("1700000000000")).toBeUndefined();
    expect(readStartedAtMs(undefined)).toBeUndefined();
    expect(readStartedAtMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

/**
 * The link a WatchPR row offers is rebuilt from the description upstream writes,
 * because the wire carries no URL — so these strings are upstream's, copied from
 * `letta-code src/tools/impl/watch-pr.ts` (the `description` before
 * `withMonitorState`). If upstream ever rewords it, the link drops out: that is
 * the intended failure, a row with no link beats a link to the wrong PR.
 */
describe("watch target parsing", () => {
  test("a pull-request watch links to the PR", () => {
    expect(readWatchTarget("PR dmarchevsky/lettuce#142 checks, reviews, and mergeability")).toEqual(
      {
        url: "https://github.com/dmarchevsky/lettuce/pull/142",
        label: "dmarchevsky/lettuce#142",
        title: "Open PR",
      },
    );
  });

  test("an Actions run watch links to the run", () => {
    expect(readWatchTarget("Workflow run dmarchevsky/lettuce#1207")).toEqual({
      url: "https://github.com/dmarchevsky/lettuce/actions/runs/1207",
      label: "Workflow run dmarchevsky/lettuce#1207",
      title: "Open run",
    });
  });

  test("owner and repo names with the punctuation GitHub allows still parse", () => {
    expect(readWatchTarget("PR some-owner.v2/some_repo-1.0#7 x")?.url).toBe(
      "https://github.com/some-owner.v2/some_repo-1.0/pull/7",
    );
  });

  test("anything that is not upstream's own shape gets no link", () => {
    // A `tail -f` monitor, a partial match, a description missing the number.
    expect(readWatchTarget("tail -f /var/log/app.log")).toBeNull();
    expect(readWatchTarget("PR owner/repo checks")).toBeNull();
    expect(readWatchTarget("PRTFK owner/repo#3")).toBeNull();
    expect(readWatchTarget("owner/repo#3")).toBeNull();
    expect(readWatchTarget("")).toBeNull();
    expect(readWatchTarget(undefined)).toBeNull();
  });
});
