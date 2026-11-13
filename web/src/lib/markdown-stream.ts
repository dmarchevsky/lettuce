/**
 * Where a still-streaming message can be cut in two so the part above the cut
 * never has to be parsed again: the offset just past the last blank line that
 * ends a self-contained block, or 0 when there is no such place yet.
 *
 * A streamed answer used to be re-parsed from its first character on every
 * frame, so a long one got slower with every token. Text above a blank line is
 * finished as far as markdown is concerned — except where the block is still
 * open, and those are the cases this refuses: inside a code fence, and between
 * blocks that only make sense together (list items, quote lines, table rows,
 * indented continuations), which would otherwise render as two lists. The cut is
 * only used while streaming; the settled message is parsed whole, exactly as
 * before, so nothing here can change how a finished message looks.
 */
export function settledPrefixLength(text: string): number {
  const CONTINUES = /^(?:[ \t]|[-*+>|]|\d+[.)])/;
  let cut = 0;
  let fence: string | null = null;
  let offset = 0;
  let previous = "";
  let blankAt = -1;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const opens = marker !== undefined && fence === null;
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    if (opens) {
      // A fence opening after a blank line starts a block like any other.
      if (blankAt >= 0) cut = offset;
      blankAt = -1;
    } else if (fence === null && !marker) {
      if (line.trim() === "") {
        if (previous.trim() !== "") blankAt = offset;
      } else if (blankAt >= 0) {
        // A block starts here. The text above it is settled unless the two
        // sides of the blank line could be one construct: an indented line
        // continues whatever came before, and a list item, quote line or table
        // row after another one is the same list, quote or table.
        const indented = /^[ \t]/.test(line);
        if (!indented && !(CONTINUES.test(line) && CONTINUES.test(previous))) cut = offset;
        blankAt = -1;
      }
    } else {
      blankAt = -1;
    }
    if (line.trim() !== "") previous = line;
    offset = next;
  }
  return Math.min(cut, text.length);
}
