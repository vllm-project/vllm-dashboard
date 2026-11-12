import type { Metadata } from "next";
import { Suspense } from "react";
import MyPlateContent from "./my-plate-content";

export const metadata: Metadata = { title: "My plate" };

export default function MyPlatePage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading your assignments...</div>}>
      <MyPlateContent />
    </Suspense>
  );
}
