"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  isNavGroup,
  type DashboardNavItem,
  routeMatches,
  sectionForPathname,
} from "@/lib/dashboard-navigation";

export function SectionNav() {
  const pathname = usePathname();
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
        <nav
          aria-label={`${section.label} views`}
          className="scrollbar-hidden -mb-px flex gap-6 overflow-x-auto"
        >
          {section.links.map((entry) => {
            const group = isNavGroup(entry) ? entry : null;
            const href = group ? group.links[0].href : (entry as DashboardNavItem).href;
            const active = group ? group === activeGroup : routeMatches(pathname, href);
            return (
              <Link
                key={entry.label}
                href={href}
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
                href={link.href}
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
    </div>
  );
}
