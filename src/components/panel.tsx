import type { ReactNode } from "react";

/**
 * The container every chart and table sits in. One radius, one border, one
 * header layout, so pages differ in content rather than chrome.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  padded = false,
  className = "",
  bodyClassName = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls in the header row. */
  actions?: ReactNode;
  children: ReactNode;
  /** Adds standard inner padding. Leave off for tables that bleed to the edge. */
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const hasHeader = title || description || actions;
  return (
    <section
      id={id}
      className={`min-w-0 overflow-hidden rounded-xl border border-line bg-surface ${className}`}
    >
      {hasHeader && (
        <PanelHeader title={title} description={description} actions={actions} />
      )}
      <div className={`${padded ? "p-4 sm:p-5" : ""} ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-4 py-3 sm:px-5 ${className}`}
    >
      <div className="min-w-0">
        {title && (
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
        )}
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** Centered muted message for empty or loading bodies. */
export function PanelEmpty({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-48 items-center justify-center px-6 py-10 text-center text-sm text-muted ${className}`}
    >
      {children}
    </div>
  );
}
