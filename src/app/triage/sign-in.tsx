"use client";

import { usePathname, useSearchParams } from "next/navigation";

const ERRORS: Record<string, string> = {
  not_maintainer: "Your GitHub account is not on the vLLM maintainer team for triage.",
  state: "The sign-in link expired or was opened in another browser. Try again.",
  denied: "GitHub sign-in was cancelled.",
  exchange: "GitHub sign-in failed. Try again.",
};

export function TriageSignIn() {
  const pathname = usePathname();
  const params = useSearchParams();
  const error = params.get("auth_error");
  const next = pathname.startsWith("/triage") ? pathname : "/triage";
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">Triage is for vLLM maintainers</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Sign in with GitHub. Access is checked against the maintainer team; your GitHub token is used once and not stored.
      </p>
      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{ERRORS[error] ?? "Sign-in failed."}</p>
      )}
      <a
        href={`/api/triage/auth/login?next=${encodeURIComponent(next)}`}
        className="dashboard-control mt-5 inline-flex min-h-10 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Sign in with GitHub
      </a>
    </div>
  );
}
