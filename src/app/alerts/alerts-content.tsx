"use client";

import { useMemo, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { FastCIAlerts } from "@/components/fast-ci-alerts";
import { InfraAlerts } from "@/components/infra-alerts";
import { MainCIAlerts } from "@/components/main-ci-alerts";
import { SegmentedControl } from "@/components/segmented-control";
import {
  groupFastFailureEvents,
  type FastFailureEvent,
} from "@/lib/alerts-fast-ci";
import {
  viewInfraAlerts,
  type InfraAlertEpisode,
  type InfraRetiredHost,
} from "@/lib/alerts-infra";
import {
  viewMainCiJobAlerts,
  type MainCiJobAlert,
} from "@/lib/alerts-main-ci";
import {
  ALERT_TIME_WINDOWS,
  alertWindowCutoff,
  isAlertTimeWindow,
  withinAlertWindow,
  type AlertTimeWindow,
} from "@/lib/alerts-shared";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type AlertTab = "main-ci" | "fast-ci" | "infra";

const ALERT_TABS: readonly {
  value: AlertTab;
  label: string;
  /** What this source means, shown from the info control beside the tabs. */
  description: string;
}[] = [
  {
    value: "main-ci",
    label: "Failures",
    description:
      "Hard command-job failures on the main branch. A failure stays open across builds until that exact Buildkite step positively passes again; soft failures, missing jobs, and older builds finishing late do not resolve it. Resolving an alert by hand closes it without waiting for a pass.",
  },
  {
    value: "fast-ci",
    label: "Fast failures (<30s)",
    description:
      "Fast CI jobs that finished in a failure state within 30 seconds, over the last 7 days, grouped by the build and commit they came from. These are observations with no resolution lifecycle; each one shows how far its Slack notification got.",
  },
  {
    value: "infra",
    label: "Infra",
    description:
      "Infra health episodes: hosts that stopped reporting, shared disks over their usage threshold, and GPUs over their temperature threshold. An episode opens only after a breach sustains across consecutive five-minute scans and resolves on the first healthy observation; a host absent for seven days is auto-retired and stops alerting. This view is read-only — there is nothing to resolve by hand.",
  },
];

function isAlertTab(value: string | null): value is AlertTab {
  return ALERT_TABS.some((tab) => tab.value === value);
}

/**
 * The job-category hides are view options, not data filters: they only remove
 * matching job names from the rendered list, and they ride in the URL like the
 * other alert controls.
 */
type HideOption = "softfail" | "optional" | "amd";

const HIDE_OPTIONS: readonly { value: HideOption; label: string }[] = [
  { value: "softfail", label: "Hide soft-fail jobs" },
  { value: "optional", label: "Hide optional jobs" },
  { value: "amd", label: "Hide AMD jobs" },
];

interface AlertOptions {
  showSoftFailed: boolean;
  hide: ReadonlySet<HideOption>;
}

function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className={`dashboard-control inline-flex items-center gap-2 text-xs font-semibold whitespace-nowrap ${
        checked
          ? "text-zinc-950 dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-150 ${
          checked
            ? "border-zinc-950 bg-zinc-950 dark:border-zinc-50 dark:bg-zinc-50"
            : "border-zinc-300 bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"
        }`}
      >
        <span
          className={`h-3.5 w-3.5 rounded-full bg-white transition-transform duration-150 motion-reduce:transition-none ${
            checked ? "translate-x-4 dark:bg-zinc-950" : "translate-x-0 dark:bg-zinc-400"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

interface FastCIAlertsResponse {
  events?: FastFailureEvent[];
  windowDays?: number;
  error?: string;
}

interface MainCIAlertsResponse {
  alerts?: MainCiJobAlert[];
  schemaStatus?: "ready" | "pending";
  error?: string;
}

interface InfraAlertsResponse {
  episodes?: InfraAlertEpisode[];
  retiredHosts?: InfraRetiredHost[];
  schemaStatus?: "ready" | "pending";
  error?: string;
}

/** The explanation of a view, one click away instead of a paragraph above it. */
function InfoPopover({ text }: { text: string }) {
  return (
    <details className="relative">
      <summary
        aria-label="About this view"
        title="About this view"
        className="dashboard-control flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 [&::-webkit-details-marker]:hidden"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M8 7.25v4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="5" r="0.85" fill="currentColor" />
        </svg>
      </summary>
      <div className="dashboard-popover absolute right-0 z-50 mt-2 w-80 rounded-lg border border-black/10 bg-white p-3 text-xs leading-relaxed text-zinc-600 shadow-[0_16px_40px_rgba(0,0,0,0.14)] dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
        {text}
      </div>
    </details>
  );
}

/**
 * One alert source's body: its alerts, a loading placeholder shaped like the
 * list it stands in for, or a failure to load them.
 */
function AlertSection({
  title,
  isLoading,
  failed,
  children,
}: {
  title: string;
  isLoading: boolean;
  failed: boolean;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <div
        className="space-y-3 motion-reduce:[&_*]:animate-none"
        aria-label={`Loading ${title} alerts`}
        aria-busy="true"
      >
        <div className="h-8 w-56 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <div className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800/70 dark:border-zinc-800 dark:bg-zinc-950">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <div className="h-3.5 w-3.5 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
              <div className="h-3.5 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="ml-auto h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-red-500">
        Failed to load {title}.
      </div>
    );
  }
  return <>{children}</>;
}

function MainCISection({
  timeWindow,
  options,
}: {
  timeWindow: AlertTimeWindow;
  options: AlertOptions;
}) {
  const { data, isLoading, error, mutate } = useSWR<MainCIAlertsResponse>(
    "/api/alerts/main-ci",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const alerts = useMemo(
    () =>
      viewMainCiJobAlerts(
        data?.alerts ?? [],
        alertWindowCutoff(timeWindow),
      ),
    [data, timeWindow],
  );

  const resolveAlert = async (alertId: string) => {
    const response = await fetch("/api/alerts/main-ci/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: Number(alertId) }),
    });
    if (!response.ok) {
      throw new Error(`Resolve failed with ${response.status}`);
    }
    await mutate();
  };

  return (
    <AlertSection
      title="Failures"
      isLoading={isLoading}
      failed={Boolean(error || data?.error)}
    >
      {data?.schemaStatus === "pending" ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-amber-300 px-6 text-center text-sm text-amber-700 dark:border-amber-800 dark:text-amber-300">
          Backend rollout pending. Migrations 0014/0016 and the Main CI workers
          must be deployed before this preview can show alerts.
        </div>
      ) : (
        <MainCIAlerts
          alerts={alerts}
          onResolve={resolveAlert}
          hideSoftFail={options.hide.has("softfail")}
          hideOptional={options.hide.has("optional")}
          hideAmd={options.hide.has("amd")}
        />
      )}
    </AlertSection>
  );
}

function FastCISection({
  timeWindow,
  showSoftFailed,
}: {
  timeWindow: AlertTimeWindow;
  showSoftFailed: boolean;
}) {
  const { data, isLoading, error } = useSWR<FastCIAlertsResponse>(
    "/api/alerts/fast-ci",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const groups = useMemo(() => {
    const cutoff = alertWindowCutoff(timeWindow);
    return groupFastFailureEvents(
      (data?.events ?? []).filter(
        (event) =>
          withinAlertWindow(event.finishedAt, cutoff) &&
          (showSoftFailed || !event.softFailed),
      ),
    );
  }, [data, timeWindow, showSoftFailed]);

  return (
    <AlertSection
      title="Fast failures (<30s)"
      isLoading={isLoading}
      failed={Boolean(error || data?.error)}
    >
      <FastCIAlerts groups={groups} showSoftFailed={showSoftFailed} />
    </AlertSection>
  );
}

function InfraSection({ timeWindow }: { timeWindow: AlertTimeWindow }) {
  const { data, isLoading, error } = useSWR<InfraAlertsResponse>(
    "/api/alerts/infra",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const view = useMemo(
    () =>
      viewInfraAlerts(
        data?.episodes ?? [],
        data?.retiredHosts ?? [],
        alertWindowCutoff(timeWindow),
      ),
    [data, timeWindow],
  );

  return (
    <AlertSection
      title="Infra"
      isLoading={isLoading}
      failed={Boolean(error || data?.error)}
    >
      {data?.schemaStatus === "pending" ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-amber-300 px-6 text-center text-sm text-amber-700 dark:border-amber-800 dark:text-amber-300">
          Backend rollout pending. Migration 0019 and the infra alerting worker
          must be deployed before this preview can show alerts.
        </div>
      ) : (
        <InfraAlerts view={view} />
      )}
    </AlertSection>
  );
}

export default function AlertsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get("tab");
  const tab: AlertTab = isAlertTab(tabParam) ? tabParam : "fast-ci";
  const windowParam = searchParams.get("window");
  const timeWindow: AlertTimeWindow = isAlertTimeWindow(windowParam)
    ? windowParam
    : "7d";
  const options: AlertOptions = {
    showSoftFailed: searchParams.get("soft") === "show",
    hide: new Set(
      (searchParams.get("hide") ?? "")
        .split(",")
        .filter((value): value is HideOption =>
          HIDE_OPTIONS.some((option) => option.value === value),
        ),
    ),
  };
  const activeTab = ALERT_TABS.find((item) => item.value === tab) ?? ALERT_TABS[0];

  const navigate = (
    nextTab: AlertTab,
    nextWindow: AlertTimeWindow,
    nextOptions: AlertOptions,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    params.set("window", nextWindow);
    if (nextOptions.showSoftFailed) {
      params.set("soft", "show");
    } else {
      params.delete("soft");
    }
    if (nextOptions.hide.size > 0) {
      params.set(
        "hide",
        HIDE_OPTIONS.filter((option) => nextOptions.hide.has(option.value))
          .map((option) => option.value)
          .join(","),
      );
    } else {
      params.delete("hide");
    }
    router.replace(`/alerts?${params.toString()}`);
  };

  const toggleHide = (option: HideOption) => {
    const hide = new Set(options.hide);
    if (hide.has(option)) {
      hide.delete(option);
    } else {
      hide.add(option);
    }
    navigate(tab, timeWindow, { ...options, hide });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label="Time window"
            value={timeWindow}
            options={ALERT_TIME_WINDOWS}
            onChange={(next) => navigate(tab, next, options)}
          />
          <InfoPopover text={activeTab.description} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-zinc-200 dark:border-zinc-800">
        <div role="tablist" aria-label="Alert sources" className="flex gap-6">
          {ALERT_TABS.map((item) => {
            const active = item.value === tab;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => navigate(item.value, timeWindow, options)}
                className={`dashboard-control -mb-px inline-flex min-h-11 items-center border-b-2 text-sm font-semibold sm:min-h-10 ${
                  active
                    ? "border-zinc-950 text-zinc-950 dark:border-zinc-50 dark:text-zinc-50"
                    : "border-transparent text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2">
          {tab === "fast-ci" && (
            <ToggleSwitch
              checked={options.showSoftFailed}
              onToggle={() =>
                navigate(tab, timeWindow, {
                  ...options,
                  showSoftFailed: !options.showSoftFailed,
                })
              }
              label="Show soft failed"
            />
          )}
          {tab === "main-ci" &&
            HIDE_OPTIONS.map((option) => (
              <ToggleSwitch
                key={option.value}
                checked={options.hide.has(option.value)}
                onToggle={() => toggleHide(option.value)}
                label={option.label}
              />
            ))}
        </div>
      </div>

      {tab === "main-ci" ? (
        <MainCISection timeWindow={timeWindow} options={options} />
      ) : tab === "infra" ? (
        <InfraSection timeWindow={timeWindow} />
      ) : (
        <FastCISection
          timeWindow={timeWindow}
          showSoftFailed={options.showSoftFailed}
        />
      )}
    </div>
  );
}
