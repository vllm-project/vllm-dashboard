/**
 * Score factors in plain words. triage/scoring.py emits factor codes
 * ("severity.serving_broken", "popularity.model.tier1", …) with a terse
 * detail; this module is the one place that turns them into language a
 * maintainer reads, and assigns each a category the breakdown colors by.
 */

export type FactorCategory =
  | "severity"
  | "reach"
  | "recency"
  | "evidence"
  | "community"
  | "pr"
  | "penalty"
  | "floor"
  | "other";

export interface FactorText {
  category: FactorCategory;
  title: string;
  detail: string | null;
}

export const FACTOR_CATEGORIES: Record<FactorCategory, { label: string; meaning: string }> = {
  severity: { label: "How bad", meaning: "The symptom and the kind of problem" },
  reach: { label: "Who it hits", meaning: "How popular the model and GPU are" },
  recency: { label: "Release", meaning: "Whether it affects the latest release or main" },
  evidence: { label: "Evidence", meaning: "Reproduction steps and how sure the LLM was" },
  community: { label: "Community", meaning: "Reactions and comments" },
  pr: { label: "PR signals", meaning: "What a pull request fixes and how it is put together" },
  penalty: { label: "Penalty", meaning: "Points taken away" },
  floor: { label: "Floor", meaning: "Scores never go below 0" },
  other: { label: "Other", meaning: "A factor this page doesn't know yet" },
};

const SEVERITY_TITLES: Record<string, string> = {
  serving_broken: "Serving is broken",
  wrong_output: "Wrong output",
  crash: "Crashes",
  hang: "Hangs",
  security: "Security problem",
  memory_regression: "Uses more memory than before",
  perf_regression: "Speed regression",
};

const TYPE_TITLES: Record<string, string> = {
  regression: "Regression: it used to work",
  perf_regression: "Speed regression",
  bug: "Bug",
  ci: "CI problem",
  performance: "Performance",
  feature: "Feature request",
  spam: "Spam",
  question: "Question",
  usage: "Usage question",
  docs: "Docs",
  refactor: "Refactor",
  other: "Other",
};

const MODEL_TIER_WORDS: Record<string, string> = {
  tier1: "popular model",
  tier2: "common model",
  other: "niche model",
  unknown: "model unknown",
};
const HARDWARE_TIER_WORDS: Record<string, string> = {
  cpu: "CPU backend",
  tier1: "top-tier GPU",
  tier2: "common hardware",
  other: "niche hardware",
  unknown: "hardware unknown",
};
const CONFIG_WORDS: Record<string, string> = {
  default: "default settings",
  exotic: "unusual settings",
  unknown: "settings unclear",
};

const PR_SIZES: Record<string, string> = {
  xs: "Tiny change",
  s: "Small change",
  m: "Medium-sized change",
  l: "Large change",
  xl: "Very large change",
};

const SLOP_SIGNALS: Record<string, string> = {
  generic_ai_description: "generic AI-written description",
  unrelated_changes: "unrelated changes",
  no_testing: "no testing",
  empty_test_plan: "empty test plan",
  duplicate: "duplicate",
  boilerplate: "boilerplate",
};

/** "generic_ai_description" → "generic AI-written description"; unknown tags get spaces. */
export function humanizeTag(tag: string): string {
  const key = tag.trim();
  return SLOP_SIGNALS[key] ?? key.replace(/[_-]+/g, " ").replace(/\bai\b/gi, "AI").trim();
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * "25% slower; 50 base; model tier1 x1; hw tier1 x1; config default x1.15; pr x0.5"
 * → { slower: "25% slower", base: 50, multiplier: 0.575, words: [...] }.
 */
export function parseSeverityDetail(detail: string | null | undefined): {
  slower: string | null;
  base: number | null;
  multiplier: number;
  words: string[];
} {
  let slower: string | null = null;
  let base: number | null = null;
  let multiplier = 1;
  const words: string[] = [];
  for (const raw of (detail ?? "").split(";")) {
    const part = raw.trim();
    if (!part) continue;
    let match: RegExpMatchArray | null;
    if ((match = part.match(/^([\d.]+)% slower$/))) {
      slower = `${trimNumber(Number(match[1]))}% slower`;
    } else if ((match = part.match(/^([\d.]+) base$/))) {
      base = Number(match[1]);
    } else if ((match = part.match(/^(model|hw|config) (\w+) x([\d.]+)$/))) {
      multiplier *= Number(match[3]);
      const table = match[1] === "model" ? MODEL_TIER_WORDS : match[1] === "hw" ? HARDWARE_TIER_WORDS : CONFIG_WORDS;
      words.push(table[match[2]] ?? `${match[1]} ${match[2]}`);
    } else if ((match = part.match(/^pr x([\d.]+)$/))) {
      const fraction = Number(match[1]);
      multiplier *= fraction;
      words.push(fraction === 0.5 ? "half weight for a PR" : `×${trimNumber(fraction)} for a PR`);
    }
  }
  return { slower, base, multiplier, words };
}

function severityText(flag: string, detail: string | null | undefined): FactorText {
  const parsed = parseSeverityDetail(detail);
  let title = SEVERITY_TITLES[flag] ?? cleanCode(flag);
  if (parsed.slower) title = `${title} (${parsed.slower})`;
  let text: string | null = null;
  if (parsed.base !== null) {
    const multiplier = Math.abs(parsed.multiplier - 1) < 1e-9 ? null : trimNumber(parsed.multiplier);
    if (flag === "security") {
      text = `${trimNumber(parsed.base)} pts, not scaled by model or GPU`;
    } else {
      text = `${trimNumber(parsed.base)} pts${multiplier ? ` × ${multiplier}` : ""}${parsed.words.length ? ` (${parsed.words.join(", ")})` : ""}`;
    }
  }
  return { category: "severity", title, detail: text };
}

/** Last-resort wording for a code this module doesn't know. */
export function cleanCode(code: string): string {
  const words = code.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown factor";
}

/** Plain words and a category for one breakdown row. */
export function describeFactor(factor: string, detail?: string | null, points = 0): FactorText {
  const negative = points < 0;
  const [head, ...rest] = factor.split(".");
  const tail = rest.join(".");
  const out = (category: FactorCategory, title: string, text: string | null = detail ?? null): FactorText => ({
    category: negative && category !== "floor" ? "penalty" : category,
    title,
    detail: text,
  });

  switch (head) {
    case "severity":
      return { ...severityText(tail, detail), ...(negative ? { category: "penalty" as const } : {}) };
    case "type":
      return out("severity", TYPE_TITLES[tail] ?? cleanCode(tail), null);
    case "popularity": {
      const [what, tier] = rest;
      if (what === "model") {
        const label = tier === "tier1" ? "Popular model (top tier)" : tier === "tier2" ? "Common model" : "Niche model";
        return out("reach", detail ? `${label}: ${detail}` : label, null);
      }
      if (what === "hardware") {
        const label = tier === "tier1" ? "Top-tier GPU" : tier === "tier2" ? "Common hardware" : "Niche hardware";
        return out("reach", detail ? `${label}: ${detail}` : label, null);
      }
      return out("reach", cleanCode(factor));
    }
    case "recency":
      if (tail === "affects_latest_release") {
        return out("recency", detail ? `Affects the latest release (${detail})` : "Affects the latest release", null);
      }
      if (tail === "affects_main") return out("recency", "Affects main (nightly)", null);
      return out("recency", cleanCode(factor));
    case "evidence":
      if (tail === "has_repro") return out("evidence", "Has steps to reproduce", null);
      if (tail === "low_confidence") return out("evidence", "The LLM wasn't sure about this read", null);
      return out("evidence", cleanCode(factor));
    case "social":
      return out("community", detail ? `Community interest: ${detail}` : "Community interest", null);
    case "pr": {
      if (tail === "fixes_issue") {
        const match = detail?.match(/^#(\d+) scored (\d+)$/);
        return out("pr", match ? `Fixes #${match[1]}, an issue that scored ${match[2]}` : "Fixes a scored issue", match ? null : detail ?? null);
      }
      if (tail === "hot_path") return out("pr", "Touches code on every request", null);
      if (tail === "has_tests") return out("pr", "Includes tests", null);
      if (tail === "low_effort") return out("pr", "Looks low-effort", null);
      if (tail === "draft") return out("pr", "Draft PR", null);
      if (rest[0] === "size") return out("pr", PR_SIZES[rest[1]] ?? "Change size", null);
      return out("pr", cleanCode(factor));
    }
    case "policy":
      return out("penalty", "Below P0: incident criteria not met");
    case "slop": {
      const tags = (detail ?? "").split(",").map((tag) => tag.trim()).filter(Boolean).map(humanizeTag);
      return out("penalty", tags.length ? `Low-quality signals: ${tags.join(", ")}` : "Low-quality signals", null);
    }
    case "floor":
      return { category: "floor", title: "Score can't go below 0", detail: null };
    case "pending_extraction":
      return out("evidence", "Waiting for the LLM to read it", null);
    default:
      return out("other", cleanCode(factor));
  }
}
