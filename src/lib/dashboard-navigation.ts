export interface DashboardNavItem {
  href: string;
  label: string;
  /** Active only on this exact path, not on its sub-paths. */
  exact?: boolean;
}

/** A section tab that opens a row of its own tabs (e.g. Health → Metrics). */
export interface DashboardNavGroup {
  label: string;
  links: readonly DashboardNavItem[];
}

export type DashboardNavEntry = DashboardNavItem | DashboardNavGroup;

export interface DashboardSection {
  href: string;
  label: string;
  description: string;
  links: readonly DashboardNavEntry[];
}

export function isNavGroup(entry: DashboardNavEntry): entry is DashboardNavGroup {
  return "links" in entry;
}

/** Every page a section links to, groups flattened, in order. */
export function sectionPages(section: DashboardSection): DashboardNavItem[] {
  return section.links.flatMap((entry) =>
    isNavGroup(entry) ? [...entry.links] : [entry],
  );
}

export const DASHBOARD_SECTIONS = [
  {
    href: "/",
    label: "Health",
    description:
      "Build outcomes, job runs, test reliability, runner queues, alert history, and CI metrics.",
    links: [
      { href: "/", label: "Builds" },
      { href: "/jobs", label: "Jobs" },
      { href: "/tests", label: "Tests" },
      { href: "/queue", label: "Runner Queue" },
      { href: "/alerts", label: "Alerts" },
      {
        label: "Metrics",
        links: [
          { href: "/platforms", label: "Platform Scope" },
          { href: "/force-merges", label: "Force-merges" },
          { href: "/sharding", label: "Automatic sharding" },
          { href: "/selector", label: "CI Selector" },
        ],
      },
    ],
  },
  {
    href: "/gpu",
    label: "Infra",
    description: "GPU fleet capacity, utilization, and infrastructure cost.",
    links: [
      { href: "/gpu", label: "GPU" },
      { href: "/cost", label: "Cost" },
    ],
  },
  {
    href: "/perf",
    label: "Perf Eval",
    description:
      "Nightly performance benchmarks, model accuracy evaluations, and side-by-side image comparisons.",
    links: [
      { href: "/perf", label: "Performance" },
      { href: "/eval", label: "Evaluation" },
      { href: "/compare", label: "Compare" },
    ],
  },
] as const satisfies readonly DashboardSection[];

/**
 * Maintainers-only issue/PR triage. Its routes always resolve to this section
 * (so the section tabs render), but the top-level nav shows it only when the
 * build sets NEXT_PUBLIC_TRIAGE_ENABLED=1; the pages themselves are gated by
 * TRIAGE_ENABLED and a GitHub sign-in.
 */
export const TRIAGE_SECTION = {
  href: "/triage",
  label: "Triage",
  description:
    "Incoming vLLM issues and PRs, scored by impact and routed to maintainers.",
  links: [
    { href: "/triage", label: "Queue", exact: true },
    { href: "/triage/me", label: "My plate" },
    { href: "/triage/rules", label: "Rules" },
  ],
} as const satisfies DashboardSection;

export const TRIAGE_NAV_ENABLED = process.env.NEXT_PUBLIC_TRIAGE_ENABLED === "1";

const ALL_SECTIONS: readonly DashboardSection[] = [...DASHBOARD_SECTIONS, TRIAGE_SECTION];

export const TOP_LEVEL_NAV_ITEMS = (
  TRIAGE_NAV_ENABLED ? ALL_SECTIONS : DASHBOARD_SECTIONS
).map((section) => ({
  href: section.href,
  label: section.label,
  routes: sectionPages(section).map((link) => link.href),
}));

/** Whether a section link is the current page, honouring `exact`. */
export function navItemActive(pathname: string, link: DashboardNavItem): boolean {
  return link.exact ? pathname === link.href : routeMatches(pathname, link.href);
}

export function routeMatches(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function sectionForPathname(
  pathname: string,
): DashboardSection | undefined {
  return ALL_SECTIONS.find((section) =>
    sectionPages(section).some((link) => routeMatches(pathname, link.href)),
  );
}
