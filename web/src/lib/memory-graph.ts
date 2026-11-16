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

/**
 * A cheap fingerprint of what is in the graph. The Memory pane re-lists memory
 * every time the agent writes a file, and each listing is a fresh object, so
 * "did the object change" is not a useful question — "did the set of files and
 * links change" is, and answering it is what stops a re-layout on every frame.
 */
export function graphSignature(graph: MemoryGraph): string {
  let hash = 2166136261;
  const eat = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const node of graph.nodes) eat(node.path);
  for (const edge of graph.edges) eat(`${edge.a}\u0000${edge.b}`);
  return `${graph.nodes.length}:${graph.edges.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Iterations that keep a big memory cheap. The sim is O(n²) per pass, and the
 * measure that matters is the freeze on the main thread: 320 passes is lovely at
 * 150 files and about a third of a second at 300. Past the point where the cost
 * starts to bite, the layout coarsens instead of getting slower — a slightly
 * looser picture you can still read beats a half-second stall on every resize.
 */
/** Past this the simulation is replaced by the spiral: a first paint that costs
 * seconds is worse than a plainer picture. */
export const SIM_MAX = 500;

export function layoutIterations(count: number): number {
  if (count <= 0) return 0;
  if (count > SIM_MAX) return 0;
  return Math.max(40, Math.min(320, Math.round(20000 / count)));
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
  const seed = options.seed ?? 7;
  const positions = new Map<string, Point>();
  const nodes = graph.nodes;
  if (nodes.length === 0 || width <= 0 || height <= 0) return positions;

  const random = prng(seed);
  const index = new Map(nodes.map((node, i) => [node.path, i]));
  const n = nodes.length;
  // Too big to simulate: a shape you can see now beats a picture that costs seconds.
  if (n > SIM_MAX && options.iterations === undefined) return spiralLayout(graph, options);
  const iterations = options.iterations ?? layoutIterations(n);
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

/**
 * Where the files with no links go when the reader asks to see them: a ring
 * outside the cluster, because "everything here is an island" is itself a fact
 * worth seeing, and scattering them through the cluster would read as noise in
 * the graph. Deterministic for the same reason the layout is.
 */
export function scatterRing(
  count: number,
  width: number,
  height: number,
  around?: { minX: number; maxX: number; minY: number; maxY: number },
  seed = 11,
): Point[] {
  const out: Point[] = [];
  if (count <= 0 || width <= 0 || height <= 0) return out;
  const random = prng(seed);
  // With a cluster to keep clear, the ring is an ellipse around its bounding box
  // rather than at the edge of the surface: the layout clamps the cluster into
  // that same surface, so a ring on the margins lands *inside* it and the islands
  // end up on top of real dots — the dirt the plan rejected, just ringed.
  const cx = around ? (around.minX + around.maxX) / 2 : width / 2;
  const cy = around ? (around.minY + around.maxY) / 2 : height / 2;
  const rx = around
    ? Math.min(width / 2 - 10, Math.max((around.maxX - around.minX) * 0.75, width * 0.28))
    : (width / 2) * 0.9;
  const ry = around
    ? Math.min(height / 2 - 10, Math.max((around.maxY - around.minY) * 0.75, height * 0.28))
    : (height / 2) * 0.9;
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 0.78 + random() * 0.22;
    out.push({
      x: Math.min(Math.max(cx + Math.cos(angle) * rx * radius, 8), width - 8),
      y: Math.min(Math.max(cy + Math.sin(angle) * ry * radius, 8), height - 8),
    });
  }
  return out;
}

/**
 * The layout for a memory too big to simulate: a golden-angle spiral, folders
 * contiguous because the nodes arrive sorted by folder. No forces, so its cost
 * does not care about size — at a thousand files a reader wants the shape of the
 * pile and the tree, not a force diagram they have to wait for.
 */
export function spiralLayout(graph: MemoryGraph, options: LayoutOptions): Map<string, Point> {
  const { width, height } = options;
  const positions = new Map<string, Point>();
  const nodes = graph.nodes;
  if (nodes.length === 0 || width <= 0 || height <= 0) return positions;
  const margin = Math.min(70, Math.max(24, Math.min(width, height) / 6));
  const usableH = height - margin * 2;
  const usableW = width - margin * 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.min(usableW, usableH) / 2.1;
  nodes.forEach((node, i) => {
    const angle = i * golden;
    const radius = spread * Math.sqrt((i + 1) / nodes.length);
    positions.set(node.path, {
      x: width / 2 + Math.cos(angle) * radius * (usableW / Math.min(usableW, usableH)) * 0.9,
      y: height / 2 + Math.sin(angle) * radius,
    });
  });
  return positions;
}

/** Folders coloured consistently between loads — a hash, not a random draw. */
const FOLDER_HUES = [210, 340, 165, 275, 30, 185, 230, 105, 50, 315, 130, 0];

export function folderColor(folder: string): string {
  let hash = 0;
  for (const ch of folder) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = FOLDER_HUES[Math.abs(hash) % FOLDER_HUES.length] ?? 210;
  return `hsl(${hue} 68% 62%)`;
}

/** Rough rendered width of a label at the graph's font size — enough to judge collisions. */
export function labelWidth(text: string): number {
  return text.length * 5.8;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Which labels fit. Every candidate wants the same strip of screen under its
 * node, and a name painted over another name is worse than no name: the hub
 * stays labelled and the quieter file goes unlabelled until the reader zooms.
 * Greedy in hub order, because the point of the picture is the hubs.
 */
/**
 * Where a label's centre has to go for the whole label to stay on the surface.
 * The collision test and the paint must use this same clamp, or a label counted as
 * fitting is not the label that gets drawn.
 */
export function labelCentre(x: number, text: string, width: number): number {
  const half = labelWidth(text) / 2;
  return Math.min(Math.max(x, Math.min(half, width / 2)), width - Math.min(half, width / 2));
}

export function placeLabels(
  graph: MemoryGraph,
  positions: ReadonlyMap<string, Point>,
  candidates: ReadonlySet<string>,
  width: number,
  scale = 1,
): Set<string> {
  const placed = new Set<string>();
  const boxes: Box[] = [];
  const order = [...graph.nodes]
    .filter((node) => candidates.has(node.path) && positions.has(node.path))
    .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path));
  for (const node of order) {
    const point = positions.get(node.path);
    if (!point) continue;
    const text = nodeLabel(node.path);
    const half = labelWidth(text) / 2;
    const centre = labelCentre(point.x, text, width);
    const reach = nodeRadius(node.degree) * scale;
    const box: Box = {
      left: centre - half,
      right: centre + half,
      top: point.y - reach - 6,
      bottom: point.y + reach + 20,
    };
    if (boxes.some((other) => overlaps(box, other))) continue;
    boxes.push(box);
    placed.add(node.path);
  }
  return placed;
}
