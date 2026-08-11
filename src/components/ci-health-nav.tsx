"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Builds" },
  { href: "/jobs", label: "Jobs" },
  { href: "/queue", label: "Queue" },
];

const ciHealthRoutes = new Set(links.map((link) => link.href));

export function CiHealthNav() {
  const pathname = usePathname();

  if (!ciHealthRoutes.has(pathname)) return null;

  return (
    <div className="mb-6 border-b border-zinc-200 dark:border-zinc-800">
      <div className="mb-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
          CI Health
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Build outcomes, job runs, and queue health in one operational view.
        </p>
      </div>
      <nav
        aria-label="CI Health views"
        className="scrollbar-hidden -mb-px flex gap-6 overflow-x-auto"
      >
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`dashboard-control inline-flex min-h-11 shrink-0 items-center border-b-2 text-xs font-semibold sm:min-h-10 ${
                active
                  ? "border-zinc-950 text-zinc-950 dark:border-zinc-50 dark:text-zinc-50"
                  : "border-transparent text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
