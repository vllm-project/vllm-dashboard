import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  sessionCookieName,
  loginFromSessionCookie,
  triageEnabled,
} from "@/lib/triage-auth";
import { TriageAccount } from "@/components/triage/triage-account";
import { TriageSignIn } from "./sign-in";

export const dynamic = "force-dynamic";

/**
 * Every /triage page is maintainers-only: 404 while TRIAGE_ENABLED is unset,
 * and a sign-in screen (never data) without a valid session.
 */
export default async function TriageLayout({ children }: { children: React.ReactNode }) {
  if (!triageEnabled()) notFound();
  const cookieStore = await cookies();
  const login = loginFromSessionCookie(cookieStore.get(sessionCookieName())?.value);
  if (!login) {
    return (
      <Suspense fallback={null}>
        <TriageSignIn />
      </Suspense>
    );
  }
  return (
    <div>
      <TriageAccount login={login} />
      {children}
    </div>
  );
}
