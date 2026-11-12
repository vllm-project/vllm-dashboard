import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  SESSION_COOKIE,
  loginFromSessionCookie,
  triageEnabled,
} from "@/lib/triage-auth";
import { TriageSignIn } from "./sign-in";

export const dynamic = "force-dynamic";

/**
 * Every /triage page is maintainers-only: 404 while TRIAGE_ENABLED is unset,
 * and a sign-in screen (never data) without a valid session.
 */
export default async function TriageLayout({ children }: { children: React.ReactNode }) {
  if (!triageEnabled()) notFound();
  const cookieStore = await cookies();
  const login = loginFromSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!login) {
    return (
      <Suspense fallback={null}>
        <TriageSignIn />
      </Suspense>
    );
  }
  return (
    <div>
      <div className="mb-4 flex items-center justify-end gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          Signed in as <span className="font-medium text-zinc-800 dark:text-zinc-200">{login}</span>
        </span>
        <form action="/api/triage/auth/logout" method="post">
          <button
            type="submit"
            className="dashboard-control rounded-md px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Sign out
          </button>
        </form>
      </div>
      {children}
    </div>
  );
}
