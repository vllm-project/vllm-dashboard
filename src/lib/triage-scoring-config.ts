/**
 * The scoring numbers the "Scoring guidelines" page shows, mirrored from
 * triage/config/scoring.yaml and triage/config/tiers.yaml (the router's
 * source of truth). triage-scoring-config.test.ts loads both YAML files and
 * fails if anything here drifts, so update this file in the same PR as any
 * change to them.
 */

export const SCORING = {
  version: "2026-11-20.1",
  scope: { max_age_days: 30 },
  thresholds: { page: 70, route: 40, watch: 20 },
  p0: {
    min_confidence: 0.7,
    symptoms: ["serving_broken", "wrong_output", "security"],
    shared_areas: ["frontend_api", "tokenizer"],
    cpu_hardware: ["CPU_x86", "CPU_arm", "Apple"],
  },
  severity: {
    serving_broken: 50,
    security: 50,
    wrong_output: 42,
    crash: 36,
    hang: 32,
    memory_regression: 18,
    perf_regression_per_10pct: 9,
    perf_regression_cap: 40,
    pr_fraction: 0.5,
    defect_types: ["bug", "regression", "perf_regression", "performance", "ci"],
  },
  reach: {
    model: { tier1: 1.0, tier2: 0.8, other: 0.6, unknown: 0.75 },
    hardware: { tier1: 1.0, tier2: 0.8, cpu: 0.35, other: 0.55, unknown: 0.85 },
    config: { default: 1.15, exotic: 0.55, unknown: 0.9 },
  },
  type: { regression: 12, perf_regression: 10, bug: 3, ci: 4, performance: 0, feature: 0, spam: -100 },
  popularity: {
    model: { tier1: 6, tier2: 3, other: 0 },
    hardware: { tier1: 3, tier2: 1, cpu: 0, other: 0 },
  },
  recency: { affects_latest_release: 10, affects_main: 4 },
  evidence: { has_repro: 4, low_confidence: -6 },
  social: { per_reaction: 0.5, per_comment: 0.4, cap: 15 },
  pr: {
    fixes_issue_fraction: 1.0,
    hot_path: 0,
    has_tests: 0,
    low_effort: -25,
    draft: -15,
    size: { xs: 0, s: 0, m: 0, l: -2, xl: -4 },
  },
  slop: { per_signal: -10, cap: -40 },
} as const;

export const TIERS = {
  version: "2026-11-12.1",
  models: {
    tier1: [
      "deepseek*", "qwen3*", "qwen2.5*", "llama-3*", "llama-4*", "llama3*", "llama4*", "gpt-oss*", "kimi*",
      "glm-4.5*", "glm-4.6*", "glm-5*", "glm4.5*", "glm5*", "gemma-3*", "gemma-4*", "gemma3*", "gemma4*",
      "mistral*", "mixtral*", "minimax*",
    ],
    tier2: [
      "phi*", "granite*", "command*", "cohere*", "internvl*", "nemotron*", "olmo*", "ernie*", "hunyuan*",
      "llava*", "pixtral*", "whisper*", "bge*", "e5*", "jamba*", "falcon*", "step*", "seed*",
    ],
  },
  hardware: {
    tier1: ["H100", "H200", "B200", "B300", "GB200", "GB300", "MI300X", "MI355X"],
    tier2: ["A100", "MI325X", "TPU", "L40S", "CPU_x86", "CPU_arm", "Gaudi", "XPU"],
  },
} as const;

type ModelTier = keyof typeof SCORING.reach.model;
type HardwareTier = keyof typeof SCORING.reach.hardware;
type ConfigKey = keyof typeof SCORING.reach.config;
type SeverityFlag = "serving_broken" | "wrong_output" | "crash" | "hang" | "security" | "memory_regression";

/**
 * Python's round(): an exact half goes to the even neighbour (2.5 → 2,
 * 3.5 → 4). "Exact" matters: 50 × 1.15 is 57.49999999999999 in floating
 * point in both languages, so it rounds to 57, as the router does.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

function fmt(value: number): string {
  // Python's `:g` for the small numbers used here.
  return String(Number(value.toPrecision(6)));
}

export interface ExampleFactor {
  factor: string;
  points: number;
  detail?: string;
}

export interface ExampleInput {
  kind?: "issue" | "pr";
  type: keyof typeof SCORING.type;
  severity?: SeverityFlag;
  modelTier: Exclude<ModelTier, "unknown"> | null;
  model?: string;
  hardwareTier: Exclude<HardwareTier, "unknown"> | null;
  hardware?: string;
  config: ConfigKey;
  latestRelease?: string;
  affectsMain?: boolean;
  hasRepro?: boolean;
  confidence?: number;
  areas?: string[];
  reactions?: number;
  comments?: number;
}

/**
 * The same arithmetic as triage/scoring.py for the inputs the guide's worked
 * examples use (one severity flag, tiers given directly; `modelTier: null`
 * means no model is named). It is for explaining, not scoring: the router's
 * Python is what scores real items.
 */
export function scoreExample(input: ExampleInput): { score: number; band: "page" | "route" | "watch" | "ignore"; factors: ExampleFactor[] } {
  const factors: ExampleFactor[] = [];
  const add = (factor: string, points: number, detail?: string) => {
    const rounded = roundHalfEven(points);
    if (rounded) factors.push({ factor, points: rounded, ...(detail ? { detail } : {}) });
  };
  const kind = input.kind ?? "issue";
  // Like scoring.py: "other" is a named model outside the tier lists, and
  // no model named at all (null) is "unknown".
  const modelKey: ModelTier = input.modelTier ?? "unknown";
  const isDefect = (SCORING.severity.defect_types as readonly string[]).includes(input.type);
  if (input.severity && (kind === "pr" || isDefect)) {
    const base = SCORING.severity[input.severity];
    const hwKey: HardwareTier = input.hardwareTier ?? "unknown";
    let multiplier =
      input.severity === "security"
        ? 1
        : SCORING.reach.model[modelKey] * SCORING.reach.hardware[hwKey] * SCORING.reach.config[input.config];
    const parts =
      input.severity === "security"
        ? []
        : [
            `model ${modelKey} x${fmt(SCORING.reach.model[modelKey])}`,
            `hw ${hwKey} x${fmt(SCORING.reach.hardware[hwKey])}`,
            `config ${input.config} x${fmt(SCORING.reach.config[input.config])}`,
          ];
    if (kind === "pr") {
      multiplier *= SCORING.severity.pr_fraction;
      parts.push(`pr x${fmt(SCORING.severity.pr_fraction)}`);
    }
    add(`severity.${input.severity}`, base * multiplier, [`${fmt(base)} base`, ...parts].join("; "));
  }
  add(`type.${input.type}`, SCORING.type[input.type]);
  if (input.modelTier) {
    add(`popularity.model.${input.modelTier}`, SCORING.popularity.model[input.modelTier], input.model);
  }
  if (input.hardwareTier) {
    add(`popularity.hardware.${input.hardwareTier}`, SCORING.popularity.hardware[input.hardwareTier], input.hardware);
  }
  if (input.latestRelease) {
    add("recency.affects_latest_release", SCORING.recency.affects_latest_release, input.latestRelease);
  } else if (input.affectsMain) {
    add("recency.affects_main", SCORING.recency.affects_main);
  }
  if (input.hasRepro) add("evidence.has_repro", SCORING.evidence.has_repro);
  const reactions = input.reactions ?? 0;
  const comments = input.comments ?? 0;
  const social = reactions * SCORING.social.per_reaction + comments * SCORING.social.per_comment;
  if (social >= 1) add("social", Math.min(SCORING.social.cap, social), `${reactions} reactions, ${comments} comments`);

  // Mirror the incident gate used by Python; these examples have no linked issue.
  let reason: string | null = null;
  if (!isDefect) reason = "P0 requires a defect, not a feature or question";
  else if ((input.confidence ?? 0.8) < SCORING.p0.min_confidence || !input.hasRepro)
    reason = "P0 requires a reproduction and confident evidence";
  else if (!(SCORING.p0.symptoms as readonly string[]).includes(input.severity ?? ""))
    reason = "P0 requires serving failure, wrong output, or a security defect";
  else if (!input.latestRelease && !input.affectsMain)
    reason = "P0 requires evidence that main or the latest release is affected";
  else if (input.severity !== "security") {
    if (input.hardwareTier === "cpu") reason = "CPU-backend-only defects are P1/P2 by default";
    else if (input.config !== "default") reason = "P0 requires impact on a default serving configuration";
    else if (!(input.areas ?? []).some((a) => (SCORING.p0.shared_areas as readonly string[]).includes(a)) &&
        (input.modelTier !== "tier1" || input.hardwareTier !== "tier1"))
      reason = "P0 requires a primary model/GPU serving path or a shared API/tokenizer defect";
  }
  const beforeCap = factors.reduce((sum, f) => sum + f.points, 0);
  if (reason && beforeCap >= SCORING.thresholds.page)
    add("policy.p0_cap", SCORING.thresholds.page - 1 - beforeCap, reason);
  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  if (raw < 0) factors.push({ factor: "floor", points: -raw });
  const score = Math.max(0, raw);
  const { page, route, watch } = SCORING.thresholds;
  const band = score >= page ? "page" : score >= route ? "route" : score >= watch ? "watch" : "ignore";
  return { score, band, factors };
}

/** The guide's main example: a serving outage on a popular setup. */
export const WORKED_EXAMPLE: ExampleInput = {
  type: "bug",
  severity: "serving_broken",
  modelTier: "tier1",
  model: "deepseek-v3",
  hardwareTier: "tier1",
  hardware: "H100",
  config: "default",
  latestRelease: "0.27.1",
  hasRepro: true,
};

/** The contrast example: the same symptom on a niche setup with unusual flags. */
export const NICHE_EXAMPLE: ExampleInput = {
  type: "bug",
  severity: "serving_broken",
  modelTier: "other",
  model: "my-finetune-7b",
  hardwareTier: "other",
  hardware: "RTX",
  config: "exotic",
};
