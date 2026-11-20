"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { isUnrouted, priorityLabel } from "@/lib/triage-style";
import { ActionButtons } from "@/components/triage/action-buttons";
import { Kbd, ShortcutHelp } from "@/components/triage/keyboard-help";
import { drawerCommand } from "@/lib/triage-keys";
import { safeGithubUrl } from "@/lib/triage-query";
import type { TriageAction } from "@/lib/triage-vocab";
import { CiSection } from "@/components/triage/ci-status";
import { ciLine } from "@/lib/triage-ci";
import { ScoreBreakdown } from "@/components/triage/score-breakdown";
import { humanizeTag } from "@/lib/triage-factors";
import { actionText, extractionText, percentText, scopeText, sourceText } from "@/lib/triage-words";
import { llmFacts, visibleFacts, type LlmFact } from "@/lib/triage-facts";
import { fileDiffAnchor, prFilesUrl, summarizeFiles } from "@/lib/triage-files";
import { describeReason, formatAge, triageFetcher } from "@/lib/triage-format";
import { linkLabel } from "@/lib/triage-groups";
import { kindHeading } from "@/lib/triage-rows";
import type { TriageAssignment, TriageFacets, TriageItemDetail, TriageLinkedItem, TriageRelevance } from "@/lib/triage-types";
import { waitingReasonsText, type WhyUnowned } from "@/lib/triage-why-unowned";

/** A collapsible detail section; the summary at the top of the drawer stays open. */
function Disclosure({
  title,
  meta,
  defaultOpen = false,
  open,
  onToggle,
  id,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  /** Controlled open state (with onToggle); otherwise `defaultOpen`. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={open ?? defaultOpen}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      className="group scroll-mt-2 border-t border-zinc-200 dark:border-zinc-800"
    >
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
/**
 * Its issue + fix PR group (triage/groups.py): "Fixes #65385" on a PR,
 * "Fixed by #67812 (merged)" on an issue, each with its title and owner.
 */
function GroupPanel({ kind, links }: { kind: "issue" | "pr"; links: TriageLinkedItem[] }) {
  if (links.length === 0) return null;
  const verb = kind === "pr" ? "Fixes" : "Fixed by";
  return (
    <ul className="space-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800" aria-label={verb}>
      {links.map((link) => (
        <li key={link.itemKey} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-200">
            {verb}{" "}
            <GithubLink href={link.htmlUrl} title={link.title}>
              {linkLabel(link)}
            </GithubLink>
          </span>
          <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">{link.title}</span>
          {link.owner && <span className="text-xs text-zinc-500 dark:text-zinc-400">· {link.owner}</span>}
        </li>
      ))}
    </ul>
  );
}

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
        {prepass.waiting_on && (
          <Row label="Whose move">
            {prepass.waiting_on === "author"
              ? `The author's${waitingReasonsText(prepass) ? `: ${waitingReasonsText(prepass)}` : ""}`
              : "The reviewers'"}
          </Row>
        )}
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

/** "4 files · +18 −4" and the first paths, each linking into the PR's diff. */
function ChangedFiles({ files, htmlUrl }: { files: unknown; htmlUrl: string }) {
  const summary = summarizeFiles(files);
  const filesUrl = prFilesUrl(htmlUrl);
  const [anchors, setAnchors] = useState<Record<string, string>>({});
  const paths = summary.shown.map((file) => file.path).join("\n");
  useEffect(() => {
    if (!filesUrl) return;
    let cancelled = false;
    void Promise.all(paths.split("\n").map(async (path) => [path, await fileDiffAnchor(path)] as const)).then((pairs) => {
      if (cancelled) return;
      setAnchors(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [paths, filesUrl]);
  if (summary.count === 0) return null;
  return (
    <div className="border-t border-zinc-200 py-3 dark:border-zinc-800">
      <p className="mb-1.5 flex items-baseline gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
        Files
        {filesUrl ? (
          <a
            href={filesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium normal-case tracking-normal text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {summary.line} ↗
          </a>
        ) : (
          <span className="font-medium normal-case tracking-normal">{summary.line}</span>
        )}
      </p>
      <ul className="space-y-px" aria-label="Changed files">
        {summary.shown.map((file) => {
          const href = filesUrl ? `${filesUrl}${anchors[file.path] ? `#${anchors[file.path]}` : ""}` : null;
          return (
            <li key={file.path} className="flex min-w-0 items-baseline gap-2 text-xs">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={file.path}
                  className="min-w-0 truncate font-mono text-[11px] text-zinc-700 underline-offset-2 hover:text-zinc-950 hover:underline dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  {file.path}
                </a>
              ) : (
                <span title={file.path} className="min-w-0 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                  {file.path}
                </span>
              )}
              {(file.additions !== null || file.deletions !== null) && (
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                  +{file.additions ?? 0} −{file.deletions ?? 0}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {summary.more > 0 && (
        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {filesUrl ? (
            <a href={filesUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
              +{summary.more}{summary.capped ? "+" : ""} more on GitHub
            </a>
          ) : (
            `+${summary.more} more`
          )}
        </p>
      )}
    </div>
  );
}

function FactValue({ fact, full }: { fact: LlmFact; full: boolean }) {
  if (fact.chips) return <Chips kind={fact.chips.kind} values={fact.chips.values} max={fact.chips.kind === "serving" ? 20 : 10} />;
  return <>{full ? (fact.fullText ?? fact.text) : fact.text}</>;
}

/** The LLM's facts: only what it found (a crash, a model…); every field one click away. */
function LlmFactsList({ facets, readBy }: { facets: TriageFacets; readBy: string }) {
  const [showAll, setShowAll] = useState(false);
  const facts = llmFacts(facets);
  const shown = visibleFacts(facts, showAll);
  const hidden = facts.length - facts.filter((fact) => fact.present).length;
  return (
    <>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        The facts the LLM pulled out of the text. The score is computed from these; the LLM never picks the score.
      </p>
      {shown.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Nothing notable: no crash, slowdown, models or hardware reported.</p>
      ) : (
        <dl>
          {shown.map((fact) => (
            <Row key={fact.key} label={fact.label}>
              <span className={fact.present ? "" : "text-zinc-400 dark:text-zinc-500"}>
                <FactValue fact={fact} full={showAll} />
              </span>
            </Row>
          ))}
        </dl>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Read by {readBy}</span>
        {hidden > 0 && (
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setShowAll((value) => !value)}
            className="dashboard-control rounded font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            {showAll ? "Show only what was found" : `Show all fields (${hidden} empty)`}
          </button>
        )}
      </p>
    </>
  );
}

const SCORE_OPEN_KEY = "triage.drawer.scoreOpen";

/** The Score section's open state, remembered in this browser (closed by default). */
function useRememberedOpen(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount; storage isn't available during SSR
      setOpen(window.localStorage.getItem(key) === "1");
    } catch {
      // storage blocked: stay closed
    }
  }, [key]);
  const set = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [open, set];
}

/** Previous / next in the list behind the drawer (j / k). */
export interface DrawerNav {
  /** Zero-based position in the list, or null when the item isn't in it. */
  position: { index: number; total: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

const HEADER_BUTTON =
  "dashboard-control inline-flex h-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

export function ItemDrawer({
  itemKey,
  viewer,
  onClose,
  onChanged,
  nav,
  onActed,
}: {
  itemKey: string;
  viewer: string | null;
  onClose: () => void;
  onChanged?: () => void;
  nav?: DrawerNav;
  /** After an action from the drawer succeeds (My list moves on to the next item). */
  onActed?: (action: TriageAction, alsoApplied: readonly string[]) => void;
}) {
  const { data, error, mutate } = useSWR<TriageItemDetail>(
    `/api/triage/items/detail?key=${encodeURIComponent(itemKey)}`,
    triageFetcher,
  );
  const [scoreOpen, setScoreOpen] = useRememberedOpen(SCORE_OPEN_KEY);
  const [helpOpen, setHelpOpen] = useState(false);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const scroller = useRef<HTMLDivElement>(null);
  const [repo, number] = itemKey.split("#");
  const githubUrl = safeGithubUrl(data?.item.htmlUrl ?? `https://github.com/${repo}/issues/${number}`);

  function showScore() {
    setScoreOpen(true);
    window.requestAnimationFrame(() => document.getElementById("triage-drawer-score")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  // A new item starts at the top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [itemKey]);

  // Latest handlers for the key listener without re-subscribing every render.
  const keyState = useRef({ onClose, nav, githubUrl, helpOpen });
  useEffect(() => {
    keyState.current = { onClose, nav, githubUrl, helpOpen };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { onClose: close, nav: current, githubUrl: url, helpOpen: help } = keyState.current;
      if (help) return; // the overlay handles its own keys
      switch (drawerCommand(event)) {
        case "close":
          close();
          break;
        case "next":
          if (current?.onNext) {
            event.preventDefault();
            current.onNext();
          }
          break;
        case "prev":
          if (current?.onPrev) {
            event.preventDefault();
            current.onPrev();
          }
          break;
        case "github":
          if (url) {
            event.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
          }
          break;
        case "help":
          event.preventDefault();
          setHelpOpen(true);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const facets = data?.extraction?.facets ?? {};
  const openAssignments = data?.assignments.filter((a) => a.status === "open" || a.status === "acked") ?? [];
  const owners = [...openAssignments].sort((a, b) => (a.role === b.role ? 0 : a.role === "primary" ? -1 : 1));
  const mine = viewer
    ? data?.assignments.find(
        (a) => a.maintainer.toLowerCase() === viewer.toLowerCase(),
      )
    : undefined;
  const mineOpen = mine && (mine.status === "open" || mine.status === "acked") ? mine : undefined;
  const band = data?.score?.band ?? null;

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
            <button
              type="button"
              onClick={showScore}
              aria-controls="triage-drawer-score"
              className="dashboard-control rounded text-sm tabular-nums text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300"
              title="Show the score breakdown"
            >
              score <span className="font-semibold text-zinc-900 dark:text-zinc-100">{data.score.score}</span>
            </button>
          )}
          <span className="ml-1 hidden items-center gap-1.5 text-xs font-medium text-zinc-600 sm:inline-flex dark:text-zinc-300">
            {data && <KindIcon kind={data.item.kind} draft={data.item.draft} state={data.item.state} />}
            {data ? kindHeading(data.item.kind, number) : `#${number}`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {nav && (
              <div className="flex items-center" role="group" aria-label="Move through the list">
                <button
                  type="button"
                  onClick={() => nav.onPrev?.()}
                  disabled={!nav.onPrev}
                  className={`${HEADER_BUTTON} w-8`}
                  aria-label="Previous item (k)"
                  title="Previous item (k)"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 3.5L5.5 8l4.5 4.5" />
                  </svg>
                </button>
                {nav.position && (
                  <span className="min-w-[3.5rem] text-center text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400" aria-live="polite">
                    {nav.position.index + 1} / {nav.position.total}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => nav.onNext?.()}
                  disabled={!nav.onNext}
                  className={`${HEADER_BUTTON} w-8`}
                  aria-label="Next item (j)"
                  title="Next item (j)"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 3.5L10.5 8 6 12.5" />
                  </svg>
                </button>
              </div>
            )}
            {githubUrl && (
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title="Open on GitHub (o)"
                className="dashboard-control inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Open on GitHub <span aria-hidden="true">↗</span>
                <Kbd className="hidden sm:inline-flex">o</Kbd>
              </a>
            )}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className={`${HEADER_BUTTON} w-8 text-sm font-semibold`}
              aria-label="Keyboard shortcuts (?)"
              title="Keyboard shortcuts (?)"
            >
              ?
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="dashboard-control inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto px-5">
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
                <GroupPanel kind={data.item.kind} links={data.item.kind === "pr" ? data.fixes : data.fixedBy} />

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
                      key={itemKey}
                      keyboard={!helpOpen}
                      onActed={onActed}
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
                      relevance={data.relevance}
                      owners={openAssignments.map((assignment) => assignment.maintainer)}
                    />
                    {!mineOpen && openAssignments.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-zinc-500">You can reassign it; the other actions are for the owner.</p>
                    )}
                    {data.item.kind === "issue" && data.fixedBy.some((link) => link.state === "open") && (
                      <p className="mt-1.5 text-[11px] text-zinc-500">
                        Ack, Not mine, Done and Reassign here also apply to its fix PRs held by the same person.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {data.ci && (
                <Disclosure title="CI" meta={ciLine(data.ci)} defaultOpen={data.item.state === "open"}>
                  <CiSection ci={data.ci} />
                </Disclosure>
              )}

              <ChangedFiles files={data.item.files} htmlUrl={data.item.htmlUrl} />

              <Disclosure
                id="triage-drawer-score"
                title="Score"
                meta={data.score ? `${data.score.score} points · ${data.score.breakdown.length} factors` : "not scored yet"}
                open={scoreOpen}
                onToggle={setScoreOpen}
              >
                {data.score ? (
                  <ScoreBreakdown
                    entries={data.score.breakdown}
                    score={data.score.score}
                    footer={
                      <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <Link href="/triage/scoring" className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50">
                          How scoring works
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
                  <LlmFactsList
                    facets={facets}
                    readBy={`${data.extraction.model} · prompt ${data.extraction.promptVersion}${
                      typeof facets.confidence === "number" ? ` · ${percentText(facets.confidence)} sure` : ""
                    }`}
                  />
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
                      <li key={action.id} className={action.undoneAt ? "text-zinc-400 dark:text-zinc-500" : undefined}>
                        <span className="font-medium">{action.actor}</span>{" "}
                        <span className={action.undoneAt ? "line-through" : undefined}>{actionText(action.action, action.target)}</span>
                        <span className="text-zinc-500"> {sourceText(action.source)} · {formatAge(action.createdAt)} ago</span>
                        {action.undoneAt && <span className="text-zinc-500"> · undone</span>}
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
      {helpOpen && <ShortcutHelp onClose={closeHelp} />}
    </div>
  );
}
