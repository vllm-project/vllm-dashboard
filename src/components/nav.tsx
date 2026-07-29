"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

export function Nav() {
  const pathname = usePathname();
  const mobileNavRef = useRef<HTMLDivElement>(null);

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
