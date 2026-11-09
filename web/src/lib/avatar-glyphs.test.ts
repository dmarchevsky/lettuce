import { describe, expect, test } from "bun:test";
import { ALL_GLYPHS, GLYPH_CATEGORIES, glyphSections, searchGlyphs } from "./avatar-glyphs.ts";

/**
 * The catalog is content with a contract: 144 tiles in six browsable groups, every
 * one of them findable by a word a person would actually type, on every device the
 * app is opened on. Those are the three things that quietly rot as glyphs get
 * added, so they are all asserted here.
 */
describe("GLYPH_CATEGORIES", () => {
  test("six categories of twenty-four, 144 tiles in all", () => {
    expect(GLYPH_CATEGORIES).toHaveLength(6);
    for (const category of GLYPH_CATEGORIES) {
      expect(category.glyphs).toHaveLength(24);
    }
    expect(ALL_GLYPHS).toHaveLength(144);
  });

  test("nothing is listed twice — a duplicate is a tile that looks broken", () => {
    const seen = new Set(ALL_GLYPHS.map((entry) => entry.glyph));
    expect(seen.size).toBe(ALL_GLYPHS.length);
  });

  test("category ids and labels are usable as chips", () => {
    for (const category of GLYPH_CATEGORIES) {
      expect(category.id).toMatch(/^[a-z]+$/);
      expect(category.label.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(GLYPH_CATEGORIES.map((c) => c.id)).size).toBe(GLYPH_CATEGORIES.length);
  });

  test("every glyph has keywords — a glyph with none cannot be searched for", () => {
    for (const entry of ALL_GLYPHS) {
      expect(entry.keywords.length).toBeGreaterThan(0);
      for (const keyword of entry.keywords) {
        expect(keyword).toBe(keyword.toLowerCase());
        expect(keyword.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("nothing newer than Emoji 13 (2020), which every device we are opened on draws", () => {
    // 🫐 and its Emoji 14 neighbours (U+1FAD0–1FAD9) need iOS 15.4 and 🫠 its Emoji 15
    // neighbours (U+1FAE0–1FAFF) need iOS 16.4 — recent enough that an older iPhone
    // draws tofu, which in a 22px circle is indistinguishable from a bug. The gap
    // between the two blocks is unassigned, so one range covers both.
    for (const entry of ALL_GLYPHS) {
      for (const char of entry.glyph) {
        const code = char.codePointAt(0) ?? 0;
        expect(code < 0x1fad0 || code > 0x1faff).toBe(true);
      }
    }
  });

  test("no ZWJ sequences, which some fonts draw as two glyphs in one tile", () => {
    for (const entry of ALL_GLYPHS) {
      expect(entry.glyph.includes("\u200d")).toBe(false);
    }
  });

  test("a glyph with an emoji presentation selector keeps it", () => {
    // 26 tiles are of the ☠️ ✉️ ⚙️ shape, and U+FE0F is the whole difference between
    // the emoji and the plain text mark in many fonts. The BFF strips modifiers to
    // count graphemes (bff/src/agents/avatar-prefs.ts guards that it stores what it
    // was sent); this is the other half of the round trip — the tile must show the
    // same character the pref comes back holding, or the picker cannot light up the
    // face the agent is already wearing.
    for (const entry of ALL_GLYPHS) {
      expect([...entry.glyph].filter((char) => char === "\ufe0f").length <= 1).toBe(true);
      expect(entry.glyph.endsWith("\ufe0f") || !entry.glyph.includes("\ufe0f")).toBe(true);
    }
  });

  test("nothing carries an invisible mark that would make a grapheme count lie", () => {
    const INVISIBLE =
      /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2061-\u2064\u2066-\u2069\ufeff]/;
    for (const entry of ALL_GLYPHS) {
      expect(INVISIBLE.test(entry.glyph)).toBe(false);
      expect(entry.glyph.trim()).toBe(entry.glyph);
    }
  });
});

describe("searchGlyphs", () => {
  test("a word finds the face it describes, across categories", () => {
    expect(searchGlyphs("fox").map((entry) => entry.glyph)).toContain("🦊");
    expect(searchGlyphs("mail").map((entry) => entry.glyph)).toContain("✉️");
    expect(searchGlyphs("moon").map((entry) => entry.glyph)).toContain("🌙");
    expect(searchGlyphs("robot").map((entry) => entry.glyph)).toContain("🤖");
    expect(searchGlyphs("cron").map((entry) => entry.glyph)).toContain("⏰");
  });

  test("an empty query is the whole library", () => {
    expect(searchGlyphs("")).toHaveLength(144);
    expect(glyphSections("", null)).toHaveLength(6);
  });

  test("the match is a substring, case-insensitive, on either side of the hyphen", () => {
    expect(searchGlyphs("SUN").map((entry) => entry.glyph)).toContain("☀️");
    // "un" is inside "sun"; the point is that the box is forgiving, not precise.
    expect(searchGlyphs("un").map((entry) => entry.glyph)).toContain("☀️");
  });

  test("pasting a glyph into the box narrows to it", () => {
    expect(searchGlyphs("🦊").map((entry) => entry.glyph)).toEqual(["🦊"]);
  });

  test("a query nothing matches leaves no empty sections behind", () => {
    expect(searchGlyphs("zzzzqqq")).toHaveLength(0);
    expect(glyphSections("zzzzqqq", null)).toHaveLength(0);
  });
});

describe("glyphSections", () => {
  test("a category chip narrows to that group alone", () => {
    const sections = glyphSections("", "animals");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBe("Animals");
    expect(sections[0]?.glyphs).toHaveLength(24);
  });

  test("a chip and a query combine, and a chip with no hits drops out", () => {
    expect(glyphSections("mail", "animals")).toHaveLength(0);
    const talking = glyphSections("mail", "talking");
    expect(talking.flatMap((section) => section.glyphs).map((entry) => entry.glyph)).toContain(
      "📬",
    );
  });
});
