import { describe, expect, test } from "bun:test";
import {
  deriveGraph,
  folderColor,
  graphSignature,
  type LinkableEntry,
  labelSet,
  layoutGraph,
  layoutIterations,
  memoryFolder,
  nodeLabel,
  nodeRadius,
  placeLabels,
  ROOT_FOLDER,
  SIM_MAX,
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

describe("label placement", () => {
  test("a hub keeps its label and the cramped neighbour loses its own", () => {
    const graph = deriveGraph([
      file("hub.md", ["a.md", "b.md", "c.md", "d.md"]),
      file("a.md"),
      file("b.md"),
      file("c.md"),
      file("d.md"),
    ]);
    const positions = new Map([
      ["hub.md", { x: 200, y: 200 }],
      ["a.md", { x: 205, y: 205 }],
      ["b.md", { x: 210, y: 210 }],
      ["c.md", { x: 215, y: 215 }],
      ["d.md", { x: 400, y: 400 }],
    ]);
    const placed = placeLabels(
      graph,
      positions,
      new Set(["hub.md", "a.md", "b.md", "c.md", "d.md"]),
      600,
    );
    expect(placed.has("hub.md")).toBe(true);
    expect(placed.has("d.md")).toBe(true);
    expect(placed.has("a.md")).toBe(false);
  });

  test("nothing to place is an empty answer, not a crash", () => {
    expect(placeLabels(deriveGraph([]), new Map(), new Set(), 600).size).toBe(0);
  });
});

describe("graphSignature and layout cost", () => {
  const rows = (extra = false) => {
    const list = [
      { relative_path: "index/people.md", references: ["people/ana.md"] },
      { relative_path: "people/ana.md", references: [] },
      { relative_path: "topics/memory-graph.md", references: ["index/people.md"] },
    ];
    if (extra)
      list.push({ relative_path: "notes/extra.md", references: ["people/ana.md"] as string[] });
    return list as never[];
  };

  test("the fingerprint survives a re-list and dies with the graph", () => {
    const a = deriveGraph(rows());
    // A fresh array of fresh objects — what every memory frame hands us — is the
    // same graph, and must not buy another simulation.
    expect(graphSignature(deriveGraph(rows()))).toBe(graphSignature(a));
    expect(graphSignature(deriveGraph(rows(true)))).not.toBe(graphSignature(a));
  });

  test("iteration count bounds the freeze, not the picture", () => {
    expect(layoutIterations(1)).toBe(320);
    expect(layoutIterations(60)).toBe(320);
    expect(layoutIterations(200)).toBe(100);
    expect(layoutIterations(500)).toBe(40);
    // Past the ceiling the sim is replaced by the spiral, so there are no passes.
    expect(layoutIterations(SIM_MAX + 1)).toBe(0);
    const graph = deriveGraph(
      Array.from({ length: 400 }, (_, i) => ({
        relative_path: `notes/n${i}.md`,
        references: [`notes/n${(i + 1) % 400}.md`],
      })) as never,
    );
    const t0 = performance.now();
    const positions = layoutGraph(graph, { width: 1180, height: 600 });
    // The reviewer measured ~600ms at this size before the count was bounded.
    expect(positions.size).toBe(400);
    expect(performance.now() - t0).toBeLessThan(330);
  });
});

describe("placeLabels at zoom", () => {
  const graph = deriveGraph([
    { relative_path: "index/people.md", references: ["people/ana.md"] },
    { relative_path: "people/ana.md", references: ["topics/x.md"] },
    { relative_path: "topics/x.md", references: [] },
  ] as never);
  const [a, b] = ["index/people.md", "people/ana.md"];
  const place = (screenGap: number, scale: number) =>
    placeLabels(
      graph,
      new Map([
        [a, { x: 300, y: 300 }],
        [b, { x: 300, y: 300 + screenGap }],
      ]),
      new Set([a, b]),
      800,
      scale,
    );

  test("crowding is measured where the label is painted, on screen", () => {
    // Two dots 24px apart on the glass are one label whoever zoomed them there;
    // the caller hands over screen coordinates, so the answer is the same at any
    // graph-space distance. That is what the old graph-space fit got wrong.
    expect(place(24, 1).size).toBe(1);
    expect(place(120, 1).size).toBe(2);
  });

  test("a bigger node reserves a bigger strip for its own name", () => {
    // The same screen gap clears at 1x and collides at a zoom where the dot is
    // three times as wide, because the exclusion strip grows with the node.
    expect(place(60, 1).size).toBe(2);
    expect(place(60, 6).size).toBe(1);
  });
});

describe("a memory too big to simulate", () => {
  const big = (n: number) =>
    deriveGraph(
      Array.from({ length: n }, (_, i) => ({
        relative_path: `notes/n${i}.md`,
        references: [`notes/n${(i + 1) % n}.md`],
      })) as never,
    );

  test("past the ceiling it gets the spiral, not a freeze", () => {
    const graph = big(SIM_MAX + 250);
    const t0 = performance.now();
    const positions = layoutGraph(graph, { width: 1180, height: 600 });
    expect(positions.size).toBe(SIM_MAX + 250);
    expect(performance.now() - t0).toBeLessThan(200);
    for (const point of positions.values()) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(1180);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(600);
    }
  });

  test("the spiral is the same picture twice over", () => {
    const graph = big(SIM_MAX + 250);
    const a = layoutGraph(graph, { width: 1180, height: 600 });
    const b = layoutGraph(graph, { width: 1180, height: 600 });
    expect([...a.values()]).toEqual([...b.values()]);
  });

  test("the island ring lands outside the cluster, not in it", () => {
    const around = { minX: 500, maxX: 680, minY: 250, maxY: 350 };
    const ring = scatterRing(40, 1180, 600, around);
    expect(ring.length).toBe(40);
    for (const point of ring) {
      const inside =
        point.x > around.minX &&
        point.x < around.maxX &&
        point.y > around.minY &&
        point.y < around.maxY;
      expect(inside).toBe(false);
    }
  });
});
