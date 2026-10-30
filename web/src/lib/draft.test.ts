import { describe, expect, test } from "bun:test";
import { appendToDraft, clearDraft, draftKey, readDraft, writeDraft } from "./draft.ts";

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

/** Storage that throws on every access, as a disabled or sandboxed one does. */
const hostileStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("draftKey", () => {
  test("needs both ids", () => {
    expect(draftKey("a", "c")).toBe("a::c");
    expect(draftKey("a", null)).toBeNull();
    expect(draftKey(null, "c")).toBeNull();
    expect(draftKey(null, null)).toBeNull();
  });
});

describe("draft memory", () => {
  test("a written draft reads back for its key only", () => {
    const storage = fakeStorage();
    writeDraft("a::c", "half a thought", storage);
    expect(readDraft("a::c", storage)).toBe("half a thought");
    expect(readDraft("a::other", storage)).toBe("");
  });

  test("nothing stored reads as empty string", () => {
    expect(readDraft("a::c", fakeStorage())).toBe("");
  });

  test("writing empty text discards the entry", () => {
    const storage = fakeStorage();
    writeDraft("a::c", "typing…", storage);
    writeDraft("a::c", "", storage);
    expect(readDraft("a::c", storage)).toBe("");
  });

  test("clearDraft removes one conversation's draft and leaves the rest", () => {
    const storage = fakeStorage();
    writeDraft("a::1", "one", storage);
    writeDraft("a::2", "two", storage);
    clearDraft("a::1", storage);
    expect(readDraft("a::1", storage)).toBe("");
    expect(readDraft("a::2", storage)).toBe("two");
  });

  test("a later write to the same key replaces, not appends", () => {
    const storage = fakeStorage();
    writeDraft("a::c", "first", storage);
    writeDraft("a::c", "second", storage);
    expect(readDraft("a::c", storage)).toBe("second");
    const parsed = JSON.parse(storage.read("lettuce:draft") ?? "null");
    expect(parsed.order).toEqual(["a::c"]);
  });

  test("the map is bounded — the oldest conversation's draft is evicted past the cap", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 25; i++) writeDraft(`a::${i}`, `draft ${i}`, storage);
    // First five (0..4) pushed out; last twenty (5..24) kept.
    expect(readDraft("a::0", storage)).toBe("");
    expect(readDraft("a::4", storage)).toBe("");
    expect(readDraft("a::5", storage)).toBe("draft 5");
    expect(readDraft("a::24", storage)).toBe("draft 24");
    const parsed = JSON.parse(storage.read("lettuce:draft") ?? "null");
    expect(parsed.order.length).toBe(20);
  });

  test("re-writing an existing key refreshes its recency, sparing it from eviction", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 20; i++) writeDraft(`a::${i}`, `draft ${i}`, storage);
    // Touch the oldest so it is no longer first in line.
    writeDraft("a::0", "kept alive", storage);
    // One more distinct conversation forces an eviction.
    writeDraft("a::20", "newcomer", storage);
    expect(readDraft("a::0", storage)).toBe("kept alive");
    expect(readDraft("a::1", storage)).toBe(""); // evicted instead
    expect(readDraft("a::20", storage)).toBe("newcomer");
  });

  test("corrupt or foreign JSON reads as empty rather than throwing", () => {
    expect(readDraft("a::c", fakeStorage({ "lettuce:draft": "not json" }))).toBe("");
    expect(readDraft("a::c", fakeStorage({ "lettuce:draft": "[1,2,3]" }))).toBe("");
    expect(readDraft("a::c", fakeStorage({ "lettuce:draft": '{"drafts":{"a::c":42}}' }))).toBe("");
  });

  test("storage that throws degrades to no memory", () => {
    expect(readDraft("a::c", hostileStorage)).toBe("");
    expect(() => writeDraft("a::c", "text", hostileStorage)).not.toThrow();
    expect(() => clearDraft("a::c", hostileStorage)).not.toThrow();
  });

  test("absent storage is not an error", () => {
    expect(readDraft("a::c", null)).toBe("");
    expect(() => writeDraft("a::c", "text", null)).not.toThrow();
  });
});

describe("appendToDraft", () => {
  test("an empty draft takes the text as it is", () => {
    expect(appendToDraft("", "Change it: ")).toBe("Change it: ");
    expect(appendToDraft("  \n", "Change it: ")).toBe("Change it: ");
  });

  test("a draft is kept, with the text after a blank line", () => {
    expect(appendToDraft("half a thought\n", "Change it: ")).toBe("half a thought\n\nChange it: ");
  });
});
