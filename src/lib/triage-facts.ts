import { PR_SIZE_WORDS } from "./triage-rows";
import { humanizeTag } from "@/lib/triage-factors";
import { typeLabel, type ChipKind } from "@/lib/triage-style";
import type { TriageFacets } from "@/lib/triage-types";
import { yesNo } from "@/lib/triage-words";

/**
 * "What the LLM read" in the item drawer: one row per fact Claude pulled out
 * of the item. `present` marks a positive / non-empty fact (a crash, a model
 * name, a slowdown); the drawer shows only those by default, and every row
 * (with its "no" / "none" / "not stated") behind "Show all fields".
 */
export interface LlmFact {
  key: string;
  label: string;
  present: boolean;
  /** Plain text value. */
  text?: string;
  /** The value with its negatives too ("no tests"), for "Show all fields". */
  fullText?: string;
  /** Or chips (models, hardware, …). */
  chips?: { kind: ChipKind; values: string[] };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function chipsFact(key: string, label: string, kind: ChipKind, values: string[]): LlmFact {
  return { key, label, present: values.length > 0, chips: { kind, values } };
}

function flagFact(key: string, label: string, value: boolean | null | undefined): LlmFact {
  return { key, label, present: value === true, text: yesNo(value) };
}

export function llmFacts(facets: TriageFacets | null | undefined): LlmFact[] {
  const f = facets ?? {};
  const severity = f.severity ?? {};
  const versions = f.versions ?? {};
  const facts: LlmFact[] = [
    { key: "type", label: "Kind of item", present: !!f.type, text: f.type ? typeLabel(f.type) : "—" },
    chipsFact(
      "models",
      "Models",
      "model",
      (Array.isArray(f.models) ? f.models : []).map((model) => model?.name ?? "").filter(Boolean),
    ),
    chipsFact("model_traits", "Model traits", "plain", strings(f.model_traits).map(humanizeTag)),
    chipsFact("hardware", "Hardware", "hardware", strings(f.hardware)),
    chipsFact("serving", "Serving setup", "serving", strings(f.serving).map(humanizeTag)),
    chipsFact("areas", "Code areas", "area", strings(f.areas).map(humanizeTag)),
    flagFact("serving_broken", "Serving is broken", severity.serving_broken),
    flagFact("crash", "Crashes", severity.crash),
    flagFact("hang", "Hangs", severity.hang),
    flagFact("wrong_output", "Wrong output", severity.wrong_output),
    {
      key: "perf_regression_pct",
      label: "Slowdown",
      present: typeof severity.perf_regression_pct === "number",
      text:
        typeof severity.perf_regression_pct === "number"
          ? `${Math.abs(severity.perf_regression_pct)}% slower`
          : "none reported",
    },
    flagFact("memory_regression", "Uses more memory", severity.memory_regression),
    flagFact("security", "Security problem", severity.security),
    flagFact("default_config", "With default settings", f.default_config),
  ];

  const versionParts = [
    versions.good || versions.bad ? `worked in ${versions.good ?? "?"}, broken in ${versions.bad ?? "?"}` : null,
    versions.affects_main === true ? "affects main" : null,
    versions.affects_latest_release === true ? "affects the latest release" : null,
  ].filter((part): part is string => part !== null);
  facts.push({
    key: "versions",
    label: "Versions",
    present: versionParts.length > 0,
    text: versionParts.length
      ? versionParts.join(" · ")
      : `not stated · main: ${yesNo(versions.affects_main)} · latest release: ${yesNo(versions.affects_latest_release)}`,
  });
  facts.push(flagFact("has_repro", "Steps to reproduce", f.has_repro));

  if (f.pr) {
    const fixes = (Array.isArray(f.pr.fixes_issues) ? f.pr.fixes_issues : []).filter((n) => Number.isInteger(n));
    const positive = [
      fixes.length ? `fixes ${fixes.map((n) => `#${n}`).join(", ")}` : null,
      f.pr.size ? (PR_SIZE_WORDS[f.pr.size.toUpperCase()] ?? `${f.pr.size.toUpperCase()} size`) : null,
      f.pr.hot_path ? "touches code on every request" : null,
      f.pr.has_tests ? "has tests" : null,
      f.pr.low_effort ? "looks low-effort" : null,
    ].filter((part): part is string => part !== null);
    const all = [
      fixes.length ? `fixes ${fixes.map((n) => `#${n}`).join(", ")}` : "no linked issue",
      f.pr.size ? (PR_SIZE_WORDS[f.pr.size.toUpperCase()] ?? `${f.pr.size.toUpperCase()} size`) : null,
      f.pr.hot_path ? "touches code on every request" : null,
      f.pr.has_tests ? "has tests" : "no tests",
      f.pr.low_effort ? "looks low-effort" : null,
    ].filter((part): part is string => part !== null);
    facts.push({
      key: "pr",
      label: "About the PR",
      present: positive.length > 0,
      text: positive.length > 0 ? positive.join(" · ") : all.join(" · "),
      fullText: all.join(" · "),
    });
  }

  const slop = strings(f.slop_signals).map(humanizeTag);
  facts.push({ key: "slop_signals", label: "Low-quality signals", present: slop.length > 0, text: slop.length ? slop.join(", ") : "none" });
  const notes = typeof f.notes === "string" ? f.notes.trim() : "";
  facts.push({ key: "notes", label: "LLM notes", present: notes.length > 0, text: notes || "—" });
  return facts;
}

/** The facts to render: the present ones, or every row when `showAll`. */
export function visibleFacts(facts: readonly LlmFact[], showAll: boolean): LlmFact[] {
  return showAll ? [...facts] : facts.filter((fact) => fact.present);
}
