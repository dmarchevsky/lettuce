/**
 * The shared geometry of the two bottom-anchored agent blocks — the rail's and
 * the conversation panel's — which are one row: the fixed divider between the
 * panes and the agents sits at the same computed height in both columns, so the
 * hairlines land on a single pixel row across the seam.
 *
 * There used to be a localStorage here and a draggable divider. The divider is
 * fixed now, so the height is *computed*, never stored — and a stale stored key
 * an old build left behind is simply never read again.
 */

/** One avatar cell inside the pitch: below this the block is a slot, not a list. */
export const RAIL_CELL_HEIGHT = 52;
/** One row and its breathing room: 52px cell + 4px gap. Both blocks use it. */
export const RAIL_ROW_PITCH = 56;
/** The header band every column hangs under (`--topbar-h`). */
const BAND_H = 52;
/** The pane items (Chat…Agent, Settings) with their gaps: what the block can never crowd out. */
const PANES_TOP = 320;
/** Tool row + search + a group + two rows + the archived link: the conversations' floor. */
const CONVERSATIONS_MIN_ROOM = 260;
/** The `+ 4` bottom breathing room on a block that fits entirely. */
const BLOCK_FOOT = 4;

/** The tallest the agent block can be in a window this tall — never below one row. */
export function agentBlockMax(viewportHeight: number): number {
  return Math.max(
    RAIL_ROW_PITCH,
    viewportHeight - BAND_H - PANES_TOP - CONVERSATIONS_MIN_ROOM,
  );
}

/**
 * The block height for `rows` rows — visible agents plus the "all" and "new"
 * cells, the same count in both columns — capped by what the window can show
 * above the conversations' minimum room. When the cap bites, both blocks
 * scroll, in sync.
 */
export function agentBlockHeight(rows: number, viewportHeight: number): number {
  const needed = RAIL_ROW_PITCH * Math.max(1, rows) + BLOCK_FOOT;
  return Math.min(needed, agentBlockMax(viewportHeight));
}
