import type {
  MainCiAnalysisClassification,
  MainCiAnalysisConfidence,
} from "@/lib/alerts-main-ci";

/** Shared shape of `GET /api/overview`, consumed by the Overview page. */

export interface OverviewBuild {
  number: string;
  state: string;
  webUrl: string;
  commit: string;
  message: string;
  author: string | null;
  prNumber: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMins: number | null;
}

export interface OverviewMain {
  passRate24h: number | null;
  passRatePrior24h: number | null;
  builds24h: number;
  failed24h: number;
  /** Daily pass rate over the last 7 days, oldest first. */
  dailyPassRate: number[];
  latest: OverviewBuild | null;
  latestFinished: OverviewBuild | null;
  recent: OverviewBuild[];
}

export interface OverviewAlertSummary {
  alertId: string;
  jobName: string;
  classification: MainCiAnalysisClassification | null;
  confidence: MainCiAnalysisConfidence | null;
  failureCount: number;
  openedAt: string;
  lastFailedAt: string;
  jobUrl: string;
}

export interface OverviewAlerts {
  open: number;
  byReason: Record<MainCiAnalysisClassification | "unanalyzed", number>;
  top: OverviewAlertSummary[];
}

export interface OverviewFastFailures {
  events24h: number;
  jobs24h: number;
  builds24h: number;
}

export interface OverviewQueue {
  queue: string;
  waiting: number;
  running: number;
  agents: number;
  busy: number;
  p50WaitSecs: number | null;
}

export interface OverviewQueues {
  totalAgents: number;
  busyAgents: number;
  waitingJobs: number;
  queuesWithBacklog: number;
  polledAt: string | null;
  hot: OverviewQueue[];
}

export interface OverviewHost {
  hostname: string;
  gpuType: string | null;
  gpus: number;
  utilPct: number;
  memPct: number;
  reportedAt: string;
}

export interface OverviewGpu {
  hosts: number;
  gpus: number;
  avgUtilPct: number;
  memPct: number;
  busiest: OverviewHost[];
}

export interface OverviewResponse {
  generatedAt: string;
  main: OverviewMain | null;
  alerts: OverviewAlerts | null;
  fastFailures: OverviewFastFailures | null;
  queues: OverviewQueues | null;
  gpu: OverviewGpu | null;
  /** Source name to error message, for sources that failed to load. */
  errors: Record<string, string>;
}
