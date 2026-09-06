"use client";

/**
 * A labeled on/off switch for view options ("Hide soft fail", "Optimal only").
 * Used in toolbars beside tabs and segmented controls.
 */
export function ToggleSwitch({
  checked,
  onToggle,
  label,
  size = "sm",
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  size?: "sm" | "md";
}) {
  const text = size === "sm" ? "text-xs" : "text-sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className={`dashboard-control inline-flex min-h-8 items-center gap-2 whitespace-nowrap font-medium ${text} ${
        checked ? "text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-150 ${
          checked
            ? "border-foreground bg-foreground"
            : "border-line-strong bg-surface-muted"
        }`}
      >
        <span
          className={`h-3.5 w-3.5 rounded-full transition-transform duration-150 motion-reduce:transition-none ${
            checked ? "translate-x-4 bg-background" : "translate-x-0 bg-muted"
          }`}
        />
      </span>
      {label}
    </button>
  );
}
