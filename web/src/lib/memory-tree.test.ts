import { describe, expect, test } from "bun:test";
import {
  buildMemoryTree,
  filterMemoryPaths,
  isRowVisible,
  type MemoryPathEntry,
  memoryTreeCounts,
  memoryTreeDirs,
} from "./memory-tree.ts";

const paths = (...list: string[]): MemoryPathEntry[] =>
  list.map((relative_path) => ({ relative_path }));

/** Rows as `kind:name`, in render order — the shape every case below is about. */
function labels(rows: { kind: string; name: string }[]): string[] {
  return rows.map((row) => `${row.kind === "dir" ? "d" : "f"}:${row.name}`);
}

describe("the memory tree", () => {
  test("nothing listed is nothing to render", () => {
    expect(buildMemoryTree([])).toEqual([]);
    expect(memoryTreeCounts([])).toEqual({ files: 0, folders: 0 });
  });

  test("root files sit at depth zero", () => {
    const rows = buildMemoryTree(paths("index.md", "persona.md"));
    expect(labels(rows)).toEqual(["f:index.md", "f:persona.md"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  test("a folder comes before the files beside it", () => {
    const rows = buildMemoryTree(paths("aaa.md", "projects/b.md", "zzz.md"));
    expect(labels(rows)).toEqual(["d:projects", "f:b.md", "f:aaa.md", "f:zzz.md"]);
  });

  test("nested folders emit parent before child with a growing depth", () => {
    const rows = buildMemoryTree(paths("projects/lettuce/deploy.md"));
    expect(rows.map((row) => `${row.kind}:${row.depth}:${row.path}`)).toEqual([
      "dir:0:projects",
      "dir:1:projects/lettuce",
      "file:2:projects/lettuce/deploy.md",
    ]);
  });

  test("a folder counts every file below it, however deep", () => {
    const rows = buildMemoryTree(
      paths("projects/lettuce/deploy.md", "projects/lettuce/more/deep.md", "projects/other.md"),
    );
    expect(rows.filter((row) => row.kind === "dir").map((dir) => [dir.path, dir.count])).toEqual([
      ["projects", 3],
      ["projects/lettuce", 2],
      ["projects/lettuce/more", 1],
    ]);
  });

  test("folders and files each sort by name, numbers honoured", () => {
    const rows = buildMemoryTree(paths("notes10/a.md", "notes2/a.md", "Beta.md", "alpha.md"));
    expect(labels(rows)).toEqual([
      "d:notes2",
      "f:a.md",
      "d:notes10",
      "f:a.md",
      "f:alpha.md",
      "f:Beta.md",
    ]);
  });

  test("a file and a directory may share a name", () => {
    expect(labels(buildMemoryTree(paths("notes", "notes/inside.md")))).toEqual([
      "d:notes",
      "f:inside.md",
      "f:notes",
    ]);
  });

  test("junk in a path does not invent a level", () => {
    const rows = buildMemoryTree(paths("./a//b/../c.md", "/rooted.md", "back\\slash.md"));
    // The backslash is a separator because upstream's own listing can carry Windows ones,
    // so a mock of `system\persona.md` folding is the correct result, not a mangling.
    expect(rows.map((row) => `${row.kind}:${row.path}`)).toEqual([
      "dir:a",
      "file:a/c.md",
      "dir:back",
      "file:back/slash.md",
      "file:rooted.md",
    ]);
  });

  test("a path that walks out of the memory is not a file", () => {
    expect(buildMemoryTree(paths("../escape.md", "", "."))).toEqual([]);
  });

  test("an entry whose path is not a string is no row", () => {
    // The entries reach here through the BFF unvalidated and there is no error boundary,
    // so this is the difference between a missing row and a blank app.
    const junk = [{ relative_path: null }, { relative_path: 42 }] as unknown as MemoryPathEntry[];
    expect(buildMemoryTree(junk)).toEqual([]);
    expect(memoryTreeCounts(junk)).toEqual({ files: 0, folders: 0 });
    expect(filterMemoryPaths(junk, "anything")).toEqual([]);
  });

  test("every directory path is listed for expand-all", () => {
    expect(memoryTreeDirs(buildMemoryTree(paths("a/b/c.md")))).toEqual(["a", "a/b"]);
  });

  test("a row is visible only when its whole chain is open", () => {
    const rows = buildMemoryTree(paths("a/b/c.md"));
    const deep = rows[rows.length - 1]!;
    expect(isRowVisible(deep, new Set())).toBe(false);
    expect(isRowVisible(deep, new Set(["a"]))).toBe(false);
    expect(isRowVisible(deep, new Set(["a", "a/b"]))).toBe(true);
  });

  test("a closed folder still shows itself", () => {
    const rows = buildMemoryTree(paths("a/b/c.md"));
    expect(isRowVisible(rows[0]!, new Set())).toBe(true);
  });
});

describe("the memory filter", () => {
  const entries = paths(
    "projects/tools/slack.md",
    "skills/using-slack/SKILL.md",
    "reference/slack-api-notes.md",
    "reference/other.md",
  );

  test("an empty query is not a filter", () => {
    expect(filterMemoryPaths(entries, "")).toEqual([]);
    expect(filterMemoryPaths(entries, "   ")).toEqual([]);
  });

  test("names match case-insensitively, alphabetically", () => {
    expect(filterMemoryPaths(entries, "SLACK").map((match) => match.path)).toEqual([
      // Base-letter ordering, so SKILL.md sorts on its letters like any other name.
      "skills/using-slack/SKILL.md",
      "reference/slack-api-notes.md",
      "projects/tools/slack.md",
    ]);
  });

  test("a folder word matches everything under it", () => {
    expect(filterMemoryPaths(entries, "reference").map((match) => match.path)).toEqual([
      "reference/other.md",
      "reference/slack-api-notes.md",
    ]);
  });

  test("one folder word reaches files several levels down", () => {
    const deep = paths("projects/tools/slack.md", "projects/tools/deep/deeper/note.md");
    expect(filterMemoryPaths(deep, "tools").map((match) => match.path)).toEqual([
      "projects/tools/deep/deeper/note.md",
      "projects/tools/slack.md",
    ]);
  });

  test("a match carries the entry and the folder that tells it apart", () => {
    expect(filterMemoryPaths(entries, "slack-api")[0]).toEqual({
      path: "reference/slack-api-notes.md",
      name: "slack-api-notes.md",
      parent: "reference",
      entry: { relative_path: "reference/slack-api-notes.md" },
    });
  });

  test("nothing matching is nothing returned", () => {
    expect(filterMemoryPaths(entries, "slackw")).toEqual([]);
  });
});

describe("the bar's numbers", () => {
  test("files and folders are counted once each", () => {
    expect(memoryTreeCounts(paths("a/1.md", "a/b/2.md", "top.md"))).toEqual({
      files: 3,
      folders: 2,
    });
  });
});
