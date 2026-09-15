import type {
  MainCiAlertUpdate,
  MainCiJobAlert,
  MainCiSolutionCoverage,
  MainCiSolutionIssue,
  MainCiSuspectedFixPr,
} from "@/lib/alerts-main-ci";

/** Fix links that are safe to present as ownership of the latest failure. */
export function currentMainCiFixPrs(
  alert: MainCiJobAlert,
): MainCiSuspectedFixPr[] {
  const updateFixPrs = alert.updates.flatMap(
    (update) => update.carriedFixPrs,
  );
  return [...new Map(updateFixPrs.map((pr) => [pr.url, pr])).values()];
}

function newestUpdate(
  updates: readonly MainCiAlertUpdate[],
  predicate: (update: MainCiAlertUpdate) => boolean,
): MainCiAlertUpdate | null {
  return (
    updates
      .filter(predicate)
      .reduce<MainCiAlertUpdate | null>(
        (newest, update) =>
          newest === null ||
          Date.parse(update.createdAt) > Date.parse(newest.createdAt)
            ? update
            : newest,
        null,
      )
  );
}

/**
 * Reconcile one visible alert to exactly one accountable path. A verified fix
 * wins; otherwise the newest exact-revision non-code solution is authoritative.
 * Automated recommendations never count as ownership.
 */
export function reconcileMainCiSolution(
  alert: MainCiJobAlert,
): MainCiSolutionCoverage {
  if (alert.status !== "open") {
    return {
      kind: "untriaged",
      owner: null,
      action: null,
      sourceUpdateId: null,
      updatedAt: null,
      issues: [],
    };
  }

  const fixPrs = currentMainCiFixPrs(alert);
  if (fixPrs.length > 0) {
    const source = newestUpdate(alert.updates, (update) =>
      update.carriedFixPrs.some((pr) =>
        fixPrs.some((current) => current.url === pr.url),
      ),
    );
    const explicit = newestUpdate(
      alert.updates,
      (update) => !update.stale && update.solution?.kind === "code_fix",
    );
    const owner = explicit?.solution?.owner ?? source?.author ?? "Responder";
    const action =
      explicit?.solution?.action ?? source?.message ?? "Track the linked fix.";
    const issues: MainCiSolutionIssue[] =
      source?.fixOwnershipStatus === "merged_pending"
        ? ["fix_merged_pending"]
        : [];
    return {
      kind: "code_fix",
      owner,
      action,
      sourceUpdateId: explicit?.updateId ?? source?.updateId ?? null,
      updatedAt: explicit?.createdAt ?? source?.createdAt ?? null,
      issues,
    };
  }

  const currentAction = newestUpdate(
    alert.updates,
    (update) =>
      !update.stale &&
      update.solution !== null &&
      update.solution.kind !== "code_fix",
  );
  if (currentAction?.solution) {
    return {
      kind: currentAction.solution.kind,
      owner: currentAction.solution.owner,
      action: currentAction.solution.action,
      sourceUpdateId: currentAction.updateId,
      updatedAt: currentAction.createdAt,
      issues: [],
    };
  }

  const issues = new Set<MainCiSolutionIssue>(["missing_current_solution"]);
  const latestFix = newestUpdate(
    alert.updates,
    (update) => update.fixPrs.length > 0,
  );
  if (latestFix) {
    const issueByStatus: Partial<
      Record<MainCiAlertUpdate["fixOwnershipStatus"], MainCiSolutionIssue>
    > = {
      signature_changed: "signature_changed",
      inactive: "inactive_fix",
      merged_pending: "fix_merged_pending",
      regressed: "fix_already_contained",
      unverified: "fix_unverified",
    };
    const issue = issueByStatus[latestFix.fixOwnershipStatus];
    if (issue) issues.add(issue);
  }
  const latestAction = newestUpdate(
    alert.updates,
    (update) => update.solution !== null,
  );
  if (latestAction?.stale) issues.add("stale_action");

  return {
    kind: "untriaged",
    owner: null,
    action: null,
    sourceUpdateId: null,
    updatedAt: null,
    issues: [...issues],
  };
}

export function reconcileMainCiSolutions(
  alerts: MainCiJobAlert[],
): MainCiJobAlert[] {
  return alerts.map((alert) => ({
    ...alert,
    solutionCoverage: reconcileMainCiSolution(alert),
  }));
}

export interface MainCiSolutionReconciliationSummary {
  checkedAt: string;
  openAlerts: number;
  coveredAlerts: number;
  untriagedAlerts: number;
  issueCounts: Partial<Record<MainCiSolutionIssue, number>>;
}

export function summarizeMainCiSolutionReconciliation(
  alerts: readonly MainCiJobAlert[],
  checkedAt = new Date(),
): MainCiSolutionReconciliationSummary {
  const open = alerts.filter((alert) => alert.status === "open");
  const issueCounts: Partial<Record<MainCiSolutionIssue, number>> = {};
  for (const alert of open) {
    for (const issue of alert.solutionCoverage.issues) {
      issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    }
  }
  const untriagedAlerts = open.filter(
    (alert) => alert.solutionCoverage.kind === "untriaged",
  ).length;
  return {
    checkedAt: checkedAt.toISOString(),
    openAlerts: open.length,
    coveredAlerts: open.length - untriagedAlerts,
    untriagedAlerts,
    issueCounts,
  };
}
