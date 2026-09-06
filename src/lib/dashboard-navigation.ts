export interface DashboardNavItem {
  href: string;
  label: string;
}

export interface DashboardSection {
  href: string;
  label: string;
  description: string;
  links: readonly DashboardNavItem[];
}

/**
 * The information architecture. Three sections, each with a small set of
 * views, plus the Overview home. Routes are stable; only grouping lives here.
 */
export const DASHBOARD_SECTIONS = [
  {
    href: "/builds",
    label: "CI Health",
    description:
      "Build outcomes, job runs, queue health, test reliability, and alert history.",
    links: [
      { href: "/builds", label: "Builds" },
      { href: "/jobs", label: "Jobs" },
      { href: "/queue", label: "Queue" },
      { href: "/tests", label: "Tests" },
      { href: "/alerts", label: "Alerts" },
    ],
  },
  {
    href: "/gpu",
    label: "Infrastructure",
    description: "GPU fleet capacity, utilization, and infrastructure cost.",
    links: [
      { href: "/gpu", label: "GPU" },
      { href: "/cost", label: "Cost" },
    ],
  },
  {
    href: "/perf",
    label: "Benchmarks",
    description:
      "Performance trends, throughput-latency frontiers, accuracy evaluations, and image comparison.",
    links: [
      { href: "/perf", label: "Trends" },
      { href: "/perf/benchmarks", label: "Frontier" },
      { href: "/eval", label: "Accuracy" },
      { href: "/compare", label: "Compare" },
    ],
  },
] as const satisfies readonly DashboardSection[];

export const OVERVIEW_NAV_ITEM = {
  href: "/",
  label: "Overview",
  routes: ["/"],
} as const;

export const TOP_LEVEL_NAV_ITEMS = [
  OVERVIEW_NAV_ITEM,
  ...DASHBOARD_SECTIONS.map((section) => ({
    href: section.href,
    label: section.label,
    routes: section.links.map((link) => link.href),
  })),
];

/** True when `pathname` is `href` or a route nested under it. */
export function routeMatches(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function sectionForPathname(
  pathname: string,
): (typeof DASHBOARD_SECTIONS)[number] | undefined {
  return DASHBOARD_SECTIONS.find((section) =>
    section.links.some((link) => routeMatches(pathname, link.href)),
  );
}

/**
 * The single active link within a section: the longest matching href wins,
 * so `/perf/benchmarks` activates Frontier rather than Trends.
 */
export function activeLinkForPathname(
  section: DashboardSection,
  pathname: string,
): DashboardNavItem | undefined {
  return [...section.links]
    .filter((link) => routeMatches(pathname, link.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
