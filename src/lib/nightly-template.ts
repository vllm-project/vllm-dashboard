import type { PerfHistoryRow, EvalHistoryRow } from "@/lib/compare";

// ============================================================================
// Nightly Perf/Eval summary — Slack Canvas delivery
//
// The nightly cron publishes a Slack Canvas (Canvas-flavored Markdown: real
// tables, headings, emoji) comparing, per model, each metric's recent peak, its
// trailing 7-day moving average ±σ, and the current nightly value — and posts a
// short summary message to the channel linking to the canvas. All wording and
// layout live in the CANVAS object below; tokens in {curlyBraces} are replaced
// with live data.
// ============================================================================

export const CANVAS = {
  titlePrefix: "Nightly Perf / Eval — {date}",
  commitLine:
    "**Commit** `{commit}`  vs previous nightly  `{prevCommit}`  ·  latest nightly **{latestDate}**",
  // {perfRegr} {perfImpr} {perfSteady} {evalRegr} {evalImpr} {evalSteady}
  summaryLine:
    "> **Perf:** 🔴 {perfRegr} · 🟢 {perfImpr} improved · {perfSteady} steady  ·  **Eval:** 🔴 {evalRegr} · 🟢 {evalImpr} improved · {evalSteady} steady",
  // {zThreshold} {minPct} {peakWindowDays} {avgWindowDays}
  legend:
    "_● 🔴 = regression vs {avgWindowDays}-day avg (≥{zThreshold}σ & ≥{minPct}%), 🟢 = otherwise. **Δ vs avg** and **Δ vs peak** are relative %. **Peak** over {peakWindowDays}d, **avg ±σ** over trailing {avgWindowDays} days._",
  perfHeading: "## Throughput / GPU",
  perfUnit: "_token/s/gpu · higher is better_",
  evalHeading: "## Eval accuracy",
  evalUnit: "_% correct · higher is better · ±σ in percentage points_",
  // {avgWindowDays}
  perfTableHeader: "| ● | Model | Config | Peak | {avgWindowDays}d avg ±σ | Current | Δ vs avg | Δ vs peak |",
  perfTableDivider: "|:-:|:--|:--|--:|--:|--:|--:|--:|",
  evalTableHeader: "| ● | Model | Task · Metric | Peak | {avgWindowDays}d avg ±σ | Current | Δ vs avg | Δ vs peak |",
  evalTableDivider: "|:-:|:--|:--|--:|--:|--:|--:|--:|",
  noData: "_No nightly data available to compare._",

  // --- channel summary message (mrkdwn, links to the canvas) ---------------
  msgHeader: "*Nightly Perf / Eval — {date}*  ·  <{canvasUrl}|open full table ▸>",
  // Used when the canvas could not be created (degraded fallback, no link).
  msgHeaderNoLink: "*Nightly Perf / Eval — {date}*  _(full canvas unavailable — see details below)_",
  msgCommit: "Commit `{commit}` vs previous nightly `{prevCommit}`",
  msgSummary:
    "{regrEmoji} *{perfRegr}* perf regression(s) · {imprEmoji} {perfImpr} improved · {perfSteady} steady   |   eval: *{evalRegr}* regression(s), {evalImpr} improved",
  // One flagged-row line. {dot} {label} {detail}
  msgFlagLine: "{dot} `{label}` — {detail}",
  msgNoFlags: "🟢 No regressions vs 7-day average.",

  // --- knobs ---------------------------------------------------------------
  commitShaLength: 7,
  statusEmoji: {
    regression: ":red_circle:",
    improvement: ":large_green_circle:",
  } as Record<string, string>,
  dateFormat: {
    month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles",
  } as Intl.DateTimeFormatOptions,
};

export interface NightlyCanvasInput {
  commit: string;
  prevCommit: string;
  /** Latest nightly date (YYYY-MM-DD). */
  latestDate: string | null;
  perfHistory: PerfHistoryRow[];
  evalHistory: EvalHistoryRow[];
  window: { avgWindowDays: number; peakWindowDays: number; zThreshold: number; minPctFlag: number };
}

/** Replace {token} placeholders in a template string with the given values. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}

/** Fraction digits appropriate for a value of the given magnitude. */
function digitsFor(magnitude: number): number {
  const a = Math.abs(magnitude);
  if (a >= 100) return 0;
  if (a >= 1) return 1;
  return 3;
}

/**
 * Format a metric value, choosing precision (and thousands separators) from a
 * reference magnitude so mean/peak/current and the ±σ read at the same scale
 * (e.g. "10,874 ±91" rather than "10,874 ±90.9").
 */
function fmtMetric(v: number | null, reference?: number | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const ref = reference ?? v;
  const d = digitsFor(ref);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function dotFor(status: string): string {
  return status === "regression" ? "🔴" : "🟢";
}

/** Model name without the org prefix, untruncated (canvas/messages have room). */
function modelTail(model: string): string {
  return model.includes("/") ? model.split("/").pop()! : model;
}

/** Relative % with sign, clamping rounding noise to "0.0%". */
function relPct(p: number | null): string {
  if (p === null) return "—";
  const v = p * 100;
  if (Math.abs(v) < 0.05) return "0.0%";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

function evalScore(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(2)}%`;
}

function canvasDate(latestDate: string | null): string {
  const d = latestDate ? new Date(`${latestDate}T12:00:00Z`) : new Date();
  return d.toLocaleDateString("en-US", CANVAS.dateFormat);
}

function counts(rows: { status: string }[]) {
  const regr = rows.filter((r) => r.status === "regression").length;
  const impr = rows.filter((r) => r.status === "improvement").length;
  return { regr, impr, steady: rows.length - regr - impr };
}

/** Build the Canvas-flavored Markdown document (title + perf & eval tables). */
export function renderNightlyCanvas(input: NightlyCanvasInput): { title: string; content: string } {
  const { avgWindowDays, peakWindowDays, zThreshold, minPctFlag } = input.window;
  const tokens = {
    avgWindowDays, peakWindowDays, zThreshold,
    minPct: +(minPctFlag * 100).toFixed(2),
  };
  const p = counts(input.perfHistory);
  const e = counts(input.evalHistory);

  const lines: string[] = [];
  lines.push(fill(CANVAS.commitLine, {
    commit: input.commit.slice(0, CANVAS.commitShaLength),
    prevCommit: input.prevCommit.slice(0, CANVAS.commitShaLength),
    latestDate: input.latestDate ?? canvasDate(input.latestDate),
  }));
  lines.push("");
  lines.push(fill(CANVAS.summaryLine, {
    perfRegr: p.regr, perfImpr: p.impr, perfSteady: p.steady,
    evalRegr: e.regr, evalImpr: e.impr, evalSteady: e.steady,
  }));
  lines.push("");
  lines.push(fill(CANVAS.legend, tokens));

  if (input.perfHistory.length === 0 && input.evalHistory.length === 0) {
    lines.push("");
    lines.push(CANVAS.noData);
    return { title: fill(CANVAS.titlePrefix, { date: canvasDate(input.latestDate) }), content: lines.join("\n") };
  }

  if (input.perfHistory.length > 0) {
    lines.push("");
    lines.push(CANVAS.perfHeading);
    lines.push(CANVAS.perfUnit);
    lines.push("");
    lines.push(fill(CANVAS.perfTableHeader, tokens));
    lines.push(CANVAS.perfTableDivider);
    for (const r of input.perfHistory) {
      const sd = r.stddev === null ? "—" : `±${fmtMetric(r.stddev, r.mean)}`;
      lines.push(
        `| ${dotFor(r.status)} | **${modelTail(r.model)}** | ${r.configShort.replace(" ", " · ")} | ` +
        `${fmtMetric(r.peak, r.current)} | ${fmtMetric(r.mean, r.current)} ${sd} | ${fmtMetric(r.current)} | ` +
        `${relPct(r.deltaPct)} | ${relPct(r.deltaPeakPct)} |`,
      );
    }
  }

  if (input.evalHistory.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(CANVAS.evalHeading);
    lines.push(CANVAS.evalUnit);
    lines.push("");
    lines.push(fill(CANVAS.evalTableHeader, tokens));
    lines.push(CANVAS.evalTableDivider);
    for (const r of input.evalHistory) {
      const sd = r.stddev === null ? "—" : `±${(r.stddev * 100).toFixed(2)}`;
      lines.push(
        `| ${dotFor(r.status)} | ${modelTail(r.model)} | \`${r.task} · ${r.metricLabel}\` | ` +
        `${evalScore(r.peak)} | ${evalScore(r.mean)} ${sd} | ${evalScore(r.current)} | ` +
        `${relPct(r.deltaPct)} | ${relPct(r.deltaPeakPct)} |`,
      );
    }
  }

  return {
    title: fill(CANVAS.titlePrefix, { date: canvasDate(input.latestDate) }),
    content: lines.join("\n"),
  };
}

/**
 * Short channel message (mrkdwn). Normally links to the canvas; if canvasUrl is
 * empty (canvas couldn't be created) it degrades to a link-less header so the
 * nightly notification still carries the headline counts and flagged rows.
 */
export function renderChannelSummary(input: NightlyCanvasInput, canvasUrl: string): string {
  const p = counts(input.perfHistory);
  const e = counts(input.evalHistory);
  const lines: string[] = [];
  lines.push(
    canvasUrl
      ? fill(CANVAS.msgHeader, { date: canvasDate(input.latestDate), canvasUrl })
      : fill(CANVAS.msgHeaderNoLink, { date: canvasDate(input.latestDate) }),
  );
  lines.push(fill(CANVAS.msgCommit, {
    commit: input.commit.slice(0, CANVAS.commitShaLength),
    prevCommit: input.prevCommit.slice(0, CANVAS.commitShaLength),
  }));
  lines.push(fill(CANVAS.msgSummary, {
    regrEmoji: CANVAS.statusEmoji.regression,
    imprEmoji: CANVAS.statusEmoji.improvement,
    perfRegr: p.regr, perfImpr: p.impr, perfSteady: p.steady,
    evalRegr: e.regr, evalImpr: e.impr,
  }));

  const flags: string[] = [];
  for (const r of input.perfHistory.filter((r) => r.status === "regression")) {
    flags.push(fill(CANVAS.msgFlagLine, {
      dot: "🔴",
      label: `${modelTail(r.model)} · ${r.configShort}`,
      detail: `regression ${relPct(r.deltaPct)} vs 7d avg, ${relPct(r.deltaPeakPct)} vs peak`,
    }));
  }
  for (const r of input.evalHistory.filter((r) => r.status === "regression")) {
    flags.push(fill(CANVAS.msgFlagLine, {
      dot: "🔴",
      label: `${modelTail(r.model)} · ${r.task} ${r.metricLabel}`,
      detail: `${evalScore(r.mean)} → ${evalScore(r.current)} (${relPct(r.deltaPct)} vs 7d avg)`,
    }));
  }
  lines.push(flags.length > 0 ? flags.join("\n") : CANVAS.msgNoFlags);

  return lines.join("\n").trim();
}
