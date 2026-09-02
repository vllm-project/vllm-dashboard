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

export const DASHBOARD_SECTIONS = [
  {
    href: "/",
    label: "CI Health",
    description:
      "Build outcomes, job runs, queue health, test reliability, and alert history.",
    links: [
      { href: "/", label: "Builds" },
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
] as const satisfies readonly DashboardSection[];

export const TOP_LEVEL_NAV_ITEMS = [
  ...DASHBOARD_SECTIONS.map((section) => ({
    href: section.href,
    label: section.label,
    routes: section.links.map((link) => link.href),
  })),
  { href: "/perf", label: "Performance", routes: ["/perf"] },
  { href: "/eval", label: "Evaluation", routes: ["/eval"] },
  { href: "/compare", label: "Compare", routes: ["/compare"] },
];

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
