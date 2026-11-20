"use client";

import {
  CI_JOBS_SHOWN,
  MAIN_RECENT_DAYS,
  ciBadge,
  ciLine,
  ciWaitsOnAuthor,
  jobLabel,
  safeBuildkiteUrl,
  type CiTone,
  type TriageCi,
} from "@/lib/triage-ci";
import { formatAge } from "@/lib/triage-format";

const TONE: Record<CiTone, string> = {
  pass: "text-emerald-700 ring-emerald-300 dark:text-emerald-400 dark:ring-emerald-800",
  fail: "text-red-700 ring-red-300 dark:text-red-400 dark:ring-red-800",
  main: "text-amber-700 ring-amber-300 dark:text-amber-400 dark:ring-amber-800",
  running: "text-sky-700 ring-sky-300 dark:text-sky-400 dark:ring-sky-800",
  idle: "text-zinc-500 ring-zinc-300 dark:text-zinc-400 dark:ring-zinc-700",
};

/** Compact CI pill for queue and My list rows. Amber: every failure also fails on main. */
export function CiBadge({ ci }: { ci: TriageCi | null | undefined }) {
  if (!ci) return null;
  const badge = ciBadge(ci);
  return (
    <span
      title={badge.title}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[11px] font-medium leading-4 tabular-nums ring-1 ring-inset ${TONE[badge.tone]}`}
    >
      {badge.label}
    </span>
  );
}

const SHORT_SHA = 8;

function BuildkiteLink({ href, title, children }: { href: string | null; title?: string; children: React.ReactNode }) {
  const safe = safeBuildkiteUrl(href);
  if (!safe) return <span title={title}>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={title}
      className="text-zinc-950 underline-offset-2 hover:underline dark:text-zinc-50"
    >
      {children}
    </a>
  );
}

/** The drawer's CI section: state, counts, and the failed jobs linked to Buildkite. */
export function CiSection({ ci }: { ci: TriageCi }) {
  const shown = ci.failed_jobs.slice(0, CI_JOBS_SHOWN);
  const more = ci.jobs_failed - shown.reduce((n, job) => n + job.count, 0);
  const authors = ciWaitsOnAuthor(ci);
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <CiBadge ci={ci} />
        <span className="text-zinc-800 dark:text-zinc-200">{ciLine(ci)}</span>
      </div>
      {ci.state === "failed" && ci.main_known && (
        <p className="text-zinc-500 dark:text-zinc-400">
          {authors
            ? "Some failures don't happen on main, so fixing them is the author's move."
            : ci.jobs_failed_on_main + ci.jobs_failed_recent_on_main > 0
              ? `Every failure is also failing on main, or failed there in the last ${MAIN_RECENT_DAYS} days: not this PR's doing.`
              : "The failures look like infrastructure (lost agents), not this PR."}
        </p>
      )}
      {ci.state === "failed" && !ci.main_known && (
        <p className="text-zinc-500 dark:text-zinc-400">
          {"Main CI's job states weren't available, so it can't say which failures main shares."}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="space-y-1">
          {shown.map((job) => (
            <li key={job.key} className="flex flex-wrap items-baseline gap-x-2">
              <span aria-hidden="true" className={job.on_main || job.recent_on_main ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}>
                ✗
              </span>
              <BuildkiteLink href={job.url} title={job.name}>
                {jobLabel(job.name)}
              </BuildkiteLink>
              {job.count > 1 && <span className="text-zinc-500">×{job.count}</span>}
              <span className="text-zinc-500 dark:text-zinc-400">
                {job.on_main
                  ? "also failing on main"
                  : job.recent_on_main
                    ? `failed on main in the last ${MAIN_RECENT_DAYS} days`
                    : job.infra
                      ? "lost its agent"
                      : job.on_main === false
                        ? "only on this PR"
                        : ""}
              </span>
            </li>
          ))}
          {more > 0 && <li className="text-zinc-500">…and {more} more failed</li>}
        </ul>
      )}
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
        {ci.build_number ? (
          <BuildkiteLink href={ci.build_url}>Buildkite build #{ci.build_number}</BuildkiteLink>
        ) : (
          "No Buildkite build"
        )}{" "}
        for commit <code>{ci.head_sha.slice(0, SHORT_SHA)}</code>
        {ci.checked_at && <> · checked {formatAge(ci.checked_at)} ago</>}
      </p>
    </div>
  );
}
