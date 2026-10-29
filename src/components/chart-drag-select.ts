"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/** Below this many pixels a press and release is a click, not a drag. */
const MIN_DRAG_PX = 4;

interface Drag {
  pointerId: number;
  startX: number;
  x: number;
  plot: DOMRect;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * How a category axis spreads its points: "band" gives each point an equal
 * slice (bar charts), "point" puts the first and last on the plot's edges
 * (line charts).
 */
export type AxisScale = "band" | "point";

/** The data point nearest `x` on a category axis of `count` points. */
export function pointIndexAt(
  x: number,
  plot: { left: number; width: number },
  count: number,
  scale: AxisScale,
): number {
  const fraction = (x - plot.left) / plot.width;
  const index =
    scale === "band"
      ? Math.floor(fraction * count)
      : Math.round(fraction * (count - 1));
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Click-and-drag across a recharts chart to pick a span of its data points,
 * the way Datadog zooms a graph to a time range.
 *
 * Nothing re-renders while the pointer moves: redrawing a chart of hundreds
 * of bars on every mousemove is what made dragging lag. The band is a plain
 * element whose style follows the pointer, and the span is worked out once,
 * on release, from where the pointer is over the plot area: `pointCount`
 * points on a category axis spread as `scale` says.
 *
 * Spread `handlers` on an element wrapping the chart, with `containerRef`,
 * and put an absolutely positioned element with `bandRef` inside it.
 * `onSelect` gets the first and last index (ascending) when they differ. A
 * click, Escape, or a cancelled pointer selects nothing.
 */
export function useChartDragSelect(
  pointCount: number,
  scale: AxisScale,
  onSelect: ((first: number, last: number) => void) | undefined,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  function end() {
    if (bandRef.current) bandRef.current.style.display = "none";
    if (containerRef.current) delete containerRef.current.dataset.dragging;
    if (drag.current) window.removeEventListener("keydown", drag.current.onKeyDown);
    drag.current = null;
  }

  function paint(current: Drag) {
    const band = bandRef.current;
    const container = containerRef.current;
    if (!band || !container) return;
    const origin = container.getBoundingClientRect();
    band.style.display = "block";
    band.style.left = `${Math.min(current.startX, current.x) - origin.left}px`;
    band.style.width = `${Math.abs(current.x - current.startX)}px`;
    band.style.top = `${current.plot.top - origin.top}px`;
    band.style.height = `${current.plot.height}px`;
  }

  const handlers = onSelect
    ? {
        onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
          if (event.button !== 0 || pointCount < 2) return;
          const plot = event.currentTarget
            .querySelector(".recharts-cartesian-grid")
            ?.getBoundingClientRect();
          if (!plot || event.clientX < plot.left || event.clientX > plot.right) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          end();
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            x: event.clientX,
            plot,
            onKeyDown: (key) => {
              if (key.key === "Escape") end();
            },
          };
          // Hides the hover tooltip while dragging (see globals.css).
          event.currentTarget.dataset.dragging = "true";
          window.addEventListener("keydown", drag.current.onKeyDown);
        },
        onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
          const current = drag.current;
          if (!current || event.pointerId !== current.pointerId) return;
          current.x = Math.min(
            current.plot.right,
            Math.max(current.plot.left, event.clientX),
          );
          paint(current);
        },
        onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
          const current = drag.current;
          if (!current || event.pointerId !== current.pointerId) return;
          end();
          if (Math.abs(current.x - current.startX) < MIN_DRAG_PX) return;
          const first = pointIndexAt(
            Math.min(current.startX, current.x),
            current.plot,
            pointCount,
            scale,
          );
          const last = pointIndexAt(
            Math.max(current.startX, current.x),
            current.plot,
            pointCount,
            scale,
          );
          if (first !== last) onSelect(first, last);
        },
        onPointerCancel: end,
        onLostPointerCapture: end,
      }
    : {};

  return { containerRef, bandRef, handlers };
}
