import Link from "next/link";
import type { ReactNode } from "react";
import { Sparkline } from "@/components/sparkline";

type Tone = "green" | "red" | "yellow" | "default";

export interface StatDelta {
  /** Signed change in the card's unit (percentage points, count, seconds). */
  value: number;
  /** Suffix printed after the number, e.g. "pp", "%", "h". */
  unit?: string;
  /** Which direction counts as good. Defaults to "up". */
  goodWhen?: "up" | "down";
  /** What the delta is relative to, e.g. "vs prior 14d". */
  label?: string;
}

interface StatCardProps {
  label: string;
  value: string | number;
  detail?: ReactNode;
  color?: Tone;
  /** Period-over-period change, rendered as a colored chip. */
  delta?: StatDelta;
  /** Recent history rendered as a sparkline in the card's tone. */
  trend?: readonly number[];
  /** Makes the whole card a link. */
  href?: string;
  className?: string;
}

const VALUE_TONE: Record<Tone, string> = {
  green: "text-ok",
  red: "text-bad",
  yellow: "text-warn",
  default: "text-foreground",
};

function formatDelta(delta: StatDelta): string {
  const abs = Math.abs(delta.value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs === Math.round(abs) ? 0 : 1;
  const sign = delta.value > 0 ? "+" : delta.value < 0 ? "−" : "";
  return `${sign}${abs.toFixed(digits)}${delta.unit ?? ""}`;
}

function DeltaChip({ delta }: { delta: StatDelta }) {
  const goodWhen = delta.goodWhen ?? "up";
  const isFlat = delta.value === 0;
  const isGood = goodWhen === "up" ? delta.value > 0 : delta.value < 0;
  const tone = isFlat
    ? "bg-surface-muted text-muted"
    : isGood
      ? "bg-ok-soft text-ok"
      : "bg-bad-soft text-bad";
  const arrow = isFlat ? "" : delta.value > 0 ? "↑" : "↓";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium tabular-nums ${tone}`}
      >
        {arrow && <span aria-hidden="true">{arrow}</span>}
        {formatDelta(delta)}
      </span>
      {delta.label && <span className="text-muted">{delta.label}</span>}
    </span>
  );
}

export function StatCard({
  label,
  value,
  detail,
  color = "default",
  delta,
  trend,
  href,
  className = "",
}: StatCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted sm:text-[13px]">{label}</p>
        {trend && trend.length > 1 && (
          <span className={`-mt-0.5 shrink-0 ${VALUE_TONE[color]}`}>
            <Sparkline values={trend} />
          </span>
        )}
      </div>
      <p
        className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-[28px] ${VALUE_TONE[color]}`}
      >
        {value}
      </p>
      {(delta || detail) && (
        <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
          {delta && <DeltaChip delta={delta} />}
          {detail && (
            <p className="min-w-0 text-xs leading-5 text-muted">
              {detail}
            </p>
          )}
        </div>
      )}
    </>
  );

  const surface = `block rounded-xl border border-line bg-surface p-4 sm:p-5 ${className}`;

  if (href) {
    return (
      <Link
        href={href}
        className={`${surface} dashboard-control hover:border-line-strong hover:shadow-sm`}
      >
        {body}
      </Link>
    );
  }
  return <div className={surface}>{body}</div>;
}
