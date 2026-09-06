import type { ReactNode } from "react";

/**
 * The title row of every page. Title and optional description on the left,
 * filters or actions on the right. On narrow screens the actions wrap under
 * the title and stack, so nothing overflows the viewport.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  /** A short status line under the title (refresh state, counts). */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between ${className}`}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            {description}
          </p>
        )}
        {meta && <div className="mt-1.5 text-xs text-muted">{meta}</div>}
      </div>
      {actions && (
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end lg:justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}
