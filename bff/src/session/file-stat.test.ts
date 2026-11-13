import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withModifiedTimes } from "./file-stat.ts";

/**
 * `get_tree` reports paths relative to its root — these assert the join
 * mirrors `FilesTab.tsx`'s own `resolve()`, and that a stat failure degrades
 * to "no modified/size field" rather than breaking the whole response, since
 * `get_tree` and this stat call race against the same filesystem.
 */
describe("withModifiedTimes", () => {
  const root = mkdtempSync(join(tmpdir(), "file-stat-test-"));
  const knownMtime = new Date("2024-01-01T00:00:00Z");
  const content = "hello";
  writeFileSync(join(root, "notes.md"), content);
  utimesSync(join(root, "notes.md"), knownMtime, knownMtime);
  mkdirSync(join(root, "sub"));
  utimesSync(join(root, "sub"), knownMtime, knownMtime);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("attaches a real mtime for an entry that exists", async () => {
    const [entry] = await withModifiedTimes(root, [{ path: "notes.md", type: "file" }]);
    expect(entry?.modified).toBe(knownMtime.getTime());
  });

  test("attaches a real size for a file", async () => {
    const [entry] = await withModifiedTimes(root, [{ path: "notes.md", type: "file" }]);
    expect(entry?.size).toBe(content.length);
  });

  test("attaches a modified time but no size for a directory", async () => {
    const [entry] = await withModifiedTimes(root, [{ path: "sub", type: "dir" }]);
    expect(entry?.modified).toBe(knownMtime.getTime());
    expect(entry?.size).toBeUndefined();
  });

  test("resolves a root ending in a slash the same as one that doesn't", async () => {
    const [entry] = await withModifiedTimes(`${root}/`, [{ path: "notes.md", type: "file" }]);
    expect(entry?.modified).toBe(knownMtime.getTime());
  });

  test("omits modified/size for a path that does not exist, without throwing", async () => {
    const [entry] = await withModifiedTimes(root, [{ path: "missing.md", type: "file" }]);
    expect(entry?.modified).toBeUndefined();
    expect(entry?.size).toBeUndefined();
    expect(entry?.path).toBe("missing.md");
  });

  test("leaves every other field untouched", async () => {
    const input = [{ path: "notes.md", type: "file" as const, extra: "kept" }];
    const [entry] = await withModifiedTimes(root, input);
    expect(entry).toMatchObject({ path: "notes.md", type: "file", extra: "kept" });
  });

  test("a large tree keeps its order, whatever order the reads finish in", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      path: index % 2 === 0 ? "notes.md" : `missing-${index}`,
      type: "file" as const,
      index,
    }));
    const result = await withModifiedTimes(root, entries);
    expect(result.map((entry) => entry.index)).toEqual(entries.map((entry) => entry.index));
    expect(result[0]?.size).toBe(content.length);
    expect(result[1]?.size).toBeUndefined();
  });
});
