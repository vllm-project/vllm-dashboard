import type { TriageFacets } from "@/lib/triage-types";

/**
 * One source of truth for triage colors, shared by the queue, drawer, My plate
 * and the rules preview. Class strings are literal so Tailwind sees them.
 *
 * Band hues were checked with the dataviz palette validator (CVD and
 * normal-vision separation pass in both themes): page red, route amber, watch
 * blue, ignore grey. Grey is deliberately low-chroma (it is the "nothing to
 * do" band), and every band also carries its name as text, so color is never
 * the only signal.
 */

export const BAND_ORDER = ["page", "route", "watch", "ignore", "unscored"] as const;
export type BandKey = (typeof BAND_ORDER)[number];

export interface BandStyle {
  label: string;
  /** Solid mark: row stripe, score bar fill, segmented-bar part, legend swatch. */
  fill: string;
  /** Lighter step of the same ramp: the score bar's track. */
  track: string;
  /** Text in the band's ink (score number). Dark steps for contrast. */
  text: string;
  /** Active filter button. White text stays on the 600 steps in both themes (≥ 4.5:1). */
  active: string;
}

export const BAND_STYLES: Record<BandKey, BandStyle> = {
  page: {
    label: "page",
    fill: "bg-red-600 dark:bg-red-500",
    track: "bg-red-100 dark:bg-red-500/20",
    text: "text-red-700 dark:text-red-400",
    active: "bg-red-600 text-white ring-red-600",
  },
  route: {
    label: "route",
    fill: "bg-amber-500",
    track: "bg-amber-100 dark:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-400",
    active: "bg-amber-500 text-zinc-950 ring-amber-500",
  },
  watch: {
    label: "watch",
    fill: "bg-blue-600 dark:bg-blue-500",
    track: "bg-blue-100 dark:bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-400",
    active: "bg-blue-600 text-white ring-blue-600",
  },
  ignore: {
    label: "ignore",
    fill: "bg-zinc-400 dark:bg-zinc-500",
    track: "bg-zinc-200 dark:bg-zinc-700",
    text: "text-zinc-500 dark:text-zinc-400",
    active: "bg-zinc-500 text-white ring-zinc-500 dark:bg-zinc-500 dark:ring-zinc-500",
  },
  unscored: {
    label: "unscored",
    fill: "bg-zinc-200 dark:bg-zinc-700",
    track: "bg-zinc-100 dark:bg-zinc-800",
    text: "text-zinc-400 dark:text-zinc-500",
    active: "bg-zinc-300 text-zinc-900 ring-zinc-300 dark:bg-zinc-600 dark:text-zinc-50 dark:ring-zinc-600",
  },
};

export function bandKey(band: string | null | undefined): BandKey {
  return band && (BAND_ORDER as readonly string[]).includes(band) ? (band as BandKey) : "unscored";
}

export function bandStyle(band: string | null | undefined): BandStyle {
  return BAND_STYLES[bandKey(band)];
}

/** Score bar fill on a 0–100 scale (scores above 100 fill the bar). */
export function scoreFillPercent(score: number | null | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// --- Severity flags -------------------------------------------------------

export type FlagTone = "critical" | "serious" | "warning" | "security";

export interface SeverityFlag {
  key: string;
  label: string;
  tone: FlagTone;
}

export const FLAG_STYLES: Record<FlagTone, string> = {
  // Solid for the single worst signal so it pops in a dense table. Solid fills
  // that carry white text use the 600 steps in both themes (≥ 4.8:1).
  critical: "bg-red-600 text-white",
  serious: "bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-600/30 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/30",
  warning: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-600/30 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30",
  security: "bg-purple-600 text-white",
};

/** Red-family soft style for crash / wrong output (bad, but not "can't serve"). */
export const FLAG_STYLE_CRITICAL_SOFT =
  "bg-red-100 text-red-800 ring-1 ring-inset ring-red-600/30 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30";

/**
 * The scan-for-these signals, worst first: serving broken, crash, wrong
 * output, security, regression, hang, perf −N%, memory. Labels are text, so
 * they read without color.
 */
export function severityFlags(facets: Pick<TriageFacets, "severity" | "type"> | null | undefined): SeverityFlag[] {
  const severity = facets?.severity ?? {};
  const type = facets?.type ?? null;
  const flags: SeverityFlag[] = [];
  if (severity.serving_broken === true) flags.push({ key: "serving_broken", label: "serving broken", tone: "critical" });
  if (severity.crash === true) flags.push({ key: "crash", label: "crash", tone: "critical" });
  if (severity.wrong_output === true) flags.push({ key: "wrong_output", label: "wrong output", tone: "critical" });
  if (severity.security === true) flags.push({ key: "security", label: "security", tone: "security" });
  if (type === "regression") flags.push({ key: "regression", label: "regression", tone: "serious" });
  if (severity.hang === true) flags.push({ key: "hang", label: "hang", tone: "serious" });
  const pct = severity.perf_regression_pct;
  if (typeof pct === "number" && Number.isFinite(pct) && Math.abs(pct) >= 1) {
    flags.push({ key: "perf", label: `perf −${Math.round(Math.abs(pct))}%`, tone: "warning" });
  } else if (type === "perf_regression") {
    flags.push({ key: "perf", label: "perf regression", tone: "warning" });
  }
  if (severity.memory_regression === true) flags.push({ key: "memory", label: "memory", tone: "warning" });
  return flags;
}

/** Style for one flag; only "serving broken" is solid red. */
export function flagStyle(flag: SeverityFlag): string {
  if (flag.tone === "critical" && flag.key !== "serving_broken") return FLAG_STYLE_CRITICAL_SOFT;
  return FLAG_STYLES[flag.tone];
}

// --- Item type --------------------------------------------------------------

const TYPE_STYLES: Record<string, string> = {
  bug: "text-red-700 dark:text-red-400",
  regression: "text-orange-700 dark:text-orange-400",
  perf_regression: "text-orange-700 dark:text-orange-400",
  performance: "text-amber-700 dark:text-amber-400",
  feature: "text-emerald-700 dark:text-emerald-400",
  refactor: "text-sky-700 dark:text-sky-400",
  ci: "text-sky-700 dark:text-sky-400",
  docs: "text-zinc-500 dark:text-zinc-400",
  question: "text-zinc-500 dark:text-zinc-400",
  usage: "text-zinc-500 dark:text-zinc-400",
  spam: "text-zinc-400 line-through dark:text-zinc-500",
};

export function typeStyle(type: string | null | undefined): string {
  return (type && TYPE_STYLES[type]) || "text-zinc-500 dark:text-zinc-400";
}

export function typeLabel(type: string): string {
  return type === "perf_regression" ? "perf regression" : type.replace(/_/g, " ");
}

// --- Chips by category ----------------------------------------------------

export type HardwareVendor = "nvidia" | "amd" | "google" | "intel_gaudi" | "intel_xpu" | "cpu" | "other";

export function hardwareVendor(hardware: string): HardwareVendor {
  const value = hardware.trim();
  if (/^(H100|H200|B200|B300|GB\d+|A100|L40S|L4|RTX|other_nvidia)$/i.test(value) || /^GB/i.test(value)) {
    return "nvidia";
  }
  if (/^MI\d/i.test(value) || value === "other_amd") return "amd";
  if (/^TPU/i.test(value)) return "google";
  if (/^Gaudi/i.test(value)) return "intel_gaudi";
  if (/^XPU/i.test(value)) return "intel_xpu";
  if (/^CPU/i.test(value) || value === "Apple") return "cpu";
  return "other";
}

const CHIP_BASE = "rounded px-1.5 py-px text-[11px] font-medium leading-4 ring-1 ring-inset";

const HARDWARE_STYLES: Record<HardwareVendor, string> = {
  nvidia: "bg-green-50 text-green-800 ring-green-600/25 dark:bg-green-500/10 dark:text-green-300 dark:ring-green-400/25",
  amd: "bg-red-50 text-red-800 ring-red-600/25 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25",
  google: "bg-blue-50 text-blue-800 ring-blue-600/25 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/25",
  intel_gaudi: "bg-cyan-50 text-cyan-800 ring-cyan-600/25 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-400/25",
  intel_xpu: "bg-indigo-50 text-indigo-800 ring-indigo-600/25 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/25",
  cpu: "bg-zinc-100 text-zinc-700 ring-zinc-500/25 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30",
  other: "bg-zinc-100 text-zinc-700 ring-zinc-500/25 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30",
};

export type ChipKind = "hardware" | "model" | "area" | "serving" | "plain";

export function chipStyle(kind: ChipKind, value: string): string {
  switch (kind) {
    case "hardware":
      return `${CHIP_BASE} ${HARDWARE_STYLES[hardwareVendor(value)]}`;
    case "model":
      return `${CHIP_BASE} bg-teal-50 text-teal-800 ring-teal-600/25 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/25`;
    case "area":
      return `${CHIP_BASE} bg-violet-50 text-violet-800 ring-violet-600/25 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/25`;
    case "serving":
      return `${CHIP_BASE} bg-transparent text-zinc-600 ring-zinc-300 dark:text-zinc-400 dark:ring-zinc-700`;
    default:
      return `${CHIP_BASE} bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600/40`;
  }
}

// --- Assignees ---------------------------------------------------------------

/** GitHub avatar for a validated login (login regex is enforced upstream). */
export function avatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** Page/route items with no open assignment need an owner. */
export function isUnrouted(band: string | null | undefined, openAssignments: number): boolean {
  return (band === "page" || band === "route") && openAssignments === 0;
}
