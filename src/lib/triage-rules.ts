import type { TriageFacets, TriagePrepass, TriageRules } from "@/lib/triage-types";
import {
  NOTIFY_MODES,
  TRIAGE_AREAS,
  TRIAGE_HARDWARE,
  TRIAGE_TYPES,
  isOneOf,
  type NotifyMode,
} from "@/lib/triage-vocab";

/**
 * Maintainer rule matching. This mirrors `match_rules` in triage/routing.py
 * exactly; change both together.
 *
 * - areas = facets.areas ∪ prepass.areas; hardware = facets.hardware ∪
 *   prepass.hardware_hints; model names = lowercased facets.models[].name and
 *   .family plus lowercased prepass.model_hints.
 * - Excludes first: facets.type in exclude.types, or any area / hardware in
 *   exclude.areas / exclude.hardware → no match.
 * - `types` is a filter, not a criterion: when non-empty, facets.type must be
 *   listed.
 * - Positive criteria (at least one must hit), reported in this order:
 *   "area:X", "hardware:X", "model:<glob>" (Python fnmatch, case-insensitive,
 *   `*` crosses `/`), "path:<glob>" (fnmatch, case-sensitive, against changed
 *   file paths; also tried as `<glob minus trailing * and />/*`),
 *   "keyword:<kw>" (case-insensitive substring of title + "\n" + summary).
 */

export interface RuleMatchInput {
  title: string;
  facets: TriageFacets | null;
  prepass: TriagePrepass | null;
  files: { path?: string }[];
}

export const EMPTY_RULES: TriageRules = {
  areas: [],
  hardware: [],
  models: [],
  paths: [],
  keywords: [],
  types: [],
  exclude: { types: [], areas: [], hardware: [] },
  natural_language: "",
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Python `fnmatch.translate`: `*` any run (including `/`), `?` one char, `[...]` classes. */
export function fnmatchToRegExp(pattern: string, flags = ""): RegExp {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index++];
    if (char === "*") {
      out += "[\\s\\S]*";
      while (pattern[index] === "*") index++;
    } else if (char === "?") {
      out += "[\\s\\S]";
    } else if (char === "[") {
      let end = index;
      if (pattern[end] === "!") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) {
        out += "\\[";
      } else {
        let body = pattern.slice(index, end).replace(/\\/g, "\\\\");
        index = end + 1;
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        out += `[${body}]`;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^(?:${out})$`, flags);
}

function stripTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return text.slice(0, end);
}

function stringList(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

export function matchRules(
  rules: TriageRules,
  input: RuleMatchInput,
): { matched: string[] } | null {
  const facets = input.facets ?? {};
  const prepass = input.prepass ?? {};
  const areas = new Set([...stringList(facets.areas), ...stringList(prepass.areas)]);
  const hardware = new Set([
    ...stringList(facets.hardware),
    ...stringList(prepass.hardware_hints),
  ]);
  const modelNames = [
    ...(Array.isArray(facets.models) ? facets.models : []).flatMap((model) =>
      [model?.name, model?.family].filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
    ),
    ...stringList(prepass.model_hints).filter((name) => name.length > 0),
  ].map((name) => name.toLowerCase());
  const type = typeof facets.type === "string" ? facets.type : null;
  const haystack = `${input.title}\n${facets.summary ?? ""}`.toLowerCase();

  if (type !== null && rules.exclude.types.includes(type)) return null;
  if (rules.exclude.areas.some((area) => areas.has(area))) return null;
  if (rules.exclude.hardware.some((hw) => hardware.has(hw))) return null;
  if (rules.types.length > 0 && (type === null || !rules.types.includes(type))) return null;

  const matched: string[] = [];
  for (const area of rules.areas) if (areas.has(area)) matched.push(`area:${area}`);
  for (const hw of rules.hardware) if (hardware.has(hw)) matched.push(`hardware:${hw}`);
  for (const pattern of rules.models) {
    const regex = fnmatchToRegExp(pattern.toLowerCase());
    if (modelNames.some((name) => regex.test(name))) matched.push(`model:${pattern}`);
  }
  const paths = input.files
    .map((file) => file?.path)
    .filter((path): path is string => typeof path === "string");
  for (const pattern of rules.paths) {
    const direct = fnmatchToRegExp(pattern);
    const dir = fnmatchToRegExp(`${stripTrailing(stripTrailing(pattern, "*"), "/")}/*`);
    if (paths.some((path) => direct.test(path) || dir.test(path))) matched.push(`path:${pattern}`);
  }
  for (const keyword of rules.keywords) {
    if (haystack.includes(keyword.toLowerCase())) matched.push(`keyword:${keyword}`);
  }
  return matched.length > 0 ? { matched } : null;
}

/** Normalises a stored `rules` jsonb (untrusted shape) into TriageRules. */
export function normalizeRules(raw: unknown): TriageRules {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((entry): entry is string => typeof entry === "string")
      : [];
  const exclude = (value.exclude && typeof value.exclude === "object"
    ? value.exclude
    : {}) as Record<string, unknown>;
  return {
    areas: strings(value.areas),
    hardware: strings(value.hardware),
    models: strings(value.models),
    paths: strings(value.paths),
    keywords: strings(value.keywords),
    types: strings(value.types),
    exclude: {
      types: strings(exclude.types),
      areas: strings(exclude.areas),
      hardware: strings(exclude.hardware),
    },
    natural_language:
      typeof value.natural_language === "string" ? value.natural_language : "",
  };
}

export interface MaintainerSettingsInput {
  rules: TriageRules;
  minScore: number;
  capacityPerWeek: number;
  away: { start: string; end: string }[];
  notifyMode: NotifyMode;
  slackUserId: string | null;
}

const MAX_LIST = 50;
const MAX_TEXT = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a rules draft (the preview body). Returns an error message or the settings. */
export function validateMaintainerSettings(
  body: unknown,
): { ok: true; value: MaintainerSettingsInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };
  const input = body as Record<string, unknown>;
  const rulesInput = (input.rules ?? {}) as Record<string, unknown>;
  if (typeof rulesInput !== "object") return { ok: false, error: "rules must be an object." };

  const list = (
    name: string,
    raw: unknown,
    allowed?: readonly string[],
  ): string[] | string => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return `${name} must be a list.`;
    if (raw.length > MAX_LIST) return `${name} has more than ${MAX_LIST} entries.`;
    const out: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") return `${name} entries must be strings.`;
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_TEXT) return `${name} entries must be at most ${MAX_TEXT} characters.`;
      if (allowed && !allowed.includes(trimmed)) return `${name}: unknown value "${trimmed}".`;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  };

  const excludeInput = (rulesInput.exclude ?? {}) as Record<string, unknown>;
  const fields = {
    areas: list("areas", rulesInput.areas, TRIAGE_AREAS),
    hardware: list("hardware", rulesInput.hardware, TRIAGE_HARDWARE),
    models: list("models", rulesInput.models),
    paths: list("paths", rulesInput.paths),
    keywords: list("keywords", rulesInput.keywords),
    types: list("types", rulesInput.types, TRIAGE_TYPES),
    excludeTypes: list("exclude.types", excludeInput.types, TRIAGE_TYPES),
    excludeAreas: list("exclude.areas", excludeInput.areas, TRIAGE_AREAS),
    excludeHardware: list("exclude.hardware", excludeInput.hardware, TRIAGE_HARDWARE),
  };
  for (const value of Object.values(fields)) {
    if (typeof value === "string") return { ok: false, error: value };
  }
  const naturalLanguage = rulesInput.natural_language ?? "";
  if (typeof naturalLanguage !== "string" || naturalLanguage.length > 1000) {
    return { ok: false, error: "natural_language must be text of at most 1000 characters." };
  }

  const minScore = input.minScore ?? 40;
  if (typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 0 || minScore > 1000) {
    return { ok: false, error: "minScore must be an integer between 0 and 1000." };
  }
  const capacity = input.capacityPerWeek ?? 10;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 0 || capacity > 200) {
    return { ok: false, error: "capacityPerWeek must be an integer between 0 and 200." };
  }
  const notifyMode = input.notifyMode ?? "digest";
  if (!isOneOf(NOTIFY_MODES, notifyMode)) {
    return { ok: false, error: "notifyMode must be immediate, digest or off." };
  }
  const slack = input.slackUserId ?? null;
  if (slack !== null && (typeof slack !== "string" || (slack !== "" && !/^[UW][A-Z0-9]{2,20}$/.test(slack)))) {
    return { ok: false, error: "slackUserId must look like U0123ABCD." };
  }
  const awayInput = input.away ?? [];
  if (!Array.isArray(awayInput) || awayInput.length > 20) {
    return { ok: false, error: "away must be a list of at most 20 ranges." };
  }
  const away: { start: string; end: string }[] = [];
  for (const range of awayInput) {
    const { start, end } = (range ?? {}) as { start?: unknown; end?: unknown };
    if (typeof start !== "string" || typeof end !== "string" || !DATE.test(start) || !DATE.test(end)) {
      return { ok: false, error: "away ranges need start and end dates as YYYY-MM-DD." };
    }
    if (end < start) return { ok: false, error: "away range ends before it starts." };
    away.push({ start, end });
  }

  return {
    ok: true,
    value: {
      rules: {
        areas: fields.areas as string[],
        hardware: fields.hardware as string[],
        models: fields.models as string[],
        paths: fields.paths as string[],
        keywords: fields.keywords as string[],
        types: fields.types as string[],
        exclude: {
          types: fields.excludeTypes as string[],
          areas: fields.excludeAreas as string[],
          hardware: fields.excludeHardware as string[],
        },
        natural_language: naturalLanguage.trim(),
      },
      minScore,
      capacityPerWeek: capacity,
      away,
      notifyMode,
      slackUserId: slack === "" ? null : (slack as string | null),
    },
  };
}

/**
 * Maintainer rules are owned by one repo file per maintainer,
 * triage/config/maintainers/<github_login>.yaml, changed by pull request.
 */
export const RULES_DIR_PATH = "triage/config/maintainers";
const REPO_URL = "https://github.com/vllm-project/vllm-dashboard";
export const RULES_DIR_URL = `${REPO_URL}/tree/main/${RULES_DIR_PATH}`;

export function maintainerFilePath(login: string): string {
  return `${RULES_DIR_PATH}/${login}.yaml`;
}

/** GitHub's editor for an existing rules file on main. */
export function maintainerFileEditUrl(login: string): string {
  return `${REPO_URL}/edit/main/${RULES_DIR_PATH}/${encodeURIComponent(login)}.yaml`;
}

/** GitHub's new-file page on main, pre-filled with the file name and content. */
export function maintainerFileCreateUrl(login: string, content: string): string {
  return `${REPO_URL}/new/main/${RULES_DIR_PATH}?filename=${encodeURIComponent(
    `${login}.yaml`,
  )}&value=${encodeURIComponent(content)}`;
}

// A bare YAML scalar is safe when it is plain word characters and would not be
// read back as a bool, null or number.
const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_.\/-]*$/;
const YAML_KEYWORDS = /^(?:true|false|yes|no|on|off|null|y|n|~)$/i;

function plainOrQuoted(value: string): string {
  return PLAIN_SCALAR.test(value) && !YAML_KEYWORDS.test(value) ? value : quoted(value);
}

/** Double-quoted YAML scalar; JSON string escapes are valid YAML. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

function flowList(values: readonly string[], render: (value: string) => string): string {
  return `[${values.map(render).join(", ")}]`;
}

/**
 * The content of triage/config/maintainers/<login>.yaml: one top-level
 * mapping. Key order is fixed; empty lists and optional keys are omitted
 * (github_login always appears). Enum values (areas, hardware, types,
 * notify_mode) are plain; models, paths, keywords and natural_language are
 * always double-quoted.
 */
export function maintainerFileYaml(login: string, settings: MaintainerSettingsInput): string {
  const lines = [`github_login: ${plainOrQuoted(login)}`];
  if (settings.slackUserId) lines.push(`slack_user_id: ${plainOrQuoted(settings.slackUserId)}`);
  lines.push(`min_score: ${settings.minScore}`);
  lines.push(`capacity_per_week: ${settings.capacityPerWeek}`);
  lines.push(`notify_mode: ${settings.notifyMode}`);
  if (settings.away.length > 0) {
    lines.push("away:");
    for (const range of settings.away) {
      lines.push(`  - {start: ${range.start}, end: ${range.end}}`);
    }
  }

  const { rules } = settings;
  const ruleLines: string[] = [];
  const list = (key: string, values: readonly string[], render: (value: string) => string) => {
    if (values.length > 0) ruleLines.push(`  ${key}: ${flowList(values, render)}`);
  };
  list("areas", rules.areas, plainOrQuoted);
  list("hardware", rules.hardware, plainOrQuoted);
  list("models", rules.models, quoted);
  list("paths", rules.paths, quoted);
  list("keywords", rules.keywords, quoted);
  list("types", rules.types, plainOrQuoted);
  const exclude = (
    [
      ["types", rules.exclude.types],
      ["areas", rules.exclude.areas],
      ["hardware", rules.exclude.hardware],
    ] as const
  ).filter(([, values]) => values.length > 0);
  if (exclude.length > 0) {
    ruleLines.push(
      `  exclude: {${exclude
        .map(([key, values]) => `${key}: ${flowList(values, plainOrQuoted)}`)
        .join(", ")}}`,
    );
  }
  if (rules.natural_language) {
    ruleLines.push(`  natural_language: ${quoted(rules.natural_language)}`);
  }
  if (ruleLines.length > 0) lines.push("rules:", ...ruleLines);
  return `${lines.join("\n")}\n`;
}
