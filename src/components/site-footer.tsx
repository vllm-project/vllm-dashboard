import { VllmMark } from "@/components/vllm-logo";

const FOOTER_LINKS = [
  { href: "https://docs.vllm.ai", label: "Docs" },
  { href: "https://github.com/vllm-project/vllm", label: "GitHub" },
  { href: "https://buildkite.com/vllm", label: "Buildkite" },
  { href: "https://github.com/vllm-project/vllm-dashboard", label: "Dashboard source" },
] as const;

export function SiteFooter() {
  return (
    <footer className="relative mt-16 overflow-hidden border-t border-black/5 dark:border-white/10">
      {/* Oversized, very faint mark as a background flourish. */}
      <VllmMark
        shadow={false}
        className="pointer-events-none absolute -right-8 -top-10 h-56 w-56 opacity-[0.06] sm:-right-4 sm:h-72 sm:w-72 dark:opacity-[0.08]"
      />
      <div className="relative mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <VllmMark className="h-7 w-7 shrink-0" title="vLLM" />
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-[-0.02em]">
              vLLM CI Dashboard
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Build health, queues, tests, and benchmarks for the vLLM project.
            </p>
          </div>
        </div>
        <nav aria-label="Project links" className="flex flex-wrap gap-x-5 gap-y-2">
          {FOOTER_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
