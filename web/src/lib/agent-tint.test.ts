import { describe, expect, test } from "bun:test";
import { AVATAR_TINTS, initialOf, resolveAvatar, tintFor } from "./agent-tint.ts";

describe("AVATAR_TINTS", () => {
  test("every tint the picker offers is storable — the same rule the BFF applies", () => {
    // A swatch showing `var(--accent)` displayed fine and answered 400 on Save,
    // which is the only reason this is a test and not an obvious fact.
    for (const tint of AVATAR_TINTS) {
      expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("there are enough of them to tell a handful of agents apart", () => {
    // Six tints across a dozen agents is the reason this grew: two agents landing
    // on the same colour read as the same agent. Two rows of eight on a phone.
    expect(AVATAR_TINTS).toHaveLength(16);
    expect(new Set(AVATAR_TINTS).size).toBe(AVATAR_TINTS.length);
  });
});

describe("resolveAvatar", () => {
  test("with no preference it is exactly what the avatar always was", () => {
    expect(resolveAvatar("agent-a", "memo")).toEqual({
      background: tintFor("agent-a"),
      content: "M",
    });
    expect(resolveAvatar("agent-a", "memo", {})).toEqual(resolveAvatar("agent-a", "memo"));
  });

  test("a chosen tint wins over the hash, a chosen glyph over the initial", () => {
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7" }).background).toBe("#7aa2f7");
    expect(resolveAvatar("agent-a", "memo", { glyph: "🦊" }).content).toBe("🦊");
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7", glyph: "🦊" })).toEqual({
      background: "#7aa2f7",
      content: "🦊",
    });
  });

  test("the two fall through independently — a tint alone keeps the letter", () => {
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7" }).content).toBe("M");
    expect(resolveAvatar("agent-a", "memo", { glyph: "🦊" }).background).toBe(tintFor("agent-a"));
  });

  test("an empty glyph is no glyph, not a blank face", () => {
    expect(resolveAvatar("agent-a", "memo", { glyph: "" }).content).toBe("M");
  });

  test("an unknown name still gets a face", () => {
    expect(initialOf("  ")).toBe("?");
    expect(resolveAvatar("", "").content).toBe("?");
  });

  test("the same id always hashes to the same tint", () => {
    expect(tintFor("agent-x")).toBe(tintFor("agent-x"));
  });

  test("an uploaded face wins, and keeps the tint as its backdrop", () => {
    const face = resolveAvatar("agent-a", "memo", { tint: "#7aa2f7", image: "0123456789abcdef" });
    expect(face.image).toBe("/api/avatars/0123456789abcdef");
    expect(face.background).toBe("#7aa2f7");
    // The letter is still resolved under a picture: it is what AgentAvatar draws
    // if the picture cannot be fetched, instead of an empty circle.
    expect(face.content).toBe("M");
  });

  test("a face beats a glyph, and the glyph stays behind it as the fallback", () => {
    const face = resolveAvatar("agent-a", "memo", { glyph: "🦊", image: "0123456789abcdef" });
    expect(face.image).toBeDefined();
    expect(face.content).toBe("🦊");
  });

  test("without a face there is no image url to fetch", () => {
    expect(resolveAvatar("agent-a", "memo", { glyph: "🦊" }).image).toBeUndefined();
    expect(resolveAvatar("agent-a", "memo", { image: "" }).image).toBeUndefined();
  });
});
