"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

const HoverTime = createContext<number | null>(null);
const SetHoverTime = createContext<(time: number | null) => void>(() => {});

/** Share a timestamp, rather than a pixel offset, across independently zoomed axes. */
export function TimelineCursorProvider({ children }: { children: ReactNode }) {
  const [time, setTime] = useState<number | null>(null);
  return (
    <SetHoverTime.Provider value={setTime}>
      <HoverTime.Provider value={time}>{children}</HoverTime.Provider>
    </SetHoverTime.Provider>
  );
}

export function useTimelineHoverTime() {
  return useContext(HoverTime);
}

function TimelineCursor({ start, end }: { start: number; end: number }) {
  const time = useTimelineHoverTime();
  if (time === null || time < start || time > end || end <= start) return null;
  return <span aria-hidden="true" data-timeline-cursor={time}
    className="pointer-events-none absolute inset-y-0 z-10 border-l border-violet-500/80 dark:border-violet-400/80"
    style={{ left: `${(time - start) / (end - start) * 100}%` }} />;
}

/**
 * Elapsed and wall-clock time at the cursor, pinned to a timeline axis. The
 * pill stays inside the axis at either edge rather than overflowing it.
 */
export function TimelineCursorLabel({ start, end, format }: {
  start: number; end: number; format: (elapsedMs: number) => string;
}) {
  const time = useTimelineHoverTime();
  if (time === null || time < start || time > end || end <= start) return null;
  const fraction = (time - start) / (end - start);
  const clock = new Date(time).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  return (
    <span aria-hidden="true"
      className="pointer-events-none absolute top-1/2 z-20 inline-flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-violet-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow-sm dark:bg-violet-500"
      style={{ left: `${fraction * 100}%`, transform: `translate(-${fraction * 100}%, -50%)` }}>
      {format(time - start)}
      <span className="font-medium text-violet-100">{clock}</span>
    </span>
  );
}

/** Only the cursor subscribes to movement; the waterfall rows need not rerender. */
export function TimelineHoverArea({ start, end, className = "", children }: {
  start: number; end: number; className?: string; children: ReactNode;
}) {
  const setTime = useContext(SetHoverTime);
  return (
    <div className={`relative ${className}`} data-timeline-start={start} data-timeline-end={end}
      onMouseLeave={() => setTime(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width > 0 && end > start) {
          const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          setTime(start + fraction * (end - start));
        }
      }}>
      {children}
      <TimelineCursor start={start} end={end} />
    </div>
  );
}
