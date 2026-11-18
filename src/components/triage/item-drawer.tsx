"use client";

import Link from "next/link";
import { useEffect } from "react";
import useSWR from "swr";
import {
  Avatar,
  Chips,
  GithubLink,
  KindIcon,
  PriorityBadge,
  RelevanceBadge,
  SeverityFlags,
  TypeLabel,
  UnroutedBadge,
} from "@/components/triage/badges";
import { isUnrouted, priorityLabel, typeLabel } from "@/lib/triage-style";
import { ActionButtons } from "@/components/triage/action-buttons";
import { ScoreBreakdown } from "@/components/triage/score-breakdown";
import { humanizeTag } from "@/lib/triage-factors";
import { actionText, extractionText, percentText, scopeText, sourceText, yesNo } from "@/lib/triage-words";
import { describeReason, formatAge, triageFetcher } from "@/lib/triage-format";
import type { TriageAssignment, TriageItemDetail, TriageRelevance } from "@/lib/triage-types";
import type { WhyUnowned } from "@/lib/triage-why-unowned";

/** A collapsible detail section; the summary at the top of the drawer stays open. */
function Disclosure({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-zinc-200 dark:border-zinc-800">
      <summary className="dashboard-control flex cursor-pointer list-none items-center gap-2 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 transition-transform group-open:rotate-90" fill="currentColor">
          <path d="M6 3.5l5 4.5-5 4.5z" />
        </svg>
        {title}
        {meta && <span className="font-medium normal-case tracking-normal text-zinc-400 dark:text-zinc-500">{meta}</span>}
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200">{children}</dd>
    </div>
  );
}


/** Read-only JSON rendered as text (never HTML). */
function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-zinc-50 p-2 text-[11px] leading-4 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Why the router picked this person, in words, with linked evidence. */
function WhyThisPerson({
  reason,
  judgement,
}: {
  reason: Record<string, unknown>;
  judgement: TriageRelevance | undefined;
}) {
  const matched = Array.isArray(reason.matched) ? reason.matched.filter((m): m is string => typeof m === "string") : [];
  const manual = typeof reason.manual === "string" ? `${reason.manual} by ${String(reason.by ?? "someone")}` : null;
  const why = typeof reason.why === "string" && reason.why ? reason.why : judgement?.reason;
  const load = typeof reason.load === "number" && typeof reason.capacity === "number"
    ? `${reason.load} of ${reason.capacity} this week when assigned`
    : null;
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60">
      <p className="font-medium text-zinc-700 dark:text-zinc-200">
        Why: {manual ?? (matched.length ? matched.map(describeReason).join("; ") : "not recorded")}
      </p>
      {why && <p className="mt-1 text-zinc-600 dark:text-zinc-300">{why}</p>}
      {judgement && <EvidenceList evidence={judgement.evidence} />}
      {load && <p className="mt-1 text-[11px] text-zinc-500">{load}</p>}
    </div>
  );
}

/** Evidence PRs, as links to GitHub with their titles. */
function EvidenceList({ evidence }: { evidence: TriageRelevance["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {evidence.map((pr) => (
        <li key={pr.number} className="text-zinc-600 dark:text-zinc-300">
          <a
            href={`https://github.com/vllm-project/vllm/pull/${pr.number}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-sky-700 hover:underline dark:text-sky-400"
          >
            #{pr.number}
          </a>{" "}
          <span className="text-zinc-400">{pr.kind}</span> {pr.title}
        </li>
      ))}
    </ul>
  );
}

/** The router's reason for one owner, in one line, for the summary. */
function oneLineWhy(reason: Record<string, unknown>, judgement: TriageRelevance | undefined): string {
  if (typeof reason.manual === "string") return `${reason.manual} by ${String(reason.by ?? "someone")}`;
  if (typeof reason.why === "string" && reason.why) return reason.why;
  if (judgement?.reason) return judgement.reason;
  const matched = Array.isArray(reason.matched) ? reason.matched.filter((m): m is string => typeof m === "string") : [];
  return matched.length ? matched.map(describeReason).join("; ") : "Reason not recorded";
}

const STATUS_TEXT: Record<string, string> = {
  open: "not acked yet",
  acked: "acked",
  done: "done",
  not_mine: "said not mine",
  reassigned: "reassigned",
  dropped: "dropped",
  slop: "marked slop",
};

function OwnerSummary({ assignment, judgement }: { assignment: TriageAssignment; judgement: TriageRelevance | undefined }) {
  return (
    <li className="flex gap-2.5">
      <Avatar login={assignment.maintainer} size={28} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{assignment.maintainer}</span>
          <span className="rounded bg-zinc-100 px-1.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {assignment.role === "primary" ? "primary" : "backup"}
          </span>
          <span
            className={`text-xs ${assignment.status === "acked" ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"}`}
          >
            {assignment.status === "acked" ? "✓ " : ""}
            {STATUS_TEXT[assignment.status] ?? assignment.status}
            {assignment.status === "acked" && assignment.reason.acked_by === "github_comment" ? " (commented on GitHub)" : ""}
          </span>
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{oneLineWhy(assignment.reason, judgement)}</p>
      </div>
    </li>
  );
}

/** The router's reason a P0/P1 has no owner (triage-why-unowned.ts). */
function WhyNoOwner({ why }: { why: WhyUnowned }) {
  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-xs ${
        why.pending
          ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100"
          : "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
      }`}
    >
      <p>
        <span className="font-semibold">Why no owner: </span>
        {why.summary}
      </p>
      {why.lines.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 opacity-90">
          {why.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The deterministic prepass, in words, with the raw JSON one click away. */
function QuickSignals({ prepass }: { prepass: TriageItemDetail["item"]["prepass"] }) {
  const template = prepass.template ?? {};
  const templateChecks = [
    template.has_env !== undefined ? `environment ${template.has_env ? "filled in" : "missing"}` : null,
    template.has_repro !== undefined ? `repro ${template.has_repro ? "filled in" : "missing"}` : null,
    template.test_plan !== undefined ? `test plan ${template.test_plan ? "filled in" : "missing"}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Cheap checks run on every item before the LLM sees it: changed files, linked issues, template fields, and keywords.
      </p>
      <dl>
        <Row label="Why it's triaged">{scopeText(prepass.scope_reason) ?? "—"}</Row>
        <Row label="Code areas (from files)"><Chips kind="area" values={(prepass.areas ?? []).map(humanizeTag)} max={10} /></Row>
        <Row label="Linked issues">{prepass.linked_issues?.length ? prepass.linked_issues.map((n) => `#${n}`).join(", ") : "none"}</Row>
        <Row label="Hardware mentioned"><Chips kind="hardware" values={prepass.hardware_hints ?? []} max={10} /></Row>
        <Row label="Models mentioned"><Chips kind="model" values={prepass.model_hints ?? []} max={10} /></Row>
        <Row label="Author">
          {prepass.is_maintainer ? "a maintainer" : prepass.first_time ? "a first-time contributor" : "a contributor"}
        </Row>
        <Row label="Issue template">{templateChecks.length ? templateChecks.join(" · ") : "—"}</Row>
        <Row label="Assigned on GitHub">{prepass.gh_assignees?.length ? prepass.gh_assignees.join(", ") : "nobody"}</Row>
        <Row label="Low-quality hints">{prepass.slop_hints?.length ? prepass.slop_hints.map(humanizeTag).join(", ") : "none"}</Row>
      </dl>
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Raw data</summary>
        <div className="mt-2">
          <JsonBlock value={prepass} />
        </div>
      </details>
    </div>
  );
}

export function ItemDrawer({
  itemKey,
  viewer,
  onClose,
  onChanged,
}: {
  itemKey: string;
  viewer: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { data, error, mutate } = useSWR<TriageItemDetail>(
    `/api/triage/items/detail?key=${encodeURIComponent(itemKey)}`,
    triageFetcher,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const facets = data?.extraction?.facets ?? {};
  const severity = facets.severity ?? {};
  const openAssignments = data?.assignments.filter((a) => a.status === "open" || a.status === "acked") ?? [];
  const owners = [...openAssignments].sort((a, b) => (a.role === b.role ? 0 : a.role === "primary" ? -1 : 1));
  const mine = viewer
    ? data?.assignments.find(
        (a) => a.maintainer.toLowerCase() === viewer.toLowerCase(),
      )
    : undefined;
  const mineOpen = mine && (mine.status === "open" || mine.status === "acked") ? mine : undefined;
  const band = data?.score?.band ?? null;
  const number = itemKey.split("#")[1];

  function refresh() {
    void mutate();
    onChanged?.();
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`Triage item #${number}`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-zinc-950/30 backdrop-blur-[1px] dark:bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-zinc-950 dark:ring-1 dark:ring-white/10">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-2.5 dark:border-zinc-800">
          {data ? <PriorityBadge band={band} size="md" /> : <span className="h-6 w-9 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />}
          {data?.score && (
            <Link
              href="/triage/scoring"
              className="text-sm tabular-nums text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300"
              title="How is this scored?"
            >
              score <span className="font-semibold text-zinc-900 dark:text-zinc-100">{data.score.score}</span>
            </Link>
          )}
          <span className="ml-1 inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {data && <KindIcon kind={data.item.kind} draft={data.item.draft} />}
            {itemKey}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="dashboard-control ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5">
          {error && <p className="py-4 text-sm text-red-600 dark:text-red-400">{error.message}</p>}
          {!data && !error && (
            <div aria-hidden="true" className="animate-pulse space-y-3 py-5">
              <div className="h-5 w-11/12 rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-1/2 rounded bg-zinc-100 dark:bg-zinc-800/70" />
              <div className="h-16 w-full rounded bg-zinc-100 dark:bg-zinc-800/70" />
            </div>
          )}

          {data && (
            <>
              <div className="space-y-3 py-4">
                <h2 className="text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50">
                  <GithubLink href={data.item.htmlUrl}>{data.item.title}</GithubLink>
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {data.item.state} · by {data.item.author} ({data.item.authorAssociation.toLowerCase()}) · opened{" "}
                  {formatAge(data.item.ghCreatedAt)} ago · {data.item.commentCount} comments · {data.item.reactions} reactions
                </p>
                {(facets.type || (facets.severity && Object.keys(facets.severity).length > 0)) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <TypeLabel type={facets.type ?? null} />
                    <SeverityFlags facets={facets} max={8} colorAll />
                  </div>
                )}
                {facets.summary && <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{facets.summary}</p>}

                <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Owners</p>
                  {owners.length === 0 ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                        {isUnrouted(band, 0) && <UnroutedBadge />}
                        <span>
                          {data.item.prepass.gh_assignees?.length && !(isUnrouted(band, 0) && data.whyUnowned)
                            ? `Assigned on GitHub to ${data.item.prepass.gh_assignees.join(", ")}, so triage leaves it with them. Take it, or reassign it, if that's wrong.`
                            : isUnrouted(band, 0)
                              ? `This ${priorityLabel(band)} has no owner yet. Take it, or reassign it to someone.`
                              : "Not routed; only P0 and P1 get an owner."}
                        </span>
                      </div>
                      {isUnrouted(band, 0) && data.whyUnowned && <WhyNoOwner why={data.whyUnowned} />}
                    </div>
                  ) : (
                    <ul className="space-y-2.5">
                      {owners.map((assignment) => (
                        <OwnerSummary
                          key={assignment.id}
                          assignment={assignment}
                          judgement={data.relevance.find((r) => r.maintainer === assignment.maintainer)}
                        />
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    <ActionButtons
                      itemKey={itemKey}
                      assignmentId={mineOpen?.id ?? (mine && openAssignments.length === 0 ? mine.id : null)}
                      mode={
                        mineOpen
                          ? mineOpen.status === "acked"
                            ? "acked"
                            : "open"
                          : openAssignments.length === 0
                            ? mine
                              ? "closed"
                              : "unassigned"
                            : "others"
                      }
                      onDone={refresh}
                    />
                    {!mineOpen && openAssignments.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-zinc-500">You can reassign it; the other actions are for the owner.</p>
                    )}
                  </div>
                </div>
              </div>

              <Disclosure title="Score" meta={data.score ? `${data.score.score} points · ${data.score.breakdown.length} factors` : "not scored yet"} defaultOpen>
                {data.score ? (
                  <ScoreBreakdown
                    entries={data.score.breakdown}
                    score={data.score.score}
                    footer={
                      <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <Link href="/triage/scoring" className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50">
                          How is this scored?
                        </Link>
                        <span>scoring version {data.score.scoringVersion}</span>
                      </p>
                    }
                  />
                ) : (
                  <p className="text-xs text-zinc-500">Not scored yet: {extractionText(data.item.extractionStatus)}.</p>
                )}
              </Disclosure>

              {data.assignments.length > 0 && (
                <Disclosure title="Why these owners" meta="router reasons and evidence">
                  <ul className="space-y-3 text-xs">
                    {data.assignments.map((assignment) => (
                      <li key={assignment.id} className="space-y-1">
                        <p className="text-zinc-500">
                          <span className="font-medium text-zinc-800 dark:text-zinc-200">{assignment.maintainer}</span> ·{" "}
                          {assignment.role === "primary" ? "primary owner" : "backup"} · {STATUS_TEXT[assignment.status] ?? assignment.status} ·
                          assigned {assignment.assignedBy === "router" ? "by the router" : `by ${assignment.assignedBy}`}{" "}
                          {formatAge(assignment.assignedAt)} ago, when it scored {assignment.scoreAtAssign}
                        </p>
                        <WhyThisPerson
                          reason={assignment.reason}
                          judgement={data.relevance.find((r) => r.maintainer === assignment.maintainer)}
                        />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}

              {data.relevance.length > 0 && (
                <Disclosure
                  title="Who it's for"
                  meta={`${data.relevance.filter((r) => r.relevance === "high" || r.relevance === "medium").length} of ${data.relevance.length} maintainers relevant`}
                >
                  <p className="mb-2 text-xs text-zinc-500">
                    How well this matches each maintainer&apos;s recent work, judged by Claude from their last 6 months of PRs
                    and their notes. Only <b>high</b> and <b>medium</b> are routed; hover a level for what it means.
                  </p>
                  <ul className="space-y-2 text-xs">
                    {data.relevance.map((r) => (
                      <li key={r.maintainer} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <RelevanceBadge level={r.relevance} />
                          <span className="font-medium text-zinc-800 dark:text-zinc-200">{r.maintainer}</span>
                          {!r.current && (
                            <span className="text-[10px] text-amber-700 dark:text-amber-400">the item changed since; it will be judged again</span>
                          )}
                        </div>
                        {r.reason && <p className="text-zinc-600 dark:text-zinc-300">{r.reason}</p>}
                        <EvidenceList evidence={r.evidence} />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}

              <Disclosure
                title="What the LLM read"
                meta={data.extraction ? `${data.extraction.model} · ${formatAge(data.extraction.createdAt)} ago` : extractionText(data.item.extractionStatus)}
              >
                {data.extraction ? (
                  <>
                    <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                      The facts the LLM pulled out of the text. The score is computed from these; the LLM never picks the score.
                    </p>
                    <dl>
                      <Row label="Kind of item">{facets.type ? typeLabel(facets.type) : "—"}</Row>
                      <Row label="Models"><Chips kind="model" values={(facets.models ?? []).map((m) => m?.name ?? "").filter(Boolean)} max={10} /></Row>
                      <Row label="Model traits"><Chips values={(facets.model_traits ?? []).map(humanizeTag)} max={10} /></Row>
                      <Row label="Hardware"><Chips kind="hardware" values={facets.hardware ?? []} max={10} /></Row>
                      <Row label="Serving setup"><Chips kind="serving" values={(facets.serving ?? []).map(humanizeTag)} max={20} /></Row>
                      <Row label="Code areas"><Chips kind="area" values={(facets.areas ?? []).map(humanizeTag)} max={10} /></Row>
                      <Row label="Serving is broken">{yesNo(severity.serving_broken)}</Row>
                      <Row label="Crashes / hangs">{yesNo(severity.crash)} / {yesNo(severity.hang)}</Row>
                      <Row label="Wrong output">{yesNo(severity.wrong_output)}</Row>
                      <Row label="Slowdown">{severity.perf_regression_pct != null ? `${Math.abs(severity.perf_regression_pct)}% slower` : "none reported"}</Row>
                      <Row label="Uses more memory">{yesNo(severity.memory_regression)}</Row>
                      <Row label="Security problem">{yesNo(severity.security)}</Row>
                      <Row label="With default settings">{yesNo(facets.default_config)}</Row>
                      <Row label="Versions">
                        {facets.versions?.good || facets.versions?.bad
                          ? `worked in ${facets.versions?.good ?? "?"}, broken in ${facets.versions?.bad ?? "?"}`
                          : "not stated"}
                        {" · "}main: {yesNo(facets.versions?.affects_main)} · latest release: {yesNo(facets.versions?.affects_latest_release)}
                      </Row>
                      <Row label="Steps to reproduce">{yesNo(facets.has_repro)}</Row>
                      {facets.pr && (
                        <Row label="About the PR">
                          {[
                            facets.pr.fixes_issues?.length ? `fixes ${facets.pr.fixes_issues.map((n) => `#${n}`).join(", ")}` : "no linked issue",
                            facets.pr.size ? `${facets.pr.size.toUpperCase()} size` : null,
                            facets.pr.hot_path ? "touches code on every request" : null,
                            facets.pr.has_tests ? "has tests" : "no tests",
                            facets.pr.low_effort ? "looks low-effort" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Row>
                      )}
                      <Row label="Low-quality signals">
                        {(facets.slop_signals ?? []).length ? (facets.slop_signals ?? []).map(humanizeTag).join(", ") : "none"}
                      </Row>
                      <Row label="How sure the LLM is">{percentText(facets.confidence)}</Row>
                      {facets.notes && <Row label="LLM notes">{facets.notes}</Row>}
                      <Row label="Read by">{data.extraction.model} · prompt {data.extraction.promptVersion}</Row>
                    </dl>
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">
                    Not read yet: {extractionText(data.item.extractionStatus)}
                    {data.item.extractionError ? ` (${data.item.extractionError})` : ""}.
                  </p>
                )}
              </Disclosure>

              <Disclosure
                title="Quick signals (before the LLM)"
                meta={data.item.files.length > 0 ? `${data.item.files.length} changed files` : undefined}
              >
                <QuickSignals prepass={data.item.prepass} />
              </Disclosure>

              <Disclosure title="History" meta={data.actions.length ? `${data.actions.length} ${data.actions.length === 1 ? "action" : "actions"}` : "nothing yet"} defaultOpen={data.actions.length > 0}>
                {data.actions.length === 0 ? (
                  <p className="text-xs text-zinc-500">Nobody has acted on this yet.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {data.actions.map((action) => (
                      <li key={action.id}>
                        <span className="font-medium">{action.actor}</span> <span>{actionText(action.action, action.target)}</span>
                        <span className="text-zinc-500"> {sourceText(action.source)} · {formatAge(action.createdAt)} ago</span>
                        {action.note && <p className="text-zinc-600 dark:text-zinc-400">{action.note}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Disclosure>
              <div className="h-6" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
