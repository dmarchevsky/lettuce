/**
 * The Memory pane's link graph, derived from what `list_memory` already sent.
 *
 * The only link grammar a memory file has is `[[wiki links]]`, and upstream owns
 * its meaning: letta-code `src/websocket/listener/commands/memory.ts` parses
 * them with `WIKI_LINK_REGEX`, resolves aliases and extension inference against
 * the files that exist, and returns the result per entry as `references` when
 * the request carries `include_references: true`. We deliberately do not parse
 * the body again here — a second implementation of someone else's grammar drifts
 * the first time upstream widens it. The cost is that a link to a file that does
 * not exist is absent rather than flagged, so the graph can never show a broken
 * link; the pane says as much where it would have shown one.
 *
 * The layout is computed once, from a seeded random start, so the same memory
 * draws the same picture every time it is opened: a graph that jumps around
 * between loads is decoration, not information. It is a plain force simulation —
 * pairwise repulsion, a spring per link, a pull to the centre — which needs no
 * library at the sizes this data reaches and keeps `web/` free of a graph
 * dependency for one screen. `plan/mockups/build.py` in the flow directory is
 * the same model in Python; the approved mockups came out of it.
 */

/** The slice of a `list_memory` entry the graph cares about. */
export interface LinkableEntry {
  relative_path: string;
  references?: string[];
}

export interface GraphNode {
  path: string;
  /** Distinct files it shares a link with, in either direction. */
  degree: number;
  /** Top-level folder, or `"(root)"` for a file sitting at the memory root. */
  folder: string;
}

export interface GraphEdge {
  a: string;
  b: string;
}

export interface MemoryGraph {
  /** Files that take part in at least one link, ordered folder then path. */
  nodes: GraphNode[];
  /** Undirected and deduplicated: `a`→`b` and `b`→`a` are one line. */
  edges: GraphEdge[];
  /** `nodes.length` — how much of memory is in the picture. */
  linked: number;
  /** Every file listed, linked or not — the denominator in `26 of 214`. */
  total: number;
  /** Folders present among the linked files, for the legend. */
  folders: string[];
}

export const ROOT_FOLDER = "(root)";

export function memoryFolder(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? ROOT_FOLDER : path.slice(0, slash);
}

function shortName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** What a label shows: `people/ana`, not the whole repo-relative path. */
export function nodeLabel(path: string): string {
  const folder = memoryFolder(path);
  return folder === ROOT_FOLDER ? shortName(path) : `${folder}/${shortName(path)}`;
}

/**
 * Turn listed files into nodes and links. A file counts as linked when a link
 * points at it as well as when it points out — a page three notes all mention is
 * exactly the hub the graph is worth showing.
 */
export function deriveGraph(entries: readonly LinkableEntry[]): MemoryGraph {
  const known = new Set<string>();
  for (const entry of entries) {
    if (entry.relative_path) known.add(entry.relative_path);
  }

  // One map keyed by the sorted pair, so both directions of a link collapse.
  const links = new Map<string, GraphEdge>();
  for (const entry of entries) {
    const from = entry.relative_path;
    if (!from || !known.has(from)) continue;
    for (const raw of entry.references ?? []) {
      const to = raw;
      if (!to || to === from || !known.has(to)) continue;
      const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
      if (!links.has(key)) links.set(key, { a: from, b: to });
    }
  }

  const degree = new Map<string, number>();
  for (const edge of links.values()) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [...degree].map(([path, deg]) => ({
    path,
    degree: deg,
    folder: memoryFolder(path),
  }));
  nodes.sort((x, y) =>
    x.folder === y.folder ? x.path.localeCompare(y.path) : x.folder.localeCompare(y.folder),
  );

  return {
    nodes,
    edges: [...links.values()],
    linked: nodes.length,
    total: entries.length,
    folders: [...new Set(nodes.map((node) => node.folder))].sort(),
  };
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Same seed, same picture. Change it only to offer a "shuffle". */
  seed?: number;
  iterations?: number;
}

/** Deterministic 32-bit PRNG (mulberry32) — no `Math.random` in the layout. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coordinates for every node, in the pixel space it will be drawn in (so a label
 * is the size it renders at rather than a viewBox fraction). Bounded away from
 * the edges by `margin` because a label is centred on its node and would
 * otherwise run off the surface.
 */
export function layoutGraph(graph: MemoryGraph, options: LayoutOptions): Map<string, Point> {
  const { width, height } = options;
  const margin = Math.min(70, Math.max(24, Math.min(width, height) / 6));
  const iterations = options.iterations ?? 320;
  const seed = options.seed ?? 7;
  const positions = new Map<string, Point>();
  const nodes = graph.nodes;
  if (nodes.length === 0 || width <= 0 || height <= 0) return positions;

  const random = prng(seed);
  const index = new Map(nodes.map((node, i) => [node.path, i]));
  const n = nodes.length;
  // Each node is a body with a position and the force accumulating into it for
  // this pass. Objects, not parallel arrays, so the loops below can hold a body
  // in a local instead of indexing three arrays.
  const bodies = nodes.map(() => ({
    x: width / 2 + (random() - 0.5) * (width / 2.5),
    y: height / 2 + (random() - 0.5) * (height / 2.5),
    dx: 0,
    dy: 0,
  }));
  const pairs = graph.edges.flatMap((edge) => {
    const a = index.get(edge.a);
    const b = index.get(edge.b);
    return a === undefined || b === undefined ? [] : [[a, b] as const];
  });

  const k = Math.sqrt((width * height) / n) * 0.55;
  let temp = width / 10;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, margin), max - margin);
  for (let step = 0; step < iterations; step += 1) {
    for (const body of bodies) {
      body.dx = 0;
      body.dy = 0;
    }
    // Every pair pushes apart; every link pulls together. O(n²) per pass, which
    // at a few hundred files is a frame or two, and the picture is static after.
    for (let i = 0; i < n; i += 1) {
      const a = bodies[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const b = bodies[j]!;
        const ox = a.x - b.x;
        const oy = a.y - b.y;
        const distance = Math.hypot(ox, oy) || 0.01;
        const force = (k * k) / distance;
        a.dx += (ox / distance) * force;
        a.dy += (oy / distance) * force;
        b.dx -= (ox / distance) * force;
        b.dy -= (oy / distance) * force;
      }
    }
    for (const [i, j] of pairs) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      const ox = a.x - b.x;
      const oy = a.y - b.y;
      const distance = Math.hypot(ox, oy) || 0.01;
      const force = ((distance * distance) / k) * 0.5;
      a.dx -= (ox / distance) * force;
      a.dy -= (oy / distance) * force;
      b.dx += (ox / distance) * force;
      b.dy += (oy / distance) * force;
    }
    for (let i = 0; i < n; i += 1) {
      const body = bodies[i]!;
      body.dx += (width / 2 - body.x) * 0.06;
      body.dy += (height / 2 - body.y) * 0.06;
      const distance = Math.hypot(body.dx, body.dy) || 0.01;
      const stride = Math.min(distance, temp);
      body.x = clamp(body.x + (body.dx / distance) * stride, width);
      body.y = clamp(body.y + (body.dy / distance) * stride, height);
    }
    temp *= 0.977;
  }

  nodes.forEach((node, i) => {
    const body = bodies[i]!;
    positions.set(node.path, { x: body.x, y: body.y });
  });
  return positions;
}

/** Dot size: a hub has to read as a hub without anyone counting its lines. */
export function nodeRadius(degree: number): number {
  return 3.5 + Math.min(6, degree * 0.75);
}

/**
 * Which nodes get their name written next to them. Labelling everything reads as
 * mush (the mockups proved it at desktop density), so it is the hubs plus
 * whatever the reader is pointing at or has open; zoom raises the bar it has to
 * clear.
 */
export function labelSet(graph: MemoryGraph, minDegree = 4): Set<string> {
  return new Set(graph.nodes.filter((node) => node.degree >= minDegree).map((node) => node.path));
}
