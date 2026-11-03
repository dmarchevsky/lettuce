import { describe, expect, test } from "bun:test";
import {
  agentLabel,
  onlyRunsLabel,
  otherRunsLabel,
  scopedEmptyLabel,
  sumOther,
} from "./runs-scope.ts";

describe("the pane's one link", () => {
  test("named for the agent it would narrow back to", () => {
    expect(onlyRunsLabel("Nova")).toBe("Nova only");
    // No name yet (still loading, or the agent is gone): the link still reads.
    expect(onlyRunsLabel(null)).toBe("this agent only");
    expect(agentLabel(null)).toBe("this agent");
  });

  test("the count says nothing when the filter hid nothing", () => {
    expect(otherRunsLabel(0)).toBeNull();
    expect(otherRunsLabel(-1)).toBeNull();
    expect(otherRunsLabel(1)).toBe("1 other run");
    expect(otherRunsLabel(12)).toBe("12 other runs");
  });

  test("the three lists' counts add up to what the pane claims to hide", () => {
    expect(sumOther({ codex: 3, claude: 0, pi: 2 })).toBe(5);
    // A list that never reported (its worker token is off) hides nothing.
    expect(sumOther({ codex: 1 })).toBe(1);
    expect(sumOther({})).toBe(0);
  });
});

describe("a section with none of ours", () => {
  test("says whose absence it is reporting", () => {
    expect(scopedEmptyLabel("Codex runs", "Nova", 0)).toBe("No Codex runs for Nova.");
    expect(scopedEmptyLabel("Claude runs", null, 0)).toBe("No Claude runs for this agent.");
  });

  test("and says so when the machine has some to show", () => {
    expect(scopedEmptyLabel("Remote Pi runs", "Nova", 3)).toBe(
      "No Remote Pi runs for Nova — 3 other runs on this machine.",
    );
    expect(scopedEmptyLabel("Codex runs", "Nova", 1)).toBe(
      "No Codex runs for Nova — 1 other run on this machine.",
    );
  });
});
