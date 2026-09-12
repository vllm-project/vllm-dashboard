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
    className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-zinc-500 dark:border-zinc-400"
    style={{ left: `${(time - start) / (end - start) * 100}%` }} />;
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
