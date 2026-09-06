import { PerfSettingsProvider } from "@/app/perf/perf-settings";

/**
 * Trends and Frontier share the benchmark start-date setting. The section
 * shell (eyebrow, description, tabs) comes from the root layout, so this
 * layout only provides the shared context.
 */
export default function PerfLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PerfSettingsProvider>{children}</PerfSettingsProvider>;
}
