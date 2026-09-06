"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Underline tabs that switch what a page shows. Items are links when they
 * carry an `href` (route tabs) and buttons otherwise (in-page tabs). Section
 * navigation, page tabs, and table view tabs all use this so the affordance is
 * identical everywhere.
 */
export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  href?: string;
  count?: number;
  /** Optional accessible name when `label` is not plain text. */
  ariaLabel?: string;
}

type TabSize = "sm" | "md";

const SIZE_CLASSES: Record<TabSize, string> = {
  sm: "min-h-9 text-xs font-semibold",
  md: "min-h-10 text-sm font-medium",
};

export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  size = "md",
  trailing,
  className = "",
}: {
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange?: (value: T) => void;
  size?: TabSize;
  /** Right-aligned content on the same baseline (filters, toggles, menus). */
  trailing?: ReactNode;
  className?: string;
}) {
  const itemClass = (active: boolean) =>
    `dashboard-control -mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 ${SIZE_CLASSES[size]} ${
      active
        ? "border-foreground text-foreground"
        : "border-transparent text-muted hover:text-foreground"
    }`;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line ${className}`}
    >
      <div
        role={onChange ? "tablist" : undefined}
        aria-label={label}
        className="scrollbar-hidden -mb-px flex min-w-0 gap-5 overflow-x-auto"
      >
        {items.map((item) => {
          const active = item.value === value;
          const content = (
            <>
              {item.label}
              {item.count !== undefined && (
                <span
                  className={`tabular-nums text-xs font-medium ${
                    active ? "text-muted" : "text-muted/70"
                  }`}
                >
                  {item.count}
                </span>
              )}
            </>
          );
          if (item.href) {
            return (
              <Link
                key={item.value}
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={item.ariaLabel}
                className={itemClass(active)}
              >
                {content}
              </Link>
            );
          }
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={item.ariaLabel}
              onClick={() => onChange?.(item.value)}
              className={itemClass(active)}
            >
              {content}
            </button>
          );
        })}
      </div>
      {trailing && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 pb-2">
          {trailing}
        </div>
      )}
    </div>
  );
}
