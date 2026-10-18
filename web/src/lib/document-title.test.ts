import { describe, expect, test } from "bun:test";
import { documentTitle } from "./document-title.ts";

describe("documentTitle", () => {
  test("an open agent is named ahead of the app", () => {
    expect(documentTitle("Alfred")).toBe("Alfred | Lettuce");
  });

  test("no agent leaves the app name alone", () => {
    expect(documentTitle(null)).toBe("Lettuce");
  });

  test("a blank name is treated as no agent", () => {
    expect(documentTitle("   ")).toBe("Lettuce");
    expect(documentTitle("")).toBe("Lettuce");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(documentTitle("  Alfred \n")).toBe("Alfred | Lettuce");
  });
});
