import { describe, expect, test } from "bun:test";
import { RAIL_ROW_PITCH, agentBlockHeight, agentBlockMax } from "./rail-size.ts";

describe("agentBlockMax", () => {
  test("leaves the band, the panes and the conversations' room standing", () => {
    // 1280 tall: 1280 − 52 (band) − 320 (panes) − 260 (conversations) = 648.
    expect(agentBlockMax(1280)).toBe(648);
  });

  test("never shrinks below one row", () => {
    // 600 tall would leave −32 otherwise: the floor is the one row it can always show.
    expect(agentBlockMax(600)).toBe(RAIL_ROW_PITCH);
    expect(agentBlockMax(400)).toBe(RAIL_ROW_PITCH);
  });
});

describe("agentBlockHeight", () => {
  test("a block that fits is the pitch math: 56 per row plus the 4px foot", () => {
    expect(agentBlockHeight(1, 2000)).toBe(60);
    expect(agentBlockHeight(5, 2000)).toBe(284);
    expect(agentBlockHeight(3, 1280)).toBe(172);
  });

  test("an overflowing block is the window's cap, not the row count", () => {
    expect(agentBlockHeight(20, 1280)).toBe(648);
    // The cap itself is never below one row on a tiny window.
    expect(agentBlockHeight(10, 600)).toBe(RAIL_ROW_PITCH);
  });

  test("never grows past the cap, never below one row", () => {
    for (const vh of [400, 500, 700, 900, 1440, 2160]) {
      for (const rows of [0, 1, 2, 4, 8, 40]) {
        const h = agentBlockHeight(rows, vh);
        expect(h).toBeLessThanOrEqual(agentBlockMax(vh));
        expect(h).toBeGreaterThanOrEqual(RAIL_ROW_PITCH);
      }
    }
  });
});
