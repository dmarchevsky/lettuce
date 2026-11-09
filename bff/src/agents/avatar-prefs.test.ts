import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentAvatarStore,
  isDefaultAvatarPref,
  normalizeGlyph,
  parseAvatarPref,
} from "./avatar-prefs.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "avatars-")), "avatar-prefs.json");

describe("parseAvatarPref", () => {
  test("accepts a six-digit tint, lower-cased", () => {
    expect(parseAvatarPref({ tint: "#7AA2F7" })).toEqual({ tint: "#7aa2f7" });
  });

  test("refuses a tint that is not a #rrggbb literal", () => {
    for (const tint of ["red", "#abc", "#7aa2f7zz", "7aa2f7", "#7aa2f77", 3, true]) {
      expect(parseAvatarPref({ tint })).toBeNull();
    }
  });

  test("an absent tint or glyph is not a preference, not an error", () => {
    expect(parseAvatarPref({})).toEqual({});
    expect(parseAvatarPref({ tint: null, glyph: null })).toEqual({});
    expect(isDefaultAvatarPref({})).toBe(true);
  });

  test("refuses a shape that is not an object", () => {
    for (const value of [null, undefined, "x", 3, []]) {
      expect(parseAvatarPref(value)).toBeNull();
    }
  });

  test("clearing is a write, not a typo", () => {
    expect(parseAvatarPref({ glyph: "" })).toEqual({});
    expect(parseAvatarPref({ tint: "#7aa2f7", glyph: "  " })).toEqual({ tint: "#7aa2f7" });
  });

  test("one bad field rejects the whole body rather than storing half of it", () => {
    expect(parseAvatarPref({ tint: "#7aa2f7", glyph: "too many graphemes" })).toBeNull();
  });

  test("an image is a face id and nothing else", () => {
    const id = "0123456789abcdef";
    expect(parseAvatarPref({ image: id })).toEqual({ image: id });
    expect(parseAvatarPref({ tint: "#7aa2f7", glyph: "🦊", image: id })).toEqual({
      tint: "#7aa2f7",
      glyph: "🦊",
      image: id,
    });
  });

  test("an image that is not a 16-character lowercase hex id is refused", () => {
    for (const image of [
      "0123456789abcdeg",
      "0123456789ABCDEF",
      "0123456789abcde",
      "0123456789abcdef0",
      "../../etc/passwd",
      "face.png",
      3,
      true,
    ]) {
      expect(parseAvatarPref({ image })).toBeNull();
    }
  });

  test("an empty or null image clears the face", () => {
    expect(parseAvatarPref({ tint: "#7aa2f7", image: "" })).toEqual({ tint: "#7aa2f7" });
    expect(parseAvatarPref({ image: null })).toEqual({});
    expect(isDefaultAvatarPref({ image: "0123456789abcdef" })).toBe(false);
  });
});

describe("normalizeGlyph", () => {
  test("one emoji is one glyph", () => {
    expect(normalizeGlyph("🦊")).toBe("🦊");
  });

  test("a variation selector is not a second grapheme", () => {
    expect(normalizeGlyph("🛠️")).toBe("🛠");
  });

  test("a skin-tone modifier is folded into its base emoji", () => {
    expect(normalizeGlyph("👍🏽")).toBe("👍");
  });

  test("a ZWJ sequence counts as the one glyph it renders as", () => {
    expect(normalizeGlyph("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  test("two graphemes are the cap, and a monogram is allowed", () => {
    expect(normalizeGlyph("👀")).toBe("👀");
    expect(normalizeGlyph("ab")).toBe("ab");
    expect(normalizeGlyph("abc")).toBeNull();
  });

  test("invisible characters and control characters are refused", () => {
    expect(normalizeGlyph("a\u200Bb")).toBeNull();
    expect(normalizeGlyph("a‮")).toBeNull();
    expect(normalizeGlyph("a\nb")).toBeNull();
  });

  test("nothing left after stripping modifiers is nothing", () => {
    expect(normalizeGlyph("\u200F")).toBeNull();
    expect(normalizeGlyph("   ")).toBeNull();
  });
});

describe("AgentAvatarStore", () => {
  test("stores only what was chosen, and survives a restart", async () => {
    const file = fileIn();
    const store = new AgentAvatarStore(file, () => {});
    store.set("agent-a", { tint: "#7aa2f7", glyph: "🤖" });
    store.set("agent-b", {});
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "agent-a": { tint: "#7aa2f7", glyph: "🤖" },
    });
    expect(new AgentAvatarStore(file, () => {}).get("agent-a")).toEqual({
      tint: "#7aa2f7",
      glyph: "🤖",
    });
    expect(new AgentAvatarStore(file, () => {}).get("agent-never")).toEqual({});
  });

  test("resetting removes the entry and the write is real", async () => {
    const file = fileIn();
    const store = new AgentAvatarStore(file, () => {});
    expect(store.set("agent-a", { glyph: "🦊" })).toBe(true);
    expect(store.set("agent-a", { glyph: "🦊" })).toBe(false);
    expect(store.set("agent-a", {})).toBe(true);
    expect(store.all()).toEqual({});
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("an image-only pref is stored, and clearing it removes the entry", async () => {
    const file = fileIn();
    const store = new AgentAvatarStore(file, () => {});
    const id = "0123456789abcdef";
    expect(store.set("agent-a", { tint: "#7aa2f7", image: id })).toBe(true);
    // Only the face changed: the store has to see that, or the write is dropped.
    expect(store.set("agent-a", { tint: "#7aa2f7", image: "fedcba9876543210" })).toBe(true);
    expect(store.set("agent-a", { tint: "#7aa2f7", image: "fedcba9876543210" })).toBe(false);
    expect(store.set("agent-a", { tint: "#7aa2f7" })).toBe(true);
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "agent-a": { tint: "#7aa2f7" } });
  });

  test("a corrupt file loads as nothing customized", () => {
    const file = fileIn();
    writeFileSync(file, "{not json");
    expect(new AgentAvatarStore(file, () => {}).all()).toEqual({});
  });

  test("a stored entry that is no longer valid is dropped, not served", () => {
    const file = fileIn();
    writeFileSync(
      file,
      JSON.stringify({ "agent-a": { tint: "crimson" }, "agent-b": { glyph: "ok" }, "../x": {} }),
    );
    expect(new AgentAvatarStore(file, () => {}).all()).toEqual({ "agent-b": { glyph: "ok" } });
  });

  test("refuses what is not an agent id", () => {
    const store = new AgentAvatarStore(fileIn(), () => {});
    expect(() => store.set("../etc", { glyph: "x" })).toThrow();
    expect(() => store.set("", { glyph: "x" })).toThrow();
  });
});
