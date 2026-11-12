import type { Metadata } from "next";
import { Suspense } from "react";
import RulesContent from "./rules-content";

export const metadata: Metadata = { title: "Triage rules" };

export default function RulesPage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading your rules...</div>}>
      <RulesContent />
    </Suspense>
  );
}
