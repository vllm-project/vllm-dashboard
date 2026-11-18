import type { TriageFacets } from "@/lib/triage-types";

/**
 * One source of truth for triage colors, shared by the queue, drawer, My plate
 * and the rules preview. Class strings are literal so Tailwind sees them.
 *
 * Bands are stored as page/route/watch/ignore (DB, API, URLs, config) but
 * shown as priorities P0/P1/P2/P3. `BAND_STYLES[band].label` is the only place
 * that mapping lives.
 *
 * Hues were checked with the dataviz palette validator (CVD and normal-vision
 * separation pass in both themes): P0 red, P1 amber, P2 blue, P3 grey. Color is
 * kept for P0/P1 (stripe, solid badge); P2/P3 stay quiet. Every priority also
 * carries its label as text, so color is never the only signal.
 */

export const BAND_ORDER = ["page", "route", "watch", "ignore", "unscored"] as const;
export type BandKey = (typeof BAND_ORDER)[number];

export interface BandStyle {
  /** Display label: P0…P3, or "Unscored". */
  label: string;
  /** What the priority means, for tooltips and section headers. */
  meaning: string;
  /** Solid mark: segmented-bar part, legend swatch. */
  fill: string;
  /** Text drawn inside `fill` (white or near-black by the fill's luminance). */
  onFill: string;
  /** Lighter step of the same ramp. */
  track: string;
  /** Text in the priority's ink, for the rare colored number. */
  text: string;
  /** The P-badge. P0/P1 solid, P2 soft, P3/Unscored neutral. */
  badge: string;
  /** Toggled-on filter segment: tinted, not solid, so it doesn't shout. */
  tint: string;
  /** Left stripe on rows and cards; only P0/P1 get one. */
  stripe: string;
  /** Row background; only P0 gets a faint tint so it stands apart. */
  row: string;
}

export const BAND_STYLES: Record<BandKey, BandStyle> = {
  page: {
    label: "P0",
    meaning: "Highest impact: routed first",
    fill: "bg-red-600 dark:bg-red-500",
    onFill: "text-white",
    track: "bg-red-100 dark:bg-red-500/20",
    text: "text-red-700 dark:text-red-400",
    badge: "bg-red-600 text-white",
    tint: "bg-red-50 text-red-800 ring-red-600/30 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/40",
    stripe: "bg-red-600 dark:bg-red-500",
    row: "bg-red-50/40 dark:bg-red-500/[0.05]",
  },
  route: {
    label: "P1",
    meaning: "Needs an owner: routed to the best-matching maintainer",
    fill: "bg-amber-500",
    onFill: "text-zinc-950",
    track: "bg-amber-100 dark:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-400",
    badge: "bg-amber-500 text-zinc-950",
    tint: "bg-amber-50 text-amber-900 ring-amber-600/30 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/40",
    stripe: "bg-amber-500",
    row: "",
  },
  watch: {
    label: "P2",
    meaning: "Watch: on the dashboard only",
    fill: "bg-blue-600 dark:bg-blue-500",
    onFill: "text-white",
    track: "bg-blue-100 dark:bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-400",
    badge: "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-600/25 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/30",
    tint: "bg-blue-50 text-blue-800 ring-blue-600/30 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/40",
    stripe: "",
    row: "",
  },
  ignore: {
    label: "P3",
    meaning: "Low: no action expected; hidden by default",
    fill: "bg-zinc-400 dark:bg-zinc-500",
    onFill: "text-zinc-950",
    track: "bg-zinc-200 dark:bg-zinc-700",
    text: "text-zinc-500 dark:text-zinc-400",
    badge: "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600/40",
    tint: "bg-zinc-100 text-zinc-800 ring-zinc-500/30 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-500/50",
    stripe: "",
    row: "",
  },
  unscored: {
    label: "Unscored",
    meaning: "Not scored yet: waiting for the LLM read",
    fill: "bg-zinc-200 dark:bg-zinc-700",
    onFill: "text-zinc-800 dark:text-zinc-100",
    track: "bg-zinc-100 dark:bg-zinc-800",
    text: "text-zinc-400 dark:text-zinc-500",
    badge: "border border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400",
    tint: "bg-zinc-100 text-zinc-800 ring-zinc-500/30 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-500/50",
    stripe: "",
    row: "",
  },
};

/** "P0" for "page", …, "Unscored" for anything without a score. */
export function priorityLabel(band: string | null | undefined): string {
  return BAND_STYLES[bandKey(band)].label;
}

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

/** Every flag after the worst one: neutral outline, so a row isn't a rainbow. */
export const FLAG_STYLE_QUIET =
  "bg-transparent text-zinc-600 ring-1 ring-inset ring-zinc-300 dark:text-zinc-300 dark:ring-zinc-600";

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

// --- Queue view helpers ---------------------------------------------------

/** Groups score-ordered items into priority sections, P0 first, empty ones dropped. */
export function groupByPriority<T>(
  items: readonly T[],
  bandOf: (item: T) => string | null | undefined,
): { band: BandKey; items: T[] }[] {
  const groups = new Map<BandKey, T[]>();
  for (const item of items) {
    const key = bandKey(bandOf(item));
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return BAND_ORDER.filter((band) => groups.has(band)).map((band) => ({ band, items: groups.get(band)! }));
}

/**
 * One search box for free text plus two filters: `model:qwen3` (or
 * `model:"Qwen3 235B"`) sets the model filter, and `owner:gau-nernst` /
 * `owner:none` sets the owner filter; the rest is the text query. `owner`
 * is undefined when the text doesn't mention one, so the owner picker's
 * choice is left alone.
 */
export function parseSearchInput(input: string): { q: string | null; model: string | null; owner?: string | null } {
  let model: string | null = null;
  let owner: string | null | undefined;
  let rest = input.replace(/(?:^|\s)model:(?:"([^"]*)"|(\S+))/i, (_, quoted: string | undefined, bare: string | undefined) => {
    model = (quoted ?? bare ?? "").trim() || null;
    return " ";
  });
  rest = rest.replace(/(?:^|\s)owner:@?(\S*)/i, (_, login: string) => {
    const value = login.trim().toLowerCase();
    if (value === "none" || value === "unowned" || value === "nobody") owner = "none";
    else if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) owner = login;
    else if (value === "" || value === "anyone" || value === "any") owner = null;
    return " ";
  });
  const q = rest.replace(/\s+/g, " ").trim();
  const parsed: { q: string | null; model: string | null; owner?: string | null } = { q: q || null, model };
  if (owner !== undefined) parsed.owner = owner;
  return parsed;
}

export function formatSearchInput(q: string | null, model: string | null): string {
  const modelPart = model ? (/\s/.test(model) ? `model:"${model}"` : `model:${model}`) : "";
  return [q ?? "", modelPart].filter(Boolean).join(" ");
}

export interface ContextChip {
  kind: "hardware" | "model" | "area";
  value: string;
}

/**
 * The one compact context line under a title: hardware first (what breaks
 * where), then the model, then the area; at most `max` chips, the rest
 * returned for a "+N" with a tooltip.
 */
export function contextChips(
  item: { hardware: string[]; models: string[]; areas: string[] },
  max = 3,
): { shown: ContextChip[]; hidden: ContextChip[] } {
  const ordered: ContextChip[] = [
    ...item.hardware.slice(0, 2).map((value) => ({ kind: "hardware" as const, value })),
    ...item.models.slice(0, 1).map((value) => ({ kind: "model" as const, value })),
    ...item.areas.slice(0, 1).map((value) => ({ kind: "area" as const, value })),
    ...item.hardware.slice(2).map((value) => ({ kind: "hardware" as const, value })),
    ...item.models.slice(1).map((value) => ({ kind: "model" as const, value })),
    ...item.areas.slice(1).map((value) => ({ kind: "area" as const, value })),
  ];
  return { shown: ordered.slice(0, max), hidden: ordered.slice(max) };
}
