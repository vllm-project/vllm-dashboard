export interface DashboardNavItem {
  href: string;
  label: string;
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
          { href: "/parity", label: "AMD Parity" },
          { href: "/force-merges", label: "Force-merges" },
          { href: "/sharding", label: "Automatic sharding" },
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

export const TOP_LEVEL_NAV_ITEMS = DASHBOARD_SECTIONS.map((section) => ({
  href: section.href,
  label: section.label,
  routes: sectionPages(section).map((link) => link.href),
}));

export function routeMatches(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function sectionForPathname(
  pathname: string,
): DashboardSection | undefined {
  return DASHBOARD_SECTIONS.find((section) =>
    sectionPages(section).some((link) => routeMatches(pathname, link.href)),
  );
}
