import { describe, expect, test } from "bun:test";
import {
  deriveGraph,
  folderColor,
  type LinkableEntry,
  labelSet,
  layoutGraph,
  memoryFolder,
  nodeLabel,
  nodeRadius,
  ROOT_FOLDER,
  scatterRing,
} from "./memory-graph.ts";

function file(relative_path: string, references?: string[]): LinkableEntry {
  return { relative_path, references };
}

describe("deriveGraph", () => {
  test("only files that take part in a link are nodes", () => {
    const graph = deriveGraph([
      file("index/home.md", ["people/ana.md"]),
      file("people/ana.md", ["index/home.md"]),
      file("notes/inbox.md"),
      file("prefs/tone.md"),
    ]);
    expect(graph.nodes.map((node) => node.path)).toEqual(["index/home.md", "people/ana.md"]);
    expect(graph.linked).toBe(2);
    expect(graph.total).toBe(4);
    expect(graph.edges).toHaveLength(1);
  });

  test("a file that is only ever linked to counts as linked", () => {
    const graph = deriveGraph([file("notes/a.md", ["index/home.md"]), file("index/home.md")]);
    expect(graph.nodes.map((node) => node.path)).toContain("index/home.md");
    expect(graph.edges).toHaveLength(1);
  });

  test("both directions of one link are one line", () => {
    const graph = deriveGraph([file("a.md", ["b.md", "b.md"]), file("b.md", ["a.md"])]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.every((node) => node.degree === 1)).toBe(true);
  });

  test("a link to itself, or to a file that is not listed, is no link at all", () => {
    const graph = deriveGraph([file("a.md", ["a.md", "gone.md"]), file("b.md")]);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes).toEqual([]);
  });

  test("an empty memory is an empty graph, not a missing one", () => {
    const graph = deriveGraph([]);
    expect(graph).toMatchObject({ nodes: [], edges: [], linked: 0, total: 0, folders: [] });
  });

  test("nodes and folders are ordered, so the same memory draws the same picture", () => {
    const entries = [
      file("topics/vector-db.md", ["projects/lettuce.md", "index/home.md", "notes/inbox.md"]),
      file("projects/lettuce.md", ["index/home.md"]),
      file("index/home.md", ["projects/lettuce.md", "topics/vector-db.md"]),
      file("notes/inbox.md"),
    ];
    const graph = deriveGraph(entries);
    expect(graph.nodes.map((node) => node.path)).toEqual([
      "index/home.md",
      "notes/inbox.md",
      "projects/lettuce.md",
      "topics/vector-db.md",
    ]);
    expect(graph.folders).toEqual(["index", "notes", "projects", "topics"]);
    expect(deriveGraph(entries).nodes.map((node) => node.path)).toEqual(
      graph.nodes.map((node) => node.path),
    );
  });

  test("a file at the memory root is its own folder", () => {
    const graph = deriveGraph([file("persona.md", ["notes/x.md"]), file("notes/x.md")]);
    expect(graph.nodes[0]!.folder).toBe(ROOT_FOLDER);
    expect(graph.folders).toEqual([ROOT_FOLDER, "notes"]);
    expect(nodeLabel("persona.md")).toBe("persona");
    expect(memoryFolder("people/ana.md")).toBe("people");
    expect(nodeLabel("people/ana.md")).toBe("people/ana");
  });
});

describe("layoutGraph", () => {
  const graph = deriveGraph([
    file("index/home.md", ["people/ana.md", "projects/lettuce.md"]),
    file("people/ana.md", ["projects/lettuce.md"]),
    file("projects/lettuce.md"),
  ]);

  test("the same memory lays out the same way twice", () => {
    const a = layoutGraph(graph, { width: 360, height: 560 });
    const b = layoutGraph(graph, { width: 360, height: 560 });
    expect([...a]).toEqual([...b]);
  });

  test("every node lands inside the surface, with room for its label", () => {
    const width = 360;
    const height = 560;
    for (const point of layoutGraph(graph, { width, height }).values()) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(width);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(height);
    }
  });

  test("two linked files end up on opposite sides of the middle", () => {
    const points = layoutGraph(deriveGraph([file("a.md", ["b.md"]), file("b.md")]), {
      width: 400,
      height: 400,
    });
    const a = points.get("a.md");
    const b = points.get("b.md");
    expect(a?.x).toBeLessThan(200);
    expect(b?.x).toBeGreaterThan(200);
  });

  test("an empty graph lays out to nothing", () => {
    expect(layoutGraph(deriveGraph([]), { width: 360, height: 560 }).size).toBe(0);
  });

  test("a degenerate surface lays out to nothing rather than dividing by it", () => {
    expect(layoutGraph(graph, { width: 0, height: 0 }).size).toBe(0);
  });
});

describe("drawing rules", () => {
  test("a hub is bigger than a leaf", () => {
    expect(nodeRadius(6)).toBeGreaterThan(nodeRadius(1));
  });

  test("only the hubs are labelled by default", () => {
    const graph = deriveGraph([
      file("hub.md", ["a.md", "b.md", "c.md", "d.md"]),
      file("a.md"),
      file("b.md"),
      file("c.md"),
      file("d.md"),
    ]);
    expect(labelSet(graph).has("hub.md")).toBe(true);
    expect(labelSet(graph).has("a.md")).toBe(false);
    expect(labelSet(graph, 1).size).toBe(5);
  });
});

describe("the unlinked ring and folder colours", () => {
  test("the ring is the same scatter every time, and inside the surface", () => {
    const a = scatterRing(180, 360, 560);
    const b = scatterRing(180, 360, 560);
    expect(a).toEqual(b);
    expect(a).toHaveLength(180);
    for (const point of a) {
      expect(point.x).toBeGreaterThanOrEqual(8);
      expect(point.x).toBeLessThanOrEqual(352);
      expect(point.y).toBeGreaterThanOrEqual(8);
      expect(point.y).toBeLessThanOrEqual(552);
    }
  });

  test("nothing is scattered into a surface that is not there", () => {
    expect(scatterRing(0, 360, 560)).toEqual([]);
    expect(scatterRing(9, 0, 0)).toEqual([]);
  });

  test("a folder's colour is stable and differs between folders", () => {
    expect(folderColor("people")).toBe(folderColor("people"));
    expect(folderColor("people")).not.toBe(folderColor("projects"));
  });
});
