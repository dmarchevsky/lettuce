import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  folderColor,
  type MemoryGraph as Graph,
  graphSignature,
  layoutGraph,
  memoryFolder,
  nodeLabel,
  nodeRadius,
  type Point,
  placeLabels,
  scatterRing,
} from "../lib/memory-graph";

interface Props {
  graph: Graph;
  /** Files with no links in or out, drawn as the field around the cluster when shown. */
  unlinked: string[];
  showUnlinked: boolean;
  openPath: string | null;
  onOpen: (path: string) => void;
}

type View = { k: number; x: number; y: number };

const IDENTITY: View = { k: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** Screen-space reach around a node that still counts as a tap — a thumb, not a cursor. */
const HIT_SLOP = 22;
/** Screen pixels of travel between down and up that still counts as a tap. */
const TAP_SLOP = 8;
/** Only relayout when the surface moved more than this; dragging a window is not an edit. */
const RESIZE_SLOP = 48;
/** A legend the width of a phone cannot hold thirty folders; the rest is a count. */
const LEGEND_MAX = 12;
const LABEL_SIZE = 11;

/** How wide a label will be, before the browser gets a chance to disagree. */
function labelWidth(text: string): number {
  return text.length * LABEL_SIZE * 0.58;
}

export function MemoryGraph({ graph, unlinked, showUnlinked, openPath, onOpen }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  const [hover, setHover] = useState<string | null>(null);
  // The layout outlives the render it was computed for on purpose: it is keyed on
  // what is *in* the graph, so a memory frame that changed nothing costs nothing.
  const [laid, setLaid] = useState<{
    sig: string;
    width: number;
    height: number;
    positions: Map<string, Point>;
  } | null>(null);

  const nodes = graph.nodes;
  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of graph.edges) {
      map.set(edge.a, (map.get(edge.a) ?? 0) + 1);
      map.set(edge.b, (map.get(edge.b) ?? 0) + 1);
    }
    return map;
  }, [graph]);
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!map.has(edge.a)) map.set(edge.a, new Set());
      if (!map.has(edge.b)) map.set(edge.b, new Set());
      (map.get(edge.a) as Set<string>).add(edge.b);
      (map.get(edge.b) as Set<string>).add(edge.a);
    }
    return map;
  }, [graph]);

  // Every node in the graph is linked by definition; the unlinked files arrive as
  // plain paths and only join the picture when asked for.
  const visible = useMemo(
    () =>
      showUnlinked
        ? [...nodes.map((node) => node.path), ...unlinked]
        : nodes.map((node) => node.path),
    [nodes, unlinked, showUnlinked],
  );
  const visibleSet = useMemo(() => new Set(visible), [visible]);
  const signature = useMemo(() => graphSignature(graph), [graph]);

  // Size the surface before laying anything out, because the layout runs in the
  // pixels it will actually be drawn in.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () =>
      setBox({ width: Math.round(host.clientWidth), height: Math.round(host.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // The simulation is the one expensive thing here and a memory pane gets many
  // frames it does not deserve: every file the agent writes re-lists memory. So
  // it runs when the graph *changed* or when the surface changed enough to matter,
  // and a burst of resize events coalesces into one run.
  useEffect(() => {
    if (box.width <= 0 || box.height <= 0) return;
    if (
      laid &&
      laid.sig === signature &&
      Math.abs(laid.width - box.width) <= RESIZE_SLOP &&
      Math.abs(laid.height - box.height) <= RESIZE_SLOP
    )
      return;
    const timer = setTimeout(() => {
      setLaid({
        sig: signature,
        width: box.width,
        height: box.height,
        positions: layoutGraph(graph, { width: box.width, height: box.height }),
      });
    }, 50);
    return () => clearTimeout(timer);
  }, [signature, box.width, box.height, graph, laid]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // The unlinked files are placed on a ring rather than simulated: they have no
  // links to pull on, and putting them in the simulation would drag the cluster
  // apart every time a reader asks to see them.
  const positions = useMemo(() => {
    const base = laid?.positions ?? new Map<string, Point>();
    if (!showUnlinked || unlinked.length === 0) return base;
    const points = scatterRing(
      unlinked.length,
      laid?.width ?? box.width,
      laid?.height ?? box.height,
    );
    const out = new Map(base);
    unlinked.forEach((path, i) => {
      const point = points[i];
      if (point) out.set(path, point);
    });
    return out;
  }, [laid, showUnlinked, unlinked, box.width, box.height]);

  const fit = useCallback(() => {
    const w = box.width;
    const h = box.height;
    if (w <= 0 || h <= 0 || nodes.length === 0) {
      setView(IDENTITY);
      return;
    }
    const points = [...positions.values()];
    if (points.length === 0) {
      setView(IDENTITY);
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    const k = Math.max(
      MIN_ZOOM,
      Math.min(1.4, (Math.min(w, h) * 0.86) / Math.max(160, maxX - minX, maxY - minY)),
    );
    setView({
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    });
  }, [box.width, box.height, nodes.length, positions]);

  // Fit once the layout first exists. Re-fitting on every relayout would fight the
  // reader who has already panned somewhere.
  const fitted = useRef("");
  useEffect(() => {
    const key = `${signature}|${laid?.width ?? 0}`;
    if (!laid || fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [laid, signature, fit]);

  // -- pan / zoom --------------------------------------------------------------
  const pointers = useRef(new Map<number, Point>());
  const panFrom = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const travel = useRef(0);
  const pinched = useRef(false);
  const pinch = useRef<{ dist: number; k: number } | null>(null);

  const zoomAround = useCallback((factor: number, cx: number, cy: number) => {
    const v = viewRef.current;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
    const ratio = k / v.k;
    viewRef.current = { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    setView(viewRef.current);
  }, []);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2) {
      pinched.current = true;
      pinch.current = null;
      panFrom.current = null;
      return;
    }
    travel.current = 0;
    pinched.current = false;
    panFrom.current = { px: event.clientX, py: event.clientY, ox: view.x, oy: view.y };
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = svgRef.current?.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - (rect?.left ?? 0);
      const cy = (a.y + b.y) / 2 - (rect?.top ?? 0);
      if (!pinch.current) pinch.current = { dist, k: viewRef.current.k };
      zoomAround(pinch.current.dist > 0 ? dist / pinch.current.dist : 1, cx, cy);
      return;
    }
    const start = panFrom.current;
    if (!start) return;
    const dx = event.clientX - start.px;
    const dy = event.clientY - start.py;
    travel.current = Math.max(travel.current, Math.hypot(dx, dy));
    const v = viewRef.current;
    viewRef.current = { k: v.k, x: start.ox + dx, y: start.oy + dy };
    setView(viewRef.current);
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size >= 1) return; // the other finger of a pinch is still down
    panFrom.current = null;
    pinch.current = null;
  };

  /** The nearest node to a client point, or null. Measured on screen, not in graph space. */
  function nodeAt(clientX: number, clientY: number): string | null {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const v = viewRef.current;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: string | null = null;
    let bestDist = Infinity;
    const consider = (path: string) => {
      const point = positions.get(path);
      if (!point) return;
      const dist = Math.hypot(px - (point.x * v.k + v.x), py - (point.y * v.k + v.y));
      const reach = Math.max(HIT_SLOP, nodeRadius(degree.get(path) ?? 0) * v.k + 8);
      if (dist <= reach && dist < bestDist) {
        best = path;
        bestDist = dist;
      }
    };
    for (const path of visible) consider(path);
    return best;
  }

  const onTap = (event: React.PointerEvent<SVGSVGElement>) => {
    // A two-finger gesture is a zoom no matter where the fingers end up, and the
    // finger left on the glass after a pinch would otherwise open a file.
    if (pinched.current || travel.current > TAP_SLOP) return;
    const hit = nodeAt(event.clientX, event.clientY);
    if (hit) onOpen(hit);
  };

  // Wheel needs a non-passive native listener — React's onWheel cannot preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAround(
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  const zoomBy = (factor: number) => zoomAround(factor, box.width / 2, box.height / 2 - 30);

  // -- what to draw ------------------------------------------------------------
  const hoveredSet = useMemo(() => {
    if (!hover) return null;
    return new Set([hover, ...(neighbours.get(hover) ?? [])]);
  }, [hover, neighbours]);

  const focus = openPath ?? hover;
  const labelled = useMemo(
    () =>
      placeLabels(
        graph,
        // Labels are painted in screen space, so they are placed in screen space:
        // a label that fit at k=1 does not fit the sliver of graph a zoom shows.
        new Map(
          [...positions].map(([path, point]) => [
            path,
            { x: point.x * view.k + view.x, y: point.y * view.k + view.y },
          ]),
        ),
        new Set(
          [...(focus ? [focus] : []), ...(hoveredSet ?? [])].filter((path) => visibleSet.has(path)),
        ),
        box.width,
        view.k,
      ),
    [graph, positions, view, hoveredSet, focus, visibleSet, box.width],
  );

  const legend = useMemo(() => {
    const folders = new Set<string>();
    for (const node of nodes) folders.add(node.folder);
    for (const path of unlinked) folders.add(memoryFolder(path));
    return [...folders].sort();
  }, [nodes, unlinked]);

  // Edges and dots never change while panning, so they are built once per layout.
  const scene = useMemo(
    () => (
      <>
        {graph.edges.map((edge) => {
          const a = positions.get(edge.a);
          const b = positions.get(edge.b);
          if (!a || !b) return null;
          if (!visibleSet.has(edge.a) || !visibleSet.has(edge.b)) return null;
          return (
            <line
              key={`${edge.a}::${edge.b}`}
              className="mg-edge"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        })}
        {/* Iterated over what is visible, not over the linked nodes: the unlinked
            files join the picture by path alone, with no graph node of their own. */}
        {visible.map((path) => {
          const point = positions.get(path);
          if (!point) return null;
          const deg = degree.get(path) ?? 0;
          // A file with no links is drawn as a hollow ring in its folder's own
          // colour: a grey dot at a fade reads as dirt and as background noise,
          // which the mockups showed is worse than not drawing it at all.
          const lone = deg === 0;
          const color = folderColor(memoryFolder(path));
          return (
            <circle
              key={path}
              className={`mg-node${path === openPath ? " sel" : ""}${lone ? " lone" : ""}`}
              cx={point.x}
              cy={point.y}
              r={nodeRadius(deg)}
              fill={color}
              stroke={lone ? color : undefined}
            />
          );
        })}
      </>
    ),
    [graph.edges, visible, positions, visibleSet, degree, openPath],
  );

  const scale = Math.max(0.4, Math.min(3, view.k));

  return (
    <div className="memory-graph" ref={hostRef}>
      <div className="mg-actions">
        <button type="button" onClick={zoomBy.bind(null, 1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={zoomBy.bind(null, 0.8)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={fit} className="mg-fit">
          Fit
        </button>
      </div>
      <svg
        ref={svgRef}
        className="mg-svg"
        width={box.width}
        height={box.height}
        role="img"
        aria-label={`Memory link graph, ${graph.linked} files linked by ${graph.edges.length} links`}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          onPointerMove(event);
          setHover(nodeAt(event.clientX, event.clientY));
        }}
        onPointerUp={(event) => {
          onTap(event);
          endPointer(event);
        }}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onPointerLeave={() => setHover(null)}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${scale})`}>{scene}</g>
        <g className="mg-labels">
          {[...labelled].map((path) => {
            const point = positions.get(path);
            if (!point) return null;
            const label = nodeLabel(path);
            const text = labelWidth(label) * scale;
            const x = point.x * view.k + view.x;
            const y = point.y * view.k + view.y;
            return (
              <text
                key={path}
                className={`mg-label${(degree.get(path) ?? 0) >= 4 ? " hub" : ""}`}
                x={x}
                y={y + nodeRadius(degree.get(path) ?? 0) * view.k + 14}
                textAnchor={
                  x < text / 2 + 6 ? "start" : x > box.width - text / 2 - 6 ? "end" : "middle"
                }
              >
                {label}
              </text>
            );
          })}
        </g>
      </svg>
      <div className="mg-legend" aria-hidden="true">
        {legend.slice(0, LEGEND_MAX).map((folder) => (
          <span className="k" key={folder}>
            <i className="sw" style={{ background: folderColor(folder) }} />
            {folder}
          </span>
        ))}
        {showUnlinked && unlinked.length > 0 ? (
          <span className="k">
            <i className="sw lone" />
            no links
          </span>
        ) : null}
        {legend.length > LEGEND_MAX ? (
          <span className="k">+{legend.length - LEGEND_MAX} more</span>
        ) : null}
      </div>
    </div>
  );
}
