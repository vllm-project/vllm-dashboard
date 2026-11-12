import { safeGithubUrl } from "@/lib/triage-query";

const BAND_STYLES: Record<string, string> = {
  page: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/30",
  route: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30",
  watch: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/30",
  ignore: "bg-zinc-50 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-600/40",
};

export function BandBadge({ band, score }: { band: string | null; score: number | null }) {
  const style = BAND_STYLES[band ?? ""] ?? BAND_STYLES.ignore;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>
      <span className="tabular-nums font-semibold">{score ?? "—"}</span>
      <span>{band ?? "unscored"}</span>
    </span>
  );
}

export function Chips({
  values,
  tone = "default",
  max = 4,
}: {
  values: string[];
  tone?: "default" | "muted";
  max?: number;
}) {
  if (values.length === 0) return <span className="text-zinc-400">—</span>;
  const shown = values.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((value) => (
        <span
          key={value}
          className={`rounded px-1.5 py-0.5 text-[11px] leading-4 ${
            tone === "muted"
              ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400"
              : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          }`}
        >
          {value}
        </span>
      ))}
      {values.length > max && (
        <span className="text-[11px] text-zinc-400">+{values.length - max}</span>
      )}
    </span>
  );
}

/** A link to GitHub only when it points into vllm-project; plain text otherwise. */
export function GithubLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeGithubUrl(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-zinc-950 underline-offset-2 hover:underline dark:text-zinc-50"
    >
      {children}
    </a>
  );
}

export function KindBadge({ kind, draft }: { kind: "issue" | "pr"; draft?: boolean }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {kind === "pr" ? (draft ? "PR·draft" : "PR") : "Issue"}
    </span>
  );
}
