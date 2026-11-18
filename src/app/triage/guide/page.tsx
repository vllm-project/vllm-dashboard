import type { Metadata } from "next";
import Link from "next/link";
import { PriorityBadge } from "@/components/triage/badges";
import { GUIDE_FACTS, MAINTAINERS_DIR_URL } from "@/lib/triage-guide";
import { SCORING } from "@/lib/triage-scoring-config";

export const metadata: Metadata = { title: "How triage works" };

const LINK = "font-medium text-zinc-900 underline underline-offset-2 hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-300";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

/** Name / explanation rows, readable at phone width (same look as the scoring page's tables). */
function Table({ head, rows }: { head: [string, string]; rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="px-3 py-2 font-medium">{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map(([name, what], index) => (
            <tr key={index}>
              <td className="whitespace-nowrap px-3 py-2 align-top font-medium text-zinc-900 dark:text-zinc-100">{name}</td>
              <td className="px-3 py-2 align-top text-zinc-600 dark:text-zinc-400">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{children}</code>;
}

export default function TriageGuidePage() {
  const { thresholds, scope } = SCORING;
  const months = Math.round(GUIDE_FACTS.profileDays / 30);

  return (
    <article className="mx-auto max-w-3xl space-y-6 pb-10">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">How triage works</h1>
        <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          Triage reads every new vLLM issue and PR, works out how much it matters, and sends the important ones to
          the maintainer they&apos;re most likely for. You work yours on{" "}
          <Link href="/triage/me" className={LINK}>My list</Link>. This is the five-minute version.
        </p>
      </header>

      <Section id="what" title="What gets triaged">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            Issues and PRs <b>opened in the last {scope.max_age_days} days</b>. Skipped: anything opened by a bot, and
            PRs from vLLM org members and collaborators that don&apos;t link an issue. Items leave the queue once they pass {scope.max_age_days} days;
            anything you acked stays in your history.
          </li>
          <li>
            <b>Claude labels each one</b>: which model, GPU and settings, which area of vLLM, and what broke. For
            PRs it sees the description and the list of changed files. It has no tools and can&apos;t act.
          </li>
          <li>
            A fixed formula turns those labels into a score and a priority,{" "}
            <PriorityBadge band="page" /> to <PriorityBadge band="ignore" />. Claude never picks the score; see{" "}
            <Link href="/triage/scoring" className={LINK}>Scoring guidelines</Link>.
          </li>
          <li>
            <b>Only P0 ({thresholds.page}+) and P1 ({thresholds.route}+) are routed</b> to a person. P2 and P3 stay
            on the queue for anyone to pick up.
          </li>
        </ul>
      </Section>

      <Section id="routing" title="How an item reaches you">
        <p>You get an item for one of these reasons, strongest first:</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            <b>You&apos;re already involved:</b> it&apos;s assigned to you on GitHub, you wrote a PR it names (for
            example the commit a regression was bisected to), or you commented on it.
          </li>
          <li>
            <b>Claude judges it high or medium for you</b>, from the PRs you authored and reviewed in the last{" "}
            {months} months (refreshed daily) plus the <Code>notes</Code> in your file. High means it&apos;s
            squarely your code. Medium means a specific component you write code in regularly, not a broad area
            like &ldquo;MoE&rdquo; or &ldquo;FP8&rdquo;. Reviewing nearby PRs alone is never enough.
          </li>
          <li>
            <b>It matches a rule</b> you wrote in your file. Optional, for &ldquo;always send me X&rdquo;.
          </li>
        </ol>
        <p>
          <b>Claude learns from what you do.</b> Items you mark Not mine count against similar items; items you ack
          or finish count for them (last {GUIDE_FACTS.feedbackDays} days, picked up once a day).
        </p>
        <p>
          Each item gets one owner; a P0 can also get a backup who is a clear match. The item drawer shows why it
          picked you, e.g. <Code>relevance:high (like #61343)</Code>. Routing waits up to{" "}
          {GUIDE_FACTS.relevanceGraceHours} hours for Claude&apos;s judgements, then goes ahead. Items assigned on
          GitHub only to people outside the maintainer list aren&apos;t routed. Neither are P1 PRs waiting on their
          author (a draft, failing pre-commit or DCO, merge conflicts, or changes requested); they&apos;re routed once
          it&apos;s the reviewers&apos; move. P0 PRs are routed either way.
        </p>
        <p>
          <b>Weekly capacity.</b> <Code>capacity_per_week</Code> caps how many items you get in 7 days. Items you
          passed on or that were reassigned away don&apos;t count. A P0 can go past your cap when it&apos;s new
          (opened in the last {GUIDE_FACTS.freshDays} days) or clearly yours (you&apos;re involved, or Claude said
          high). Weaker matches wait or go to someone else.
        </p>
      </Section>

      <Section id="file" title="Your file">
        <p>
          Everything about what you get lives in{" "}
          <a href={MAINTAINERS_DIR_URL} className={LINK}>
            <Code>triage/config/maintainers/&lt;your-login&gt;.yaml</Code>
          </a>{" "}
          in vllm-project/vllm-dashboard. Change it by pull request; it takes effect about 5 minutes after the PR
          merges. <Link href="/triage/rules" className={LINK}>Configure rules</Link> previews a draft against the
          last 30 days and opens your file on GitHub.
        </p>
        <Table
          head={["Field", "What it does"]}
          rows={[
            [
              <Code key="n">notes</Code>,
              <>
                The most useful one. Plain words: what you own, what to send you, what not to. Claude reads it.
                &ldquo;Don&apos;t send me X&rdquo; always wins. Naming a specific component (&ldquo;HiSparse
                bugs&rdquo;) makes it at least medium. A broad category (&ldquo;quantization crashes&rdquo;) only
                counts for the parts you author, so say so explicitly if you want all of it.
              </>,
            ],
            [
              <Code key="e">rules.exclude</Code>,
              <>
                Hard limits by type, area or hardware. A hardware exclude only blocks items that are about nothing
                but that hardware. It never blocks items you&apos;re already involved in.
              </>,
            ],
            [
              <Code key="r">rules</Code>,
              <>Optional &ldquo;always send me&rdquo;: areas, models, keywords, paths, hardware.</>,
            ],
            [
              <Code key="m">notify_mode</Code>,
              <>
                <Code>digest</Code> (P0 right away, the rest once a day), <Code>immediate</Code> (every item right
                away) or <Code>off</Code> (dashboard only). See Slack below.
              </>,
            ],
            [
              <Code key="t">timezone</Code>,
              <>
                Where you are, e.g. <Code>Europe/London</Code> (default UTC). With <Code>digest_hour</Code> (default{" "}
                {GUIDE_FACTS.defaultDigestHour}) it sets when your daily digest arrives.
              </>,
            ],
            [
              <Code key="a">away</Code>,
              <>Date ranges when nothing new is sent to you, e.g. <Code>{"{start: 2026-12-20, end: 2027-01-03}"}</Code>.</>,
            ],
            [
              <Code key="l">language</Code>,
              <>
                <Code>vi</Code> sends your Slack messages, including Claude&apos;s one-line &ldquo;why you&rdquo;, in
                Vietnamese. Issue titles stay as written. Leave it out for English.
              </>,
            ],
            [
              <Code key="c">capacity_per_week</Code>,
              <>
                Your weekly cap (above). <Code>min_score</Code> skips items scoring lower. <Code>active: false</Code>{" "}
                pauses everything.
              </>,
            ],
          ]}
        />
      </Section>

      <Section id="buttons" title="What the buttons do">
        <Table
          head={["Button", "What happens"]}
          rows={[
            ["Ack", "“I’ve got it.” It stays on your list as yours. On an unowned item the button reads Take it and makes it yours."],
            ["Not mine", "It goes to the next best match, if there is one, within a few minutes, and never comes back to you. It doesn’t count against your capacity."],
            ["Reassign…", "Hand it to a maintainer you choose. Anyone can reassign any open item."],
            ["Done", "You’ve dealt with it. It moves to Closed on My list, and Reopen brings it back."],
            ["Drop", "Nobody needs to look at this. Hidden for good: it is never routed to anyone again."],
            ["Slop", "Same as Drop, for low-quality or spam items, and recorded as slop."],
          ]}
        />
        <p>
          <b>GitHub counts too.</b> If the item is closed or merged on GitHub, it&apos;s marked Done for you (and comes
          back if it&apos;s reopened). If you comment on it on GitHub, that counts as Ack.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Drop and Slop hide an item from everyone, so use them only when nobody should pick it up. If one person hides
          a lot of items in a day, the queue shows a warning.
        </p>
      </Section>

      <Section id="slack" title="Slack">
        <p>
          When Slack is on for you, a <b>P0 is sent as a DM right away</b> and everything else comes in <b>one daily
          digest</b> at your local morning ({GUIDE_FACTS.defaultDigestHour}:00 in your <Code>timezone</Code> unless
          you set <Code>digest_hour</Code>). The digest ends with a <b>Still waiting</b> list of items you haven&apos;t
          acked after {GUIDE_FACTS.waitingAfterDays}+ days. Each item has Ack, Not mine and Reassign buttons that do
          the same as here. It needs <Code>slack_user_id</Code> in your file.
        </p>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <b>During the beta, Slack is off.</b> Nothing is sent to you until Kevin turns it on for you. Check{" "}
          <Link href="/triage/me" className="font-medium underline underline-offset-2">My list</Link> instead.
        </p>
      </Section>

      <Section id="feedback" title="Feedback">
        <p>
          Wrong person, wrong priority, a confusing screen, anything else: <b>tell Kevin</b> (Kevin Luu). A link to the
          item and what you expected helps most. To change what you get, editing your <Code>notes</Code> is usually
          the quickest fix.
        </p>
      </Section>

      <footer className="border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        The details are in <code className="font-mono">triage/README.md</code> and{" "}
        <code className="font-mono">triage/config/maintainers/README.md</code>.{" "}
        <Link href="/triage" className="underline underline-offset-2">Back to the queue</Link>
      </footer>
    </article>
  );
}
