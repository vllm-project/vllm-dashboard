import type { ReactNode } from "react";

/**
 * The one segmented control for the dashboard: a compact group of mutually
 * exclusive options rendered as a single track. Use it for time ranges,
 * chart modes, and metric toggles. Tabs that switch page content should use
 * `Tabs` instead.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown after the label in muted tabular figures. */
  count?: number;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
}

type SegmentedSize = "sm" | "md";

const SIZE_CLASSES: Record<SegmentedSize, { track: string; item: string }> = {
  sm: {
    track: "rounded-lg p-0.5",
    item: "h-7 rounded-md px-2.5 text-xs",
  },
  md: {
    track: "rounded-lg p-1",
    item: "h-8 rounded-md px-3 text-sm sm:h-8",
  },
};

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "sm",
  className = "",
}: {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: SegmentedSize;
  className?: string;
}) {
  const sizes = SIZE_CLASSES[size];
  return (
    <div
      role="group"
      aria-label={label}
      className={`scrollbar-hidden inline-flex max-w-full items-center overflow-x-auto border border-line bg-surface-muted dark:border-line ${sizes.track} ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={`dashboard-control inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium tabular-nums ${sizes.item} ${
              active
                ? "bg-surface text-foreground shadow-sm ring-1 ring-line dark:bg-surface-raised dark:ring-line-strong"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={active ? "text-muted" : "text-muted/70"}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
