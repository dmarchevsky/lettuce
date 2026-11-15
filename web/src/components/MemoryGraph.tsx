import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  folderColor,
  type MemoryGraph as Graph,
  labelSet,
  layoutGraph,
  nodeLabel,
  nodeRadius,
  type Point,
  placeLabels,
  scatterRing,
} from "../lib/memory-graph.ts";

interface Props {
  graph: Graph;
  /** Files with no links at all, drawn on the ring only when asked for. */
  unlinked: string[];
  showUnlinked: boolean;
  /** The file open in the sheet, so the graph can point at it. */
  openPath: string | null;
  onOpen: (path: string) => void;
}

interface View {
  k: number;
  x: number;
  y: number;
}

const IDENTITY: View = { k: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
/** A drag past this many pixels is a pan, and whatever is under it stays shut. */
const TAP_SLOP = 8;
/** A dot is small; a finger is not. This is how close a tap must land to count. */
const HIT_SLOP = 16;

function clampZoom(k: number): number {
  return Math.min(Math.max(k, MIN_ZOOM), MAX_ZOOM);
}

/**
 * The Memory pane's link graph: a force layout you can pan, zoom and tap.
 *
 * Deliberately a picture rather than a widget — no animation loop, no dragging
 * nodes into a private shape, nothing that keeps burning frames while somebody
 * reads. The layout is computed once per surface size (see lib/memory-graph.ts),
 * so the same memory draws the same picture until the memory changes.
 *
 * There is one pointer handler, on the surface, and taps are resolved by
 * distance rather than by a DOM node per file: with a handler on every node, a
 * few hundred files means a few hundred listeners, and the a11y rules are right
 * that a `<g>` is not a button. The tree view is the keyboard path through the
 * same files; this surface is one image with a name.
 */
export function MemoryGraph({ graph, unlinked, showUnlinked, openPath, onOpen }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(IDENTITY);
  const [hover, setHover] = useState<string | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ distance: number; zoom: number } | null>(null);
  const travelled = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const positions = useMemo(
    () => (width > 0 && height > 0 ? layoutGraph(graph, { width, height }) : new Map()),
    [graph, width, height],
  );
  const ring = useMemo(() => {
    if (!showUnlinked || width <= 0) return new Map<string, Point>();
    const points = scatterRing(unlinked.length, width, height);
    const out = new Map<string, Point>();
    unlinked.forEach((path, i) => {
      const point = points[i];
      if (point) out.set(path, point);
    });
    return out;
  }, [showUnlinked, unlinked, width, height]);

  // Wheel zoom must be a non-passive native listener: React's is passive, so
  // preventDefault on it does nothing and the page scrolls under the gesture.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => {
        const next = clampZoom(current.k * Math.exp(-event.deltaY * 0.0015));
        const ratio = next / current.k;
        return { k: next, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const zoomAroundCentre = useCallback(
    (factor: number) => {
      setView((current) => {
        const next = clampZoom(current.k * factor);
        const ratio = next / current.k;
        const cx = width / 2;
        const cy = height / 2;
        return { k: next, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
      });
    },
    [width, height],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current =
        a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.k } : null;
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;

    // Two fingers: pinch about the midpoint, from the zoom held at pinch start.
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < 1) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const target = clampZoom((gesture.current.zoom * distance) / gesture.current.distance);
      setView((current) => {
        const ratio = target / current.k;
        return {
          k: target,
          x: mid.x - (mid.x - current.x) * ratio,
          y: mid.y - (mid.y - current.y) * ratio,
        };
      });
      return;
    }

    travelled.current += Math.abs(dx) + Math.abs(dy);
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const endPointer = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  /** The nearest file to a point on the surface, if anything is near enough. */
  const fileAt = useCallback(
    (event: { clientX: number; clientY: number }): string | null => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      const current = viewRef.current;
      const gx = (event.clientX - rect.left - current.x) / current.k;
      const gy = (event.clientY - rect.top - current.y) / current.k;
      let best: string | null = null;
      let bestDistance = Infinity;
      const consider = (path: string, point: Point, radius: number) => {
        const distance = Math.hypot(point.x - gx, point.y - gy);
        if (distance <= Math.max(radius, HIT_SLOP) && distance < bestDistance) {
          best = path;
          bestDistance = distance;
        }
      };
      for (const node of graph.nodes) {
        const point = positions.get(node.path);
        if (point) consider(node.path, point, nodeRadius(node.degree));
      }
      if (!best) {
        for (const [path, point] of ring) consider(path, point, 3);
      }
      return best;
    },
    [graph.nodes, positions, ring],
  );

  /**
   * A release that did not travel is a tap. Settled here rather than in `onClick`
   * both because the surface is one image with no element per file to click, and
   * because a pointer release is the same event on a finger and a mouse.
   */
  const onTap = (event: React.PointerEvent) => {
    if (pointers.current.size > 1 || travelled.current > TAP_SLOP) return;
    const hit = fileAt(event);
    if (hit) onOpen(hit);
  };

  // Which files get a name: the hubs (or everything, once zoomed in), thinned to
  // the ones with room for their own label, plus whatever the reader is pointing
  // at or has open — those two are always named, however crowded.
  const labels = useMemo(() => {
    const placed = placeLabels(
      graph,
      positions,
      labelSet(graph, view.k > 1.8 ? 1 : view.k > 1.2 ? 2 : 4),
      width,
    );
    if (hover) placed.add(hover);
    if (openPath) placed.add(openPath);
    return placed;
  }, [graph, positions, view.k, hover, openPath, width]);

  const transformed = view.k !== 1 || view.x !== 0 || view.y !== 0;

  return (
    <div className="memory-graph" ref={hostRef}>
      <svg
        className="mg-svg"
        viewBox={`0 0 ${width || 1} ${height || 1}`}
        role="img"
        aria-label={`Memory link graph: ${graph.linked} of ${graph.total} files linked by ${graph.edges.length} links`}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          onPointerMove(event);
          if (pointers.current.size === 0) {
            const hit = fileAt(event);
            setHover((current) => (current === hit ? current : hit));
          }
        }}
        onPointerUp={(event) => {
          onTap(event);
          endPointer(event);
        }}
        onPointerCancel={endPointer}
        onPointerLeave={() => setHover(null)}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.edges.map((edge) => {
            const a = positions.get(edge.a);
            const b = positions.get(edge.b);
            if (!a || !b) return null;
            return (
              <line
                key={`${edge.a}→${edge.b}`}
                className="mg-edge"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}
          {[...ring].map(([path, point]) => (
            <circle key={`lone:${path}`} className="mg-node lone" cx={point.x} cy={point.y} r={3} />
          ))}
          {graph.nodes.map((node) => {
            const point = positions.get(node.path);
            if (!point) return null;
            return (
              <circle
                key={node.path}
                className={`mg-node${node.path === openPath ? " sel" : ""}`}
                cx={point.x}
                cy={point.y}
                r={nodeRadius(node.degree)}
                fill={folderColor(node.folder)}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const point = positions.get(node.path);
            if (!point || !labels.has(node.path)) return null;
            const anchor = point.x < 80 ? "start" : point.x > width - 80 ? "end" : "middle";
            return (
              <text
                key={`label:${node.path}`}
                className={`mg-label${node.degree >= 4 ? " hub" : ""}`}
                x={point.x}
                y={point.y + nodeRadius(node.degree) + 10}
                textAnchor={anchor}
              >
                {nodeLabel(node.path)}
              </text>
            );
          })}
        </g>
      </svg>

      <div className="mg-actions">
        <button
          type="button"
          className="link"
          onClick={() => zoomAroundCentre(1.4)}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="link"
          onClick={() => zoomAroundCentre(1 / 1.4)}
          aria-label="Zoom out"
        >
          −
        </button>
        {transformed ? (
          <button type="button" className="link" onClick={() => setView(IDENTITY)}>
            Fit
          </button>
        ) : null}
      </div>

      <div className="mg-legend">
        {graph.folders.map((folder) => (
          <span className="k" key={folder}>
            <span className="sw" style={{ background: folderColor(folder) }} />
            {folder}
          </span>
        ))}
        {showUnlinked && unlinked.length > 0 ? (
          <span className="k">
            <span className="sw lone" />
            not linked
          </span>
        ) : null}
      </div>
    </div>
  );
}
