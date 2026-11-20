import type { Metadata } from "next";
import Link from "next/link";
import { Chips, PriorityBadge } from "@/components/triage/badges";
import { ScoreBreakdown } from "@/components/triage/score-breakdown";
import { NICHE_EXAMPLE, SCORING, TIERS, WORKED_EXAMPLE, scoreExample } from "@/lib/triage-scoring-config";

export const metadata: Metadata = { title: "Scoring guidelines" };

const S = SCORING;
const fmt = (value: number) => String(Number(value.toFixed(2)));
const signed = (value: number) => (value > 0 ? `+${fmt(value)}` : value < 0 ? `−${fmt(Math.abs(value))}` : "0");

function Section({ id, step, title, children }: { id: string; step?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <h2 className="flex items-baseline gap-2 text-base font-semibold text-zinc-950 dark:text-zinc-50">
        {step && <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{step}</span>}
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

/** A two- or three-column table that stays readable at phone width. */
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {head.map((cell, index) => (
              <th key={cell} className={`px-3 py-2 font-medium ${index === head.length - 1 ? "text-right" : ""}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={`px-3 py-2 align-top ${
                    cellIndex === row.length - 1
                      ? "whitespace-nowrap text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
                      : cellIndex === 0
                        ? "text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TERM_STYLES = {
  severity: "border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200",
  reach: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200",
  extras: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  penalty: "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200",
} as const;

function Term({ kind, title, detail, href }: { kind: keyof typeof TERM_STYLES; title: string; detail: string; href: string }) {
  return (
    <a href={href} className={`block min-w-0 flex-1 rounded-lg border px-3 py-2 hover:brightness-[0.98] ${TERM_STYLES[kind]}`}>
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-[11px] opacity-80">{detail}</span>
    </a>
  );
}

function Op({ children }: { children: React.ReactNode }) {
  return <span className="hidden self-center px-1 text-lg font-semibold text-zinc-400 sm:inline" aria-hidden="true">{children}</span>;
}

function Example({ title, sentence, input }: { title: string; sentence: string; input: Parameters<typeof scoreExample>[0] }) {
  const result = scoreExample(input);
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge band={result.band} size="md" />
        <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">{title}</span>
        <span className="ml-auto text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
          score <span className="font-semibold text-zinc-950 dark:text-zinc-50">{result.score}</span>
        </span>
      </div>
      <p className="mb-3 mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sentence}</p>
      <ScoreBreakdown entries={result.factors} score={result.score} />
    </div>
  );
}

export default function ScoringGuidePage() {
  const best = S.reach.model.tier1 * S.reach.hardware.tier1 * S.reach.config.default;
  const worst = S.reach.model.other * S.reach.hardware.other * S.reach.config.exotic;
  const levels = [
    { band: "page" as const, range: `${S.thresholds.page} and up`, what: "Routed to an owner first; a new P0 can go past their weekly cap." },
    { band: "route" as const, range: `${S.thresholds.route}–${S.thresholds.page - 1}`, what: "Routed to the best-matching owner, within their weekly cap." },
    { band: "watch" as const, range: `${S.thresholds.watch}–${S.thresholds.route - 1}`, what: "Not routed. Visible on the dashboard for anyone to pick up." },
    { band: "ignore" as const, range: `below ${S.thresholds.watch}`, what: "Not routed, and hidden by default." },
  ];

  return (
    <article className="mx-auto max-w-3xl space-y-6 pb-10">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">Scoring guidelines</h1>
        <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          Every open issue and PR gets a score. An LLM reads the item and reports facts (which model, which GPU, what broke);
          a fixed formula turns those facts into points. The LLM never picks the score, so every number can be explained,
          and the drawer on each item shows exactly where its points came from.
        </p>
        <p className="pt-1 text-sm font-medium text-zinc-900 sm:hidden dark:text-zinc-100">
          score = how bad × who it hits + extras − penalties
        </p>
        <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:flex-row sm:items-stretch sm:pt-2">
          <Term kind="severity" title="How bad" detail="the worst symptom" href="#severity" />
          <Op>×</Op>
          <Term kind="reach" title="Who it hits" detail="model × GPU × settings" href="#reach" />
          <Op>+</Op>
          <Term kind="extras" title="Extras" detail="regression, release, repro, interest, PR" href="#extras" />
          <Op>−</Op>
          <Term kind="penalty" title="Penalties" detail="low effort, slop, unsure read" href="#penalties" />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">The total never goes below 0.</p>
      </header>

      <Section id="levels" title="What the score means">
        <Table
          head={["Priority", "What happens", "Score"]}
          rows={levels.map((level) => [
            <PriorityBadge key="p" band={level.band} />,
            level.what,
            level.range,
          ])}
        />
        <p>Only P0 and P1 are routed to a maintainer. P2 and P3 stay on the dashboard.</p>
        <p>
          P0 also requires a reproduction, confidence of at least {fmt(S.p0.min_confidence)}, and evidence that main or
          the latest release is affected by serving failure, wrong output, or a security defect. Non-security defects
          must affect default configurations on a top-tier model/GPU path or shared API/tokenizer code.
          CPU-backend-only defects stay below P0; reproducing a shared API bug on CPU does not make it CPU-only.
          Items that fail this gate are capped at {S.thresholds.page - 1}, with the reason in their score breakdown.
        </p>
        <p>
          Only issues and PRs opened in the last {S.scope.max_age_days} days are triaged. Older ones leave the
          queue as they age past that; anything someone already acknowledged stays in their history.
        </p>
      </Section>

      <Section id="severity" step="Step 1" title="How bad is it?">
        <p>
          The LLM flags the symptoms. Only the <b>worst one</b> counts, so a crash that also breaks serving isn&apos;t counted
          twice. Symptoms count for bugs, regressions, speed regressions, performance problems and CI problems. A feature
          request that happens to mention a crash gets no points here.
        </p>
        <Table
          head={["Symptom", "Notes", "Points"]}
          rows={[
            ["Serving is broken", "the server can't start or serve requests", S.severity.serving_broken],
            ["Security problem", "not scaled by model or GPU", S.severity.security],
            ["Wrong output", "garbage or incorrect results", S.severity.wrong_output],
            ["Crashes", "an exception or crash while serving", S.severity.crash],
            ["Hangs", "requests never finish", S.severity.hang],
            ["Uses more memory than before", "", S.severity.memory_regression],
            ["Speed regression", `${S.severity.perf_regression_per_10pct} for every 10% slower, up to ${S.severity.perf_regression_cap}`, `up to ${S.severity.perf_regression_cap}`],
          ]}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          A standalone PR gets {fmt(S.severity.pr_fraction * 100)}% of these points. A linked fix instead inherits
          its issue&apos;s impact before draft and quality penalties; the two scores are never added together.
        </p>
      </Section>

      <Section id="reach" step="Step 2" title="Who does it hit?">
        <p>
          The symptom&apos;s points are multiplied by three numbers. A crash on a popular model, on a top-tier GPU, with default
          settings hits the most people. The same crash on a fine-tune, on a rare card, with unusual flags hits very few. The
          combined multiplier ranges from <b>×{fmt(best)}</b> down to <b>×{fmt(worst)}</b>.
        </p>
        <Table
          head={["Model", "Examples", "×"]}
          rows={[
            ["Popular (top tier)", "DeepSeek, Qwen 3, Llama 3/4, Kimi, gpt-oss…", `×${fmt(S.reach.model.tier1)}`],
            ["Common", "Phi, Granite, Nemotron, InternVL…", `×${fmt(S.reach.model.tier2)}`],
            ["Not named", "", `×${fmt(S.reach.model.unknown)}`],
            ["Anything else", "fine-tunes, new or rare models", `×${fmt(S.reach.model.other)}`],
          ]}
        />
        <Table
          head={["GPU / hardware", "Examples", "×"]}
          rows={[
            ["Top tier", TIERS.hardware.tier1.join(", "), `×${fmt(S.reach.hardware.tier1)}`],
            ["Common", TIERS.hardware.tier2.join(", "), `×${fmt(S.reach.hardware.tier2)}`],
            ["CPU backend only", "CPU inference defect, not just a CPU reproduction", `×${fmt(S.reach.hardware.cpu)}`],
            ["Not stated", "", `×${fmt(S.reach.hardware.unknown)}`],
            ["Anything else", "consumer and older cards", `×${fmt(S.reach.hardware.other)}`],
          ]}
        />
        <Table
          head={["Settings", "", "×"]}
          rows={[
            ["Default settings", "happens without special flags", `×${fmt(S.reach.config.default)}`],
            ["Not clear", "", `×${fmt(S.reach.config.unknown)}`],
            ["Unusual settings", "needs uncommon flags or a rare combination", `×${fmt(S.reach.config.exotic)}`],
          ]}
        />
      </Section>

      <Section id="extras" step="Step 3" title="Extras">
        <p>Points added on top, whatever the symptom.</p>
        <Table
          head={["Extra", "When", "Points"]}
          rows={[
            ["Regression", "it used to work", signed(S.type.regression)],
            ["Speed regression", "it used to be faster", signed(S.type.perf_regression)],
            ["CI problem", "", signed(S.type.ci)],
            ["Bug", "", signed(S.type.bug)],
            ["Popular model", "top-tier / common model", `${signed(S.popularity.model.tier1)} / ${signed(S.popularity.model.tier2)}`],
            ["Popular GPU", "top-tier / common hardware", `${signed(S.popularity.hardware.tier1)} / ${signed(S.popularity.hardware.tier2)}`],
            ["Affects the latest release", "", signed(S.recency.affects_latest_release)],
            ["Affects main (nightly) only", "if not the latest release", signed(S.recency.affects_main)],
            ["Has steps to reproduce", "", signed(S.evidence.has_repro)],
            [
              "Community interest",
              `${signed(S.social.per_reaction)} per reaction, ${signed(S.social.per_comment)} per comment`,
              `up to ${signed(S.social.cap)}`,
            ],
          ]}
        />
        <p className="font-medium text-zinc-900 dark:text-zinc-100">For PRs</p>
        <p>Tests, small size, and hot-path labels do not increase incident priority. Use the review views and CI status to decide what is ready.</p>
        <Table
          head={["PR signal", "When", "Points"]}
          rows={[
            ["Fixes a scored issue", `${fmt(S.pr.fixes_issue_fraction * 100)}% of the best current, in-scope open issue; replaces its own score`, "varies"],
            ["Touches code on every request", "the hot path", signed(S.pr.hot_path)],
            ["Includes tests", "", signed(S.pr.has_tests)],
            ["Tiny or small change", "", signed(S.pr.size.s)],
          ]}
        />
      </Section>

      <Section id="penalties" step="Step 4" title="Penalties">
        <Table
          head={["Penalty", "When", "Points"]}
          rows={[
            ["The LLM wasn't sure", "its confidence in the read was low", signed(S.evidence.low_confidence)],
            ["Looks low-effort (PR)", "", signed(S.pr.low_effort)],
            ["Draft PR", "", signed(S.pr.draft)],
            ["Large / very large PR", "", `${signed(S.pr.size.l)} / ${signed(S.pr.size.xl)}`],
            ["Low-quality signals", `${signed(S.slop.per_signal)} for each one the LLM reports`, `down to ${signed(S.slop.cap)}`],
            ["Spam", "", signed(S.type.spam)],
          ]}
        />
      </Section>

      <Section id="examples" title="Worked examples">
        <Example
          title="Serving broken on DeepSeek, H100, default flags"
          sentence="A bug report: the server won't start for DeepSeek-V3 on H100 with default settings, in the latest release (0.27.1), with steps to reproduce."
          input={WORKED_EXAMPLE}
        />
        <Example
          title="The same outage on a niche setup"
          sentence="The same symptom on an unlisted fine-tune, on a consumer card, with unusual flags and no repro: it hits far fewer people."
          input={NICHE_EXAMPLE}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Points are rounded to whole numbers exactly as the router rounds them, which is why 50 × 1.15 shows as 57.
        </p>
      </Section>

      <Section id="tiers" title="Which models and GPUs count as popular">
        <p>Model names match these patterns (case-insensitive; * matches anything). The first match wins.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">Popular models (top tier)</p>
            <Chips kind="model" values={[...TIERS.models.tier1]} max={100} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">Common models</p>
            <Chips kind="model" values={[...TIERS.models.tier2]} max={100} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">Top-tier GPUs</p>
            <Chips kind="hardware" values={[...TIERS.hardware.tier1]} max={100} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">Common hardware</p>
            <Chips kind="hardware" values={[...TIERS.hardware.tier2]} max={100} />
          </div>
        </div>
      </Section>

      <footer className="border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        These numbers come from <code className="font-mono">triage/config/scoring.yaml</code> (version {S.version}) and{" "}
        <code className="font-mono">triage/config/tiers.yaml</code> (version {TIERS.version}). They change by pull request,
        and a test keeps this page in step with them. <Link href="/triage" className="underline underline-offset-2">Back to the queue</Link>
      </footer>
    </article>
  );
}
