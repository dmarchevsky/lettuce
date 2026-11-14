import { describe, expect, test } from "bun:test";
import { settledPrefixLength } from "./markdown-stream.ts";

const cutOf = (text: string) => {
  const cut = settledPrefixLength(text);
  return [text.slice(0, cut), text.slice(cut)];
};

describe("settledPrefixLength", () => {
  test("nothing is settled until a block has ended", () => {
    expect(settledPrefixLength("")).toBe(0);
    expect(settledPrefixLength("one line still arriving")).toBe(0);
    expect(settledPrefixLength("a paragraph\nacross two lines")).toBe(0);
    expect(settledPrefixLength("a paragraph\n\n")).toBe(0);
  });

  test("finished paragraphs are settled; the one still arriving is not", () => {
    expect(cutOf("first\n\nsecond\n\nthi")).toEqual(["first\n\nsecond\n\n", "thi"]);
    expect(cutOf("# Title\n\nbody text")).toEqual(["# Title\n\n", "body text"]);
  });

  test("the two halves always add back up to the text", () => {
    const text =
      "intro\n\n- a\n- b\n\nafter the list\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nend";
    for (let end = 0; end <= text.length; end++) {
      const part = text.slice(0, end);
      const cut = settledPrefixLength(part);
      expect(cut).toBeGreaterThanOrEqual(0);
      expect(cut).toBeLessThanOrEqual(part.length);
      // A cut never lands mid-line.
      if (cut > 0) expect(part[cut - 1]).toBe("\n");
    }
  });

  test("a blank line inside a code fence is not a boundary", () => {
    const text = "intro\n\n```py\nprint(1)\n\nprint(2)";
    expect(cutOf(text)).toEqual(["intro\n\n", "```py\nprint(1)\n\nprint(2)"]);
    // Closed, and followed by prose: now the fence is settled too.
    const closed = `${text}\n\`\`\`\n\nafter`;
    expect(cutOf(closed)[1]).toBe("after");
  });

  test("a longer or different fence inside a fence does not close it", () => {
    const text = "````md\n```\ninner\n\n```\n\nstill inside";
    expect(settledPrefixLength(text)).toBe(0);
    expect(settledPrefixLength("~~~\na\n\n```\n\nb")).toBe(0);
  });

  test("a loose list is never split between its items", () => {
    expect(settledPrefixLength("1. one\n\n2. two\n\n3. thr")).toBe(0);
    expect(settledPrefixLength("- one\n\n- two")).toBe(0);
    // Nor between an item and its indented continuation.
    expect(settledPrefixLength("- one\n\n  more of one")).toBe(0);
    // Around the list is fine — before it and after it — never inside it.
    expect(cutOf("intro\n\n- one\n\n- tw")).toEqual(["intro\n\n", "- one\n\n- tw"]);
    expect(cutOf("intro\n\n- one\n\n- two\n\nafter")).toEqual([
      "intro\n\n- one\n\n- two\n\n",
      "after",
    ]);
  });

  test("quotes and tables stay whole", () => {
    expect(settledPrefixLength("> a\n\n> b")).toBe(0);
    expect(settledPrefixLength("| a | b |\n|---|---|\n\n| c | d |")).toBe(0);
  });
});
