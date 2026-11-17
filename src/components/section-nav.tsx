"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_PIPELINE, pipelineHref, pipelineScopeNote } from "@/lib/pipeline-navigation";
import { usePipeline } from "@/lib/use-pipeline";
import {
  isNavGroup,
  navItemActive,
  type DashboardNavItem,
  routeMatches,
  sectionForPathname,
} from "@/lib/dashboard-navigation";

export const SECTION_NAV_ACTIONS_ID = "section-nav-actions";

export function SectionNav() {
  return <Suspense><SectionNavContent /></Suspense>;
}

function SectionNavContent() {
  const pathname = usePathname();
  const pipeline = usePipeline();
  const scopeNote = pipeline !== DEFAULT_PIPELINE ? pipelineScopeNote(pathname) : null;
  const section = sectionForPathname(pathname);

  if (!section) return null;

  // A group tab (e.g. Metrics) opens its first page and stays active on any of
  // its pages, which then get a row of their own below the section tabs.
  const activeGroup = section.links
    .filter(isNavGroup)
    .find((group) => group.links.some((link) => routeMatches(pathname, link.href)));

  return (
    <div className="mb-6">
      <div className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mb-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
            {section.label}
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {section.description}
          </p>
        </div>
        <div className="flex items-end gap-4">
        <nav
          aria-label={`${section.label} views`}
          className="scrollbar-hidden -mb-px flex min-w-0 flex-1 gap-6 overflow-x-auto"
        >
          {section.links.map((entry) => {
            const group = isNavGroup(entry) ? entry : null;
            const href = group ? group.links[0].href : (entry as DashboardNavItem).href;
            const active = group
              ? group === activeGroup
              : navItemActive(pathname, entry as DashboardNavItem);
            return (
              <Link
                key={entry.label}
                href={pipelineHref(href, pipeline)}
                aria-current={active ? (group ? "true" : "page") : undefined}
                className={`dashboard-control inline-flex min-h-11 shrink-0 items-center border-b-2 text-xs font-semibold sm:min-h-10 ${
                  active
                    ? "border-zinc-950 text-zinc-950 dark:border-zinc-50 dark:text-zinc-50"
                    : "border-transparent text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
                }`}
              >
                {entry.label}
              </Link>
            );
          })}
        </nav>
          {/* Pages can portal right-aligned controls into the tab row (e.g. the triage account). */}
          <div id={SECTION_NAV_ACTIONS_ID} className="flex shrink-0 items-center pb-1.5 empty:hidden" />
        </div>
      </div>
      {activeGroup && (
        <nav
          aria-label={`${activeGroup.label} views`}
          className="scrollbar-hidden mt-3 flex gap-1.5 overflow-x-auto"
        >
          {activeGroup.links.map((link) => {
            const active = routeMatches(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={pipelineHref(link.href, pipeline)}
                aria-current={active ? "page" : undefined}
                className={`dashboard-control inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-xs font-medium sm:min-h-8 ${
                  active
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      )}
      {scopeNote && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{scopeNote}</p>
      )}
    </div>
  );
}
