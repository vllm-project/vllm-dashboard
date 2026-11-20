"use client";

import { useState } from "react";
import useSWR from "swr";
import { MultiSelect } from "@/components/multi-select";
import { BandBadge, GithubLink, KindIcon } from "@/components/triage/badges";
import { bandStyle } from "@/lib/triage-style";
import { sendJson, triageFetcher } from "@/lib/triage-format";
import {
  maintainerFileCreateUrl,
  maintainerFileEditUrl,
  maintainerFilePath,
  maintainerFileYaml,
  isValidTimeZone,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_MAX_NOTIFICATIONS_PER_DAY,
  MAX_NOTIFICATIONS_PER_DAY_LIMIT,
  validateMaintainerSettings,
} from "@/lib/triage-rules";
import type { TriageMaintainer, TriageRules } from "@/lib/triage-types";
import {
  NOTIFY_MODES,
  TRIAGE_AREAS,
  TRIAGE_HARDWARE,
  TRIAGE_TYPES,
  type NotifyMode,
} from "@/lib/triage-vocab";

interface RulesResponse {
  exists: boolean;
  maintainer: TriageMaintainer;
}

interface PreviewResponse {
  scanned: number;
  matches: {
    itemKey: string;
    title: string;
    htmlUrl: string;
    kind: "issue" | "pr";
    score: number | null;
    band: string | null;
    matched: string[];
    meetsMinScore: boolean;
  }[];
}

const INPUT =
  "min-h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

function splitLines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-zinc-500">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

/** IANA zones the browser knows, for the timezone select (empty when Intl can't list them). */
function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", ...zones]);
  if (current) all.add(current);
  return [...all].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

interface FormState {
  areas: Set<string>;
  hardware: Set<string>;
  types: Set<string>;
  excludeTypes: Set<string>;
  excludeAreas: Set<string>;
  excludeHardware: Set<string>;
  models: string;
  paths: string;
  keywords: string;
  naturalLanguage: string;
  /** "" = not set (UTC). */
  timezone: string;
  /** "" = not set (09:00). */
  digestHour: string;
  /** "" = not set (5). */
  maxNotifications: string;
  keep: Pick<TriageRules, "language">;
  minScore: number;
  capacityPerWeek: number;
  notifyMode: NotifyMode;
  slackUserId: string;
  away: { start: string; end: string }[];
}

function toForm(maintainer: TriageMaintainer): FormState {
  return {
    areas: new Set(maintainer.rules.areas),
    hardware: new Set(maintainer.rules.hardware),
    types: new Set(maintainer.rules.types),
    excludeTypes: new Set(maintainer.rules.exclude.types),
    excludeAreas: new Set(maintainer.rules.exclude.areas),
    excludeHardware: new Set(maintainer.rules.exclude.hardware),
    models: maintainer.rules.models.join("\n"),
    paths: maintainer.rules.paths.join("\n"),
    keywords: maintainer.rules.keywords.join("\n"),
    naturalLanguage: maintainer.rules.natural_language,
    timezone: maintainer.rules.timezone ?? "",
    digestHour: maintainer.rules.digest_hour !== undefined ? String(maintainer.rules.digest_hour) : "",
    maxNotifications:
      maintainer.rules.max_notifications_per_day !== undefined ? String(maintainer.rules.max_notifications_per_day) : "",
    // Not editable here, but must survive a save (e.g. language: vi).
    keep: maintainer.rules.language ? { language: maintainer.rules.language } : {},
    minScore: maintainer.minScore,
    capacityPerWeek: maintainer.capacityPerWeek,
    notifyMode: maintainer.notifyMode,
    slackUserId: maintainer.slackUserId ?? "",
    away: maintainer.away,
  };
}

function toBody(form: FormState) {
  return {
    rules: {
      areas: [...form.areas],
      hardware: [...form.hardware],
      models: splitLines(form.models),
      paths: splitLines(form.paths),
      keywords: splitLines(form.keywords),
      types: [...form.types],
      exclude: {
        types: [...form.excludeTypes],
        areas: [...form.excludeAreas],
        hardware: [...form.excludeHardware],
      },
      natural_language: form.naturalLanguage,
      ...form.keep,
      ...(form.timezone ? { timezone: form.timezone } : {}),
      ...(form.digestHour !== "" ? { digest_hour: Number(form.digestHour) } : {}),
      ...(form.maxNotifications.trim() !== "" ? { max_notifications_per_day: Number(form.maxNotifications) } : {}),
    },
    minScore: form.minScore,
    capacityPerWeek: form.capacityPerWeek,
    notifyMode: form.notifyMode,
    slackUserId: form.slackUserId.trim() || null,
    away: form.away.filter((range) => range.start && range.end),
  };
}

/** How many explicit rules the draft sets, for the collapsed Advanced summary. */
function explicitRuleCount(form: FormState): number {
  return (
    form.areas.size +
    form.hardware.size +
    form.types.size +
    form.excludeTypes.size +
    form.excludeAreas.size +
    form.excludeHardware.size +
    splitLines(form.models).length +
    splitLines(form.paths).length +
    splitLines(form.keywords).length
  );
}

export default function RulesContent() {
  const { data, error } = useSWR<RulesResponse>("/api/triage/rules", triageFetcher, {
    revalidateOnFocus: false,
  });
  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-zinc-400">Loading…</p>;
  return <RulesDraft key={data.maintainer.githubLogin} data={data} />;
}

/**
 * Rules are read-only here: they live in triage/config/maintainers/<login>.yaml and
 * change by pull request. This page loads the current (synced) rules into a
 * local draft, previews the draft against recent items, and hands the draft
 * back as the YAML entry to paste into the file.
 */
function RulesDraft({ data }: { data: RulesResponse }) {
  const [form, setForm] = useState<FormState>(() => toForm(data.maintainer));
  const [status, setStatus] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setStatus(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const validated = validateMaintainerSettings(toBody(form));
  const login = data.maintainer.githubLogin;
  const yaml = validated.ok ? maintainerFileYaml(login, validated.value) : null;
  // A row the repo sync owns means the file exists on main; anything else
  // (no row, or a bare row created by Ack) means it still has to be created.
  const hasFile = data.exists && data.maintainer.updatedBy === "repo";

  async function runPreview() {
    setBusy(true);
    setFormError(null);
    try {
      setPreview(await sendJson<PreviewResponse>("/api/triage/rules/preview", "POST", toBody(form)));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyYaml() {
    if (!yaml) return;
    try {
      await navigator.clipboard.writeText(yaml);
      setStatus("Copied.");
    } catch {
      setStatus("Copy failed; select the YAML below and copy it.");
    }
  }

  const routable = preview?.matches.filter((match) => match.meetsMinScore) ?? [];

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
          Your settings live in <code className="font-mono">{maintainerFilePath(login)}</code>. Changes take effect about 5 minutes after the PR merges.
          Edits here are a draft only: preview them, then open a pull request with the YAML below.
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Claude (Opus) decides which items go to <span className="font-medium">{login}</span> by reading your notes
          together with the vLLM PRs you wrote and reviewed in the last 6 months.{" "}
          {data.exists
            ? `Loaded your current settings${data.maintainer.updatedAt ? ` (last synced ${new Date(data.maintainer.updatedAt).toLocaleString()}${data.maintainer.updatedBy ? ` by ${data.maintainer.updatedBy}` : ""})` : ""}.`
            : "You have no file yet; this draft starts empty."}
        </p>

        <div className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <label htmlFor="triage-notes" className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Notes for Claude <span className="font-normal text-zinc-500">(in your words)</span>
          </label>
          <p id="triage-notes-hint" className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            This is the main input for routing: Claude reads it on every important item to judge whether it&apos;s
            relevant to you. Say what you own, what to send you, and what not to. &ldquo;Don&apos;t send me&rdquo; always
            wins; naming a specific component works better than a broad category.
          </p>
          <textarea
            id="triage-notes"
            aria-describedby="triage-notes-hint triage-notes-example"
            className={`${INPUT} mt-2 h-36 py-1.5 text-sm leading-relaxed`}
            value={form.naturalLanguage}
            onChange={(e) => set("naturalLanguage", e.target.value)}
            placeholder="What you own, what to send you, what not to send you…"
          />
          <p id="triage-notes-example" className="mt-1 text-[11px] text-zinc-500">
            Example: &ldquo;Send me HiSparse bugs and anything about the Anthropic Messages API. Send me every
            quantization crash, even in code I didn&apos;t write. Don&apos;t send me ROCm-only issues.&rdquo;
          </p>
        </div>

        <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Daily digest</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Time zone" hint="IANA name; default UTC">
              <div className="flex gap-2">
                <select className={INPUT} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                  <option value="">UTC (default)</option>
                  {timeZoneOptions(form.timezone).map((zone) => (
                    <option key={zone} value={zone}>{zone}</option>
                  ))}
                </select>
                {(() => {
                  const mine = browserTimeZone();
                  return mine && mine !== form.timezone ? (
                    <button
                      type="button"
                      onClick={() => set("timezone", mine)}
                      title={`Use ${mine}`}
                      className="dashboard-control shrink-0 rounded-md border border-zinc-200 px-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Use mine
                    </button>
                  ) : null;
                })()}
              </div>
            </Field>
            <Field label="Digest hour" hint="local time, 0–23">
              <select className={INPUT} value={form.digestHour} onChange={(e) => set("digestHour", e.target.value)}>
                <option value="">{hourLabel(DEFAULT_DIGEST_HOUR)} (default)</option>
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={String(hour)}>{hourLabel(hour)}</option>
                ))}
              </select>
            </Field>
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Capacity per week" hint="New P0s, and P0s clearly yours, ignore this">
            <input type="number" min={0} max={200} className={INPUT} value={form.capacityPerWeek} onChange={(e) => set("capacityPerWeek", Number(e.target.value))} />
          </Field>
          <Field label="Minimum score" hint="40 = P1 and up, 70 = P0 only">
            <input type="number" min={0} max={1000} className={INPUT} value={form.minScore} onChange={(e) => set("minScore", Number(e.target.value))} />
          </Field>
          <Field label="Slack notifications">
            <select className={INPUT} value={form.notifyMode} onChange={(e) => set("notifyMode", e.target.value as NotifyMode)}>
              {NOTIFY_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </Field>
          <Field label="Max Slack DMs per day" hint={`immediate mode; default ${DEFAULT_MAX_NOTIFICATIONS_PER_DAY}, the rest wait for the digest`}>
            <input
              type="number"
              min={0}
              max={MAX_NOTIFICATIONS_PER_DAY_LIMIT}
              className={INPUT}
              value={form.maxNotifications}
              placeholder={String(DEFAULT_MAX_NOTIFICATIONS_PER_DAY)}
              onChange={(e) => set("maxNotifications", e.target.value)}
            />
          </Field>
          <Field label="Slack user ID" hint="e.g. U0123ABCD">
            <input className={INPUT} value={form.slackUserId} onChange={(e) => set("slackUserId", e.target.value)} />
          </Field>
        </div>
        <Field label="Away" hint="no routing on these dates">
          <div className="space-y-2">
            {form.away.map((range, index) => (
              <div key={index} className="flex items-center gap-2">
                <input type="date" aria-label="Away from" className={INPUT} value={range.start} onChange={(e) => set("away", form.away.map((r, i) => (i === index ? { ...r, start: e.target.value } : r)))} />
                <span className="text-xs text-zinc-500">to</span>
                <input type="date" aria-label="Away until" className={INPUT} value={range.end} onChange={(e) => set("away", form.away.map((r, i) => (i === index ? { ...r, end: e.target.value } : r)))} />
                <button type="button" className="text-xs text-zinc-500 hover:text-red-600" onClick={() => set("away", form.away.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}
            <button type="button" className="text-xs text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300" onClick={() => set("away", [...form.away, { start: "", end: "" }])}>
              Add away dates
            </button>
          </div>
        </Field>

        <details className="group rounded-md border border-zinc-200 dark:border-zinc-800">
          <summary className="dashboard-control flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50 [&::-webkit-details-marker]:hidden">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 transition-transform group-open:rotate-90" fill="currentColor">
              <path d="M6 3.5l5 4.5-5 4.5z" />
            </svg>
            Advanced: explicit rules (optional)
            {explicitRuleCount(form) > 0 && (
              <span className="font-normal text-zinc-500">{explicitRuleCount(form)} set</span>
            )}
          </summary>
          <div className="space-y-4 px-3 pb-3">
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Most people don&apos;t need these: your notes and recent PRs already route work to you. Use them only for
              hard limits. An item matching any area, hardware, model, path or keyword is always sent to you (if it
              passes the type filter); anything matching Exclude never is.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <MultiSelect label="Areas" options={[...TRIAGE_AREAS]} selected={form.areas} onChange={(value) => set("areas", value)} placeholder="None" />
              <MultiSelect label="Hardware" options={[...TRIAGE_HARDWARE]} selected={form.hardware} onChange={(value) => set("hardware", value)} placeholder="None" />
              <MultiSelect label="Only types" options={[...TRIAGE_TYPES]} selected={form.types} onChange={(value) => set("types", value)} placeholder="Any type" />
            </div>
            <Field label="Models" hint="one glob per line, e.g. DeepSeek-*, case-insensitive">
              <textarea className={`${INPUT} h-20 py-1 font-mono text-xs`} value={form.models} onChange={(e) => set("models", e.target.value)} />
            </Field>
            <Field label="Paths" hint="one glob per line, e.g. vllm/model_executor/layers/fused_moe/**">
              <textarea className={`${INPUT} h-20 py-1 font-mono text-xs`} value={form.paths} onChange={(e) => set("paths", e.target.value)} />
            </Field>
            <Field label="Keywords" hint="one per line, matched in title and summary">
              <textarea className={`${INPUT} h-16 py-1 text-xs`} value={form.keywords} onChange={(e) => set("keywords", e.target.value)} />
            </Field>
            <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <legend className="px-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Exclude</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <MultiSelect label="Types" options={[...TRIAGE_TYPES]} selected={form.excludeTypes} onChange={(value) => set("excludeTypes", value)} placeholder="None" />
                <MultiSelect label="Areas" options={[...TRIAGE_AREAS]} selected={form.excludeAreas} onChange={(value) => set("excludeAreas", value)} placeholder="None" />
                <MultiSelect label="Hardware" options={[...TRIAGE_HARDWARE]} selected={form.excludeHardware} onChange={(value) => set("excludeHardware", value)} placeholder="None" />
              </div>
            </fieldset>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className="dashboard-control min-h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            Preview rules on last 30 days
          </button>
          <button type="button" disabled={!yaml} onClick={() => void copyYaml()} className="dashboard-control min-h-9 rounded-md border border-zinc-200 px-4 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Copy as YAML
          </button>
          {hasFile ? (
            <a
              href={maintainerFileEditUrl(login)}
              target="_blank"
              rel="noopener noreferrer"
              className="dashboard-control inline-flex min-h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Edit your rules file on GitHub
            </a>
          ) : yaml ? (
            <a
              href={maintainerFileCreateUrl(login, yaml)}
              target="_blank"
              rel="noopener noreferrer"
              className="dashboard-control inline-flex min-h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Create your rules file on GitHub
            </a>
          ) : null}
          {status && <span className="text-xs text-emerald-600">{status}</span>}
          {formError && <span className="text-xs text-red-600 dark:text-red-400">{formError}</span>}
        </div>
        <Field label={`${maintainerFilePath(login)}`} hint={hasFile ? "replace the file's content with this" : "the new file's content"}>
          {yaml ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">{yaml}</pre>
          ) : (
            <p className="text-xs text-red-600 dark:text-red-400">{!validated.ok && validated.error}</p>
          )}
        </Field>
      </form>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Preview</h2>
        {!preview ? (
          <p className="text-sm text-zinc-500">Preview shows which items from the last 30 days your explicit rules (under Advanced) would have matched. Matches from your notes are judged by Claude on new items and aren&apos;t previewed here.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-zinc-500">
              {preview.matches.length} of {preview.scanned} items match; {routable.length} also meet your minimum score.
              The router additionally skips you when you are away or over capacity.
            </p>
            <ul className="space-y-2">
              {preview.matches.slice(0, 200).map((match) => (
                <li key={match.itemKey} className={`relative overflow-hidden rounded-md border border-zinc-200 p-2 pl-3 text-xs dark:border-zinc-800 ${match.meetsMinScore ? "" : "opacity-60"}`}>
                  <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${bandStyle(match.band).fill}`} />
                  <div className="flex items-center gap-2">
                    <BandBadge band={match.band} score={match.score} />
                    <KindIcon kind={match.kind} />
                    {!match.meetsMinScore && <span className="text-zinc-500">below your min score</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 font-medium"><GithubLink href={match.htmlUrl} title={match.title}>{match.title}</GithubLink></p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {match.matched.map((reason) => (
                      <span key={reason} className="rounded bg-zinc-100 px-1.5 py-px font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{reason}</span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
