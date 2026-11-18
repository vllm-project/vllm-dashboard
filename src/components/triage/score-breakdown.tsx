import { describeFactor, FACTOR_CATEGORIES, type FactorCategory } from "@/lib/triage-factors";
import type { TriageBreakdownEntry } from "@/lib/triage-types";

/**
 * Category colors, validated with the dataviz palette checker. Adjacent
 * stacked segments pass the colorblind check; every row and segment also
 * carries its category name as text, so color is never the only signal.
 * Order here is the stacking order.
 */
const CATEGORY_STYLES: Record<FactorCategory, { bar: string; row: string; chip: string }> = {
  severity: {
    bar: "bg-red-600",
    row: "bg-red-50/70 dark:bg-red-500/[0.07]",
    chip: "text-red-800 ring-red-600/30 dark:text-red-300 dark:ring-red-400/30",
  },
  recency: {
    bar: "bg-amber-500",
    row: "bg-amber-50/70 dark:bg-amber-500/[0.07]",
    chip: "text-amber-900 ring-amber-600/30 dark:text-amber-300 dark:ring-amber-400/30",
  },
  reach: {
    bar: "bg-blue-600",
    row: "bg-blue-50/70 dark:bg-blue-500/[0.07]",
    chip: "text-blue-800 ring-blue-600/30 dark:text-blue-300 dark:ring-blue-400/30",
  },
  evidence: {
    bar: "bg-lime-600",
    row: "bg-lime-50/70 dark:bg-lime-500/[0.07]",
    chip: "text-lime-900 ring-lime-700/30 dark:text-lime-300 dark:ring-lime-400/30",
  },
  community: {
    bar: "bg-fuchsia-600",
    row: "bg-fuchsia-50/70 dark:bg-fuchsia-500/[0.07]",
    chip: "text-fuchsia-800 ring-fuchsia-600/30 dark:text-fuchsia-300 dark:ring-fuchsia-400/30",
  },
  pr: {
    bar: "bg-cyan-600",
    row: "bg-cyan-50/70 dark:bg-cyan-500/[0.07]",
    chip: "text-cyan-900 ring-cyan-700/30 dark:text-cyan-300 dark:ring-cyan-400/30",
  },
  other: {
    bar: "bg-zinc-500",
    row: "",
    chip: "text-zinc-700 ring-zinc-400/40 dark:text-zinc-300 dark:ring-zinc-500/40",
  },
  penalty: {
    bar: "bg-zinc-400 dark:bg-zinc-500",
    row: "bg-zinc-50 dark:bg-zinc-900/60",
    chip: "text-zinc-700 ring-zinc-400/50 dark:text-zinc-300 dark:ring-zinc-500/50",
  },
  floor: {
    bar: "bg-zinc-300 dark:bg-zinc-600",
    row: "",
    chip: "text-zinc-600 ring-zinc-300 dark:text-zinc-400 dark:ring-zinc-600",
  },
};

const STACK_ORDER: FactorCategory[] = ["severity", "recency", "reach", "evidence", "community", "pr", "other"];

/** Diagonal stripes for the part of the bar that penalties take back. */
const TAKEN_BACK =
  "bg-[repeating-linear-gradient(135deg,rgb(161_161_170/0.55)_0_4px,transparent_4px_7px)] dark:bg-[repeating-linear-gradient(135deg,rgb(113_113_122/0.7)_0_4px,transparent_4px_7px)]";

export function ScoreBreakdown({
  entries,
  score,
  footer,
}: {
  entries: TriageBreakdownEntry[];
  score: number;
  footer?: React.ReactNode;
}) {
  const rows = entries.map((entry) => ({ entry, text: describeFactor(entry.factor, entry.detail, entry.points) }));
  // `floor` only cancels penalties back to 0; it is not a contribution.
  const contributions = rows.filter((row) => row.text.category !== "floor");
  const positive = contributions.filter((row) => row.entry.points > 0);
  const added = positive.reduce((sum, row) => sum + row.entry.points, 0);
  const takenBack = Math.min(added, added - score);
  const byCategory = STACK_ORDER.map((category) => ({
    category,
    points: positive.filter((row) => row.text.category === category).reduce((sum, row) => sum + row.entry.points, 0),
  })).filter((part) => part.points > 0);
  const maxAbs = Math.max(1, ...contributions.map((row) => Math.abs(row.entry.points)));

  return (
    <div className="space-y-3">
      {added > 0 && (
        <div>
          <div
            className="relative flex h-3 w-full gap-0.5 overflow-hidden rounded"
            role="img"
            aria-label={`${byCategory.map((part) => `${FACTOR_CATEGORIES[part.category].label} ${part.points}`).join(", ")}${
              takenBack > 0 ? `, minus ${takenBack} in penalties` : ""
            }, total ${score}`}
          >
            {byCategory.map((part) => (
              <span
                key={part.category}
                title={`${FACTOR_CATEGORIES[part.category].label}: +${part.points}`}
                className={`h-full first:rounded-l last:rounded-r ${CATEGORY_STYLES[part.category].bar}`}
                style={{ flexGrow: part.points, flexBasis: 0 }}
              />
            ))}
            {takenBack > 0 && (
              <span
                aria-hidden="true"
                title={`Penalties: −${takenBack}`}
                className={`absolute inset-y-0 right-0 border-l-2 border-white dark:border-zinc-950 ${TAKEN_BACK}`}
                style={{ width: `${(takenBack / added) * 100}%` }}
              />
            )}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
            {byCategory.map((part) => (
              <li key={part.category} className="inline-flex items-center gap-1" title={FACTOR_CATEGORIES[part.category].meaning}>
                <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${CATEGORY_STYLES[part.category].bar}`} />
                {FACTOR_CATEGORIES[part.category].label}
                <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">+{part.points}</span>
              </li>
            ))}
            {takenBack > 0 && (
              <li className="inline-flex items-center gap-1">
                <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${TAKEN_BACK}`} />
                Penalties
                <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">−{takenBack}</span>
              </li>
            )}
            <li className="ml-auto font-medium text-zinc-900 dark:text-zinc-100">= {score}</li>
          </ul>
        </div>
      )}

      <ul className="space-y-1">
        {rows.map(({ entry, text }, index) => {
          const style = CATEGORY_STYLES[text.category];
          const negative = entry.points < 0;
          const width = text.category === "floor" ? 0 : (Math.abs(entry.points) / maxAbs) * 100;
          return (
            <li
              key={`${entry.factor}-${index}`}
              className={`grid grid-cols-[minmax(0,1fr)_4.5rem_2.75rem] items-center gap-x-3 rounded-md px-2 py-1.5 text-xs ${style.row}`}
              title={entry.factor}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`rounded px-1 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${style.chip}`}>
                    {FACTOR_CATEGORIES[text.category].label}
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{text.title}</span>
                </div>
                {text.detail && <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">{text.detail}</p>}
              </div>
              <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full ${negative ? `ml-auto ${TAKEN_BACK} ring-1 ring-inset ring-zinc-400/60` : style.bar}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span
                className={`text-right font-semibold tabular-nums ${
                  negative ? "text-red-700 dark:text-red-400" : text.category === "floor" ? "text-zinc-500" : "text-zinc-900 dark:text-zinc-100"
                }`}
              >
                {entry.points > 0 ? `+${entry.points}` : entry.points < 0 ? `−${Math.abs(entry.points)}` : "0"}
              </span>
            </li>
          );
        })}
      </ul>
      {footer}
    </div>
  );
}
