"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { preload } from "swr";
import { ThemeToggle } from "@/components/theme-toggle";

const links = [
  { href: "/", label: "Builds" },
  { href: "/jobs", label: "Jobs" },
  { href: "/nightly", label: "Nightly" },
  { href: "/queue", label: "Queue" },
  { href: "/gpu", label: "GPU" },
  { href: "/cost", label: "Cost" },
  { href: "/perf", label: "Performance" },
  { href: "/eval", label: "Evaluation" },
  { href: "/compare", label: "Compare" },
];

const prefetchedRoutes = new Set<string>();
const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to prefetch ${url}: ${response.status}`);
  }
  return response.json();
};

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function defaultDataUrls(href: string): string[] {
  const startDate = isoDateDaysAgo(14);
  const endDate = isoDateDaysAgo(0);
  const buildParams =
    `pipeline=CI&branch=main&startDate=${startDate}&endDate=${endDate}`;

  switch (href) {
    case "/":
      return [
        `/api/builds?${buildParams}&page=0`,
        "/api/builds/filters",
      ];
    case "/jobs":
      return [
        `/api/jobs?${buildParams}`,
        "/api/builds/filters",
      ];
    case "/nightly":
      return ["/api/nightly"];
    case "/queue":
      return [
        "/api/metrics?hours=24&queue=gpu_1_queue",
        "/api/metrics/waiting-builds?queue=gpu_1_queue",
      ];
    case "/cost":
      return [
        `/api/cost?pipeline=CI&startDate=${startDate}&endDate=${endDate}`,
        "/api/builds/filters",
      ];
    case "/perf":
      return ["/api/perf/filters?start=2026-06-14"];
    case "/eval":
      return ["/api/eval/filters", "/api/eval"];
    case "/compare":
      return [
        "/api/perf/filters",
        "/api/eval/filters",
      ];
    default:
      return [];
  }
}

export function Nav() {
  const pathname = usePathname();
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const prefetchTimerRef = useRef<number | null>(null);

  function prefetchRouteData(href: string) {
    if (prefetchedRoutes.has(href)) return;
    prefetchedRoutes.add(href);
    const requests = defaultDataUrls(href).map(async (url) => {
      const data = await preload(url, fetcher);
      if (href === "/" && url.startsWith("/api/builds?")) {
        const buildIds = (
          data as { builds?: Array<{ id?: string }> }
        ).builds
          ?.map((build) => build.id)
          .filter((id): id is string => Boolean(id));
        if (buildIds?.length) {
          const groupsUrl =
            `/api/builds/groups?buildIds=${encodeURIComponent(buildIds.join(","))}`;
          await preload(groupsUrl, fetcher);
        }
      }
      if (href === "/perf" && url.startsWith("/api/perf/filters?")) {
        const defaultModel = (
          data as { models?: string[] }
        ).models?.[0];
        if (defaultModel) {
          const start = new URL(url, window.location.origin).searchParams.get(
            "start",
          );
          const perfUrl =
            `/api/perf?model=${encodeURIComponent(defaultModel)}` +
            (start ? `&start=${encodeURIComponent(start)}` : "");
          await preload(perfUrl, fetcher);
        }
      }
      return data;
    });
    void Promise.all(requests).catch(() => {
      prefetchedRoutes.delete(href);
    });
  }

  function scheduleRoutePrefetch(href: string) {
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
    }
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      prefetchRouteData(href);
    }, 100);
  }

  function cancelScheduledPrefetch() {
    if (prefetchTimerRef.current === null) return;
    window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  }

  useEffect(() => {
    const container = mobileNavRef.current;
    const activeLink = mobileNavRef.current?.querySelector<HTMLElement>(
      '[aria-current="page"]',
    );
    if (!container || !activeLink) return;

    const leftEdge = activeLink.offsetLeft;
    const rightEdge = leftEdge + activeLink.offsetWidth;
    if (leftEdge < container.scrollLeft) {
      container.scrollLeft = Math.max(0, leftEdge - 16);
    } else if (rightEdge > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = rightEdge - container.clientWidth + 16;
    }
  }, [pathname]);

  useEffect(
    () => () => {
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
      }
    },
    [],
  );

  function isActive(href: string): boolean {
    return href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="dashboard-nav sticky top-0 z-50 border-b border-black/5 shadow-[0_1px_0_rgba(0,0,0,0.02)] dark:border-white/10">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center gap-6">
          <Link
            href="/"
            className="shrink-0 whitespace-nowrap text-base font-semibold tracking-[-0.02em] sm:text-lg"
          >
            vLLM Dashboard
          </Link>
          <div className="hidden min-w-0 flex-1 items-center gap-1 lg:flex">
            {links.map((link) => {
              const active = isActive(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  onPointerEnter={() => scheduleRoutePrefetch(link.href)}
                  onPointerLeave={cancelScheduledPrefetch}
                  onFocus={() => prefetchRouteData(link.href)}
                  onPointerDown={() => prefetchRouteData(link.href)}
                  className={`dashboard-control inline-flex min-h-10 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium ${
                    active
                      ? "bg-zinc-950/[0.06] text-zinc-950 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:text-zinc-50 dark:ring-white/10"
                      : "text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
          <div className="ml-auto shrink-0">
            <ThemeToggle />
          </div>
        </div>
        <div
          ref={mobileNavRef}
          className="scrollbar-hidden -mx-4 flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden"
          aria-label="Dashboard sections"
        >
          {links.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                onPointerEnter={() => scheduleRoutePrefetch(link.href)}
                onPointerLeave={cancelScheduledPrefetch}
                onFocus={() => prefetchRouteData(link.href)}
                onPointerDown={() => prefetchRouteData(link.href)}
                className={`inline-flex min-h-11 shrink-0 items-center rounded-md px-3 py-2 text-sm font-medium ${
                  active
                    ? "bg-zinc-950/[0.07] text-zinc-950 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:text-zinc-50 dark:ring-white/10"
                    : "text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
