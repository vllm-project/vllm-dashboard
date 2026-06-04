import type { CompareSummary, DeltaItem, CoverageItem } from "@/lib/compare";

// ============================================================================
// Nightly Perf/Eval Slack summary — message template
//
// Everything that controls the *wording and layout* of the daily Slack summary
// lives in the TEMPLATE object below. To tweak the message, edit these strings.
//
// Tokens in {curlyBraces} are replaced with live data (see each comment for the
// available tokens). Structural repetition — the per-model sections and the
// status-count fragments — is assembled by the render functions further down,
// which also read their wording from TEMPLATE, so there are no hardcoded
// strings outside this object.
// ============================================================================

export const TEMPLATE = {
  // --- Top-level message ---------------------------------------------------
  // {date}
  header: "*Nightly Perf/Eval Summary — {date}*",
  // {commit} {prevCommit}  (already shortened to commitShaLength)
  commitLine: "Commit: `{commit}` vs previous nightly `{prevCommit}`",
  // {matched} {perfMatched} {evalMatched} {regressions} {improvements} {noisy} {unchanged}
  totalsLine:
    "Total: *{matched} matched* ({perfMatched} perf, {evalMatched} eval) — " +
    "{regressions} regressions, {improvements} improvements, {noisy} noisy, {unchanged} unchanged",
  // Printed on its own line between the summary header and the per-model sections.
  separator: "---",

  // --- Per-model section ---------------------------------------------------
  // {model} {config}
  modelHeader: "*{model}* · {config}",
  // Used when a model has no comparable metrics yet, only missing ones.
  // {model} {totalMissing}
  modelMissingOnly:
    "*{model}* — {totalMissing} metrics missing (not yet run for this nightly)",
  // {status} {detail}   (detail is empty or starts with ": ...")
  perfLine: "  Perf ({status}){detail}",
  // {status} {details}
  evalLine: "  Eval ({status}): {details}",
  // {perfMissing} {evalMissing}
  missingLine: "  _{perfMissing} perf + {evalMissing} eval metrics missing in candidate_",

  // --- Inline fragments ----------------------------------------------------
  // One perf delta, joined with ", " into perfLine's {detail}. {metricLabel} {deltaPct}
  perfDelta: "{metricLabel} {deltaPct}",
  // One eval delta, joined with ", " into evalLine's {details}.
  // {metricLabel} {baseline} {candidate} {sig}
  evalDelta: "`{metricLabel}` {baseline} → {candidate}{sig}",
  // Appended to an eval delta when significance is available. {significance}
  evalSig: " (σ={significance})",

  // Status counts are rendered as "<n> <label>" for each status with count > 0,
  // joined with ", " — in the order listed here.
  statusLabels: {
    regression: "regression",
    improvement: "improvement",
    noisy: "noisy",
    unchanged: "unchanged",
  } as Record<string, string>,

  // --- Formatting knobs ----------------------------------------------------
  commitShaLength: 7,
  dateFormat: {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  } as Intl.DateTimeFormatOptions,
};

export interface ModelGroup {
  model: string;
  config: string;
  perfDeltas: DeltaItem[];
  evalDeltas: DeltaItem[];
  perfMissing: CoverageItem[];
  evalMissing: CoverageItem[];
}

/** Replace {token} placeholders in a template string with the given values. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}

function fmtPct(v: number | null): string {
  if (v === null) return "N/A";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtEvalScore(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function extractConfig(d: DeltaItem): string {
  const parts = d.dimension.split(" - ");
  return parts.length > 1 ? parts.join(" · ") : d.dimension;
}

function groupByModel(
  perfDeltas: DeltaItem[],
  evalDeltas: DeltaItem[],
  perfMissingCandidate: CoverageItem[],
  evalMissingCandidate: CoverageItem[],
): ModelGroup[] {
  const map = new Map<string, ModelGroup>();

  function getGroup(model: string, configSource: string): ModelGroup {
    let g = map.get(model);
    if (!g) {
      g = { model, config: configSource, perfDeltas: [], evalDeltas: [], perfMissing: [], evalMissing: [] };
      map.set(model, g);
    }
    return g;
  }

  for (const d of perfDeltas) {
    const g = getGroup(d.model, extractConfig(d));
    g.perfDeltas.push(d);
  }
  for (const d of evalDeltas) {
    const existing = map.get(d.model);
    const g = getGroup(d.model, existing?.config ?? extractConfig(d));
    g.evalDeltas.push(d);
  }
  for (const c of perfMissingCandidate) {
    const g = getGroup(c.model, c.dimension);
    g.perfMissing.push(c);
  }
  for (const c of evalMissingCandidate) {
    const existing = map.get(c.model);
    const g = getGroup(c.model, existing?.config ?? c.dimension);
    g.evalMissing.push(c);
  }

  return [...map.values()];
}

function countByStatus(deltas: DeltaItem[]): Record<string, number> {
  const counts: Record<string, number> = { regression: 0, improvement: 0, noisy: 0, unchanged: 0 };
  for (const d of deltas) counts[d.status] = (counts[d.status] ?? 0) + 1;
  return counts;
}

/** Render the "N regression, M improvement, ..." status fragment for a set of deltas. */
function formatStatus(deltas: DeltaItem[]): string {
  const counts = countByStatus(deltas);
  const parts: string[] = [];
  for (const [status, label] of Object.entries(TEMPLATE.statusLabels)) {
    const n = counts[status] ?? 0;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.join(", ");
}

export function formatModelSection(g: ModelGroup): string {
  const allDeltas = [...g.perfDeltas, ...g.evalDeltas];
  const totalMissing = g.perfMissing.length + g.evalMissing.length;

  if (allDeltas.length === 0 && totalMissing > 0) {
    return fill(TEMPLATE.modelMissingOnly, { model: g.model, totalMissing });
  }

  const lines: string[] = [];
  lines.push(fill(TEMPLATE.modelHeader, { model: g.model, config: g.config }));

  if (g.perfDeltas.length > 0) {
    const status = formatStatus(g.perfDeltas);
    const summaries = g.perfDeltas
      .filter(d => d.status === "regression" || d.status === "improvement")
      .map(d => fill(TEMPLATE.perfDelta, { metricLabel: d.metricLabel, deltaPct: fmtPct(d.deltaPct) }))
      .join(", ");
    const detail = summaries ? `: ${summaries}` : "";
    lines.push(fill(TEMPLATE.perfLine, { status, detail }));
  }

  if (g.evalDeltas.length > 0) {
    const status = formatStatus(g.evalDeltas);
    const details = g.evalDeltas
      .map(d => {
        const sig = d.significance !== null
          ? fill(TEMPLATE.evalSig, { significance: d.significance.toFixed(2) })
          : "";
        return fill(TEMPLATE.evalDelta, {
          metricLabel: d.metricLabel,
          baseline: fmtEvalScore(d.baselineValue),
          candidate: fmtEvalScore(d.candidateValue),
          sig,
        });
      })
      .join(", ");
    lines.push(fill(TEMPLATE.evalLine, { status, details }));
  }

  if (totalMissing > 0) {
    lines.push(fill(TEMPLATE.missingLine, {
      perfMissing: g.perfMissing.length,
      evalMissing: g.evalMissing.length,
    }));
  }

  return lines.join("\n");
}

export function renderNightlySummary(
  commit: string,
  prevCommit: string,
  date: string,
  summary: CompareSummary,
  perfDeltas: DeltaItem[],
  evalDeltas: DeltaItem[],
  perfMissingCandidate: CoverageItem[],
  evalMissingCandidate: CoverageItem[],
): string {
  const dateStr = new Date(date).toLocaleDateString("en-US", TEMPLATE.dateFormat);

  const lines: string[] = [];
  lines.push(fill(TEMPLATE.header, { date: dateStr }));
  lines.push("");
  lines.push(fill(TEMPLATE.commitLine, {
    commit: commit.slice(0, TEMPLATE.commitShaLength),
    prevCommit: prevCommit.slice(0, TEMPLATE.commitShaLength),
  }));
  lines.push(fill(TEMPLATE.totalsLine, {
    matched: summary.matched,
    perfMatched: summary.perfMatched,
    evalMatched: summary.evalMatched,
    regressions: summary.regressions,
    improvements: summary.improvements,
    noisy: summary.noisy,
    unchanged: summary.unchanged,
  }));

  const groups = groupByModel(perfDeltas, evalDeltas, perfMissingCandidate, evalMissingCandidate);
  if (groups.length > 0) {
    lines.push("");
    lines.push(TEMPLATE.separator);
    lines.push("");
    for (const g of groups) {
      lines.push(formatModelSection(g));
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
