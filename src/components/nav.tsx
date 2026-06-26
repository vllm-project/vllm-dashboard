"use client";

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

  return (
    <nav className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          vLLM Dashboard
        </Link>
        <div className="flex gap-1">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
