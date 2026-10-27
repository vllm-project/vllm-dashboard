"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseHandlerDataParam } from "recharts";

/** The data indexes a drag currently spans, in the order the user dragged. */
export interface DragSpan {
  from: number;
  to: number;
}

function pointIndex(state: MouseHandlerDataParam): number | null {
  // null/undefined until the pointer has been over a point; Number(null) is 0.
  if (state.activeTooltipIndex == null) return null;
  const index = Number(state.activeTooltipIndex);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Click-and-drag across a recharts chart to pick a span of its data points,
 * the way Datadog zooms a graph to a time range. Spread `handlers` on the
 * chart and draw `span` as a ReferenceArea while it is set. `onSelect` gets
 * the first and last index (ascending) once the mouse is released over a
 * different point than it was pressed on; a plain click selects nothing.
 * Escape, or releasing outside the chart, cancels.
 */
export function useChartDragSelect(
  onSelect: ((first: number, last: number) => void) | undefined,
) {
  const [span, setSpan] = useState<DragSpan | null>(null);
  // The button is down over the chart; the span starts at the first point
  // the pointer is over, which on a press with no hover yet is a later move.
  const pressed = useRef(false);
  const dragging = span !== null;

  useEffect(() => {
    if (!dragging) return;
    const cancel = () => {
      pressed.current = false;
      setSpan(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    // A mouseup over the chart is handled (and stops here) first; one that
    // reaches the window was released outside it.
    window.addEventListener("mouseup", cancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", cancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging]);

  const handlers = onSelect
    ? {
        onMouseDown: (state: MouseHandlerDataParam) => {
          pressed.current = true;
          const index = pointIndex(state);
          if (index !== null) setSpan({ from: index, to: index });
        },
        onMouseMove: (
          state: MouseHandlerDataParam,
          event: { buttons?: number },
        ) => {
          // Released outside the chart before any span started.
          if (event.buttons === 0) pressed.current = false;
          if (!pressed.current) return;
          const index = pointIndex(state);
          if (index === null) return;
          if (!span) setSpan({ from: index, to: index });
          else if (index !== span.to) setSpan({ ...span, to: index });
        },
        onMouseUp: (
          _state: MouseHandlerDataParam,
          event: { stopPropagation: () => void },
        ) => {
          event.stopPropagation();
          pressed.current = false;
          if (span && span.from !== span.to) {
            onSelect(Math.min(span.from, span.to), Math.max(span.from, span.to));
          }
          setSpan(null);
        },
      }
    : {};

  return { span, handlers };
}
