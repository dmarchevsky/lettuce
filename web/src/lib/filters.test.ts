import { describe, expect, test } from "bun:test";
import { readFilters, writeFilters } from "./filters.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const KEY = "lettuce:filters";

describe("the remembered filter", () => {
  test("nothing stored is everything shown", () => {
    const storage = memoryStorage();
    const { groups, hidden } = readFilters(storage);
    expect(groups.size).toBe(0);
    expect(hidden.size).toBe(0);
  });

  test("both halves round-trip", () => {
    const storage = memoryStorage();
    writeFilters({ groups: new Set(["agent", "user"]), hidden: new Set(["thinking"]) }, storage);
    const read = readFilters(storage);
    expect([...read.groups]).toEqual(["user", "agent"]);
    expect([...read.hidden]).toEqual(["thinking"]);
  });

  test("every group shown is stored as the empty default", () => {
    const storage = memoryStorage();
    writeFilters(
      { groups: new Set(["user", "agent", "tools", "tasks", "system"]), hidden: new Set() },
      storage,
    );
    expect(storage.getItem(KEY)).toBe('{"show":[],"hide":[]}');
    expect(readFilters(storage).groups.size).toBe(0);
  });

  test("an unknown name is dropped, not honoured", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, '{"show":["agent","thinking-machines"],"hide":["thinking","bogus"]}');
    const read = readFilters(storage);
    expect([...read.groups]).toEqual(["agent"]);
    expect([...read.hidden]).toEqual(["thinking"]);
  });

  test("junk in the key means everything, and a write still works", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, "not json");
    expect(readFilters(storage).groups.size).toBe(0);
    storage.setItem(KEY, "[]");
    expect(readFilters(storage).hidden.size).toBe(0);
    writeFilters({ groups: new Set(["tools"]), hidden: new Set() }, storage);
    expect([...readFilters(storage).groups]).toEqual(["tools"]);
  });

  test("no storage, or storage that throws, is tolerated", () => {
    expect(readFilters(null).groups.size).toBe(0);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readFilters(throwing).hidden.size).toBe(0);
    expect(() =>
      writeFilters({ groups: new Set(["agent"]), hidden: new Set() }, throwing),
    ).not.toThrow();
  });
});
