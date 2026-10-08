import { describe, expect, test } from "bun:test";
import {
  clampComposerHeight,
  MIN_MANUAL_HEIGHT,
  readComposerHeight,
  writeComposerHeight,
} from "./composer-height.ts";

/** A Storage stand-in; `bun:test` has no DOM localStorage to lean on. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    read: (key: string) => data.get(key) ?? null,
  };
}

describe("clampComposerHeight", () => {
  test("never below one usable line", () => {
    expect(clampComposerHeight(1, 800)).toBe(MIN_MANUAL_HEIGHT);
  });

  test("never above half the viewport", () => {
    expect(clampComposerHeight(5000, 800)).toBe(400);
  });

  test("rounds fractional pixels", () => {
    expect(clampComposerHeight(120.4, 800)).toBe(120);
    expect(clampComposerHeight(120.6, 800)).toBe(121);
  });

  test("a tiny viewport still allows the minimum", () => {
    expect(clampComposerHeight(200, 60)).toBe(MIN_MANUAL_HEIGHT);
  });
});

describe("composer height memory", () => {
  test("absent memory means auto-fit", () => {
    expect(readComposerHeight(fakeStorage())).toBeNull();
  });

  test("a written height reads back", () => {
    const storage = fakeStorage();
    writeComposerHeight(240, storage);
    expect(readComposerHeight(storage)).toBe(240);
  });

  test("writing null returns to auto-fit", () => {
    const storage = fakeStorage();
    writeComposerHeight(240, storage);
    writeComposerHeight(null, storage);
    expect(readComposerHeight(storage)).toBeNull();
  });

  test("junk and too-small values read back as auto-fit", () => {
    expect(readComposerHeight(fakeStorage({ "lettuce:composer-height": "tall" }))).toBeNull();
    expect(readComposerHeight(fakeStorage({ "lettuce:composer-height": "10" }))).toBeNull();
  });
});
