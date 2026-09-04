/**
 * Presentation logic for the Fast CI view of the alerts tab.
 *
 * Fast Failure Events are immutable observations with no resolution lifecycle,
 * so nothing here derives an active/resolved status. The only per-event state
 * is how far its Slack notification got.
 */

import {
  notificationStateFor,
  type NotificationState,
  type NotificationStatus,
} from "./alerts-shared";

/** One Fast Failure Event as the alerts API returns it. */
export interface FastFailureEvent {
  buildkiteJobId: string;
  jobName: string;
  jobUrl: string;
  state: string;
  softFailed: boolean;
  durationSeconds: number;
  finishedAt: string;
  buildUrl: string;
  message: string;
  commitSha: string;
  branch: string;
  author: string;
  prNumber: string | null;
  pipeline: string;
  notificationStatuses: NotificationStatus[];
}

export interface FastFailureEventView extends FastFailureEvent {
  notificationState: NotificationState;
}

/**
 * A retried job produces one event per attempt, and a broadly broken build
 * retries the same job several times, so events sharing a job name collapse
 * into one row with the attempts kept as evidence behind it.
 */
export interface FastFailureJobGroup {
  key: string;
  jobName: string;
  count: number;
  firstFinishedAt: string;
  lastFinishedAt: string;
  notificationState: NotificationState;
  events: FastFailureEventView[];
}

/** The events one build produced for one commit. */
export interface FastFailureGroup {
  key: string;
  buildUrl: string;
  commitSha: string;
  branch: string;
  author: string;
  message: string;
  pipeline: string;
  prNumber: string | null;
  latestFinishedAt: string;
  events: FastFailureEventView[];
  jobGroups: FastFailureJobGroup[];
}

/**
 * A job group summarizes several notification attempts, so the state a
 * responder must act on first wins: a dead-lettered attempt outranks one
 * still retrying, and anything undelivered outranks a success.
 */
const JOB_GROUP_SEVERITY: NotificationState[] = [
  "dead_letter",
  "retrying",
  "pending",
  "unnotified",
  "delivered",
];

export function worstNotificationState(
  states: readonly NotificationState[],
): NotificationState {
  return (
    JOB_GROUP_SEVERITY.find((state) => states.includes(state)) ?? "unnotified"
  );
}

/**
 * Cluster events by the build that ran them and the commit they tested, so a
 * single broken build reads as one cluster of symptoms rather than a run of
 * unrelated job failures. Retries produce a distinct build for the same commit
 * and stay separate, because they are separate evidence.
 */
export function groupFastFailureEvents(
  events: readonly FastFailureEvent[],
): FastFailureGroup[] {
  const groups = new Map<string, FastFailureGroup>();

  for (const event of events) {
    const key = `${event.buildUrl}|${event.commitSha}`;
    const view: FastFailureEventView = {
      ...event,
      notificationState: notificationStateFor(event.notificationStatuses),
    };
    const group = groups.get(key);
    if (group) {
      group.events.push(view);
      continue;
    }
    groups.set(key, {
      key,
      buildUrl: event.buildUrl,
      commitSha: event.commitSha,
      branch: event.branch,
      author: event.author,
      message: event.message,
      pipeline: event.pipeline,
      prNumber: event.prNumber,
      latestFinishedAt: event.finishedAt,
      events: [view],
      // Filled in once every event of the build has been collected.
      jobGroups: [],
    });
  }

  for (const group of groups.values()) {
    group.events.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    group.latestFinishedAt = group.events[0].finishedAt;
    group.jobGroups = groupEventsByJob(group.events);
  }

  return [...groups.values()].sort((a, b) =>
    b.latestFinishedAt.localeCompare(a.latestFinishedAt),
  );
}

/** Collapse repeated runs of one job within a build group, newest first. */
function groupEventsByJob(
  events: readonly FastFailureEventView[],
): FastFailureJobGroup[] {
  const jobGroups = new Map<string, FastFailureJobGroup>();

  for (const event of events) {
    const jobGroup = jobGroups.get(event.jobName);
    if (jobGroup) {
      jobGroup.events.push(event);
      continue;
    }
    jobGroups.set(event.jobName, {
      key: event.jobName,
      jobName: event.jobName,
      count: 0,
      firstFinishedAt: event.finishedAt,
      lastFinishedAt: event.finishedAt,
      notificationState: event.notificationState,
      events: [event],
    });
  }

  for (const jobGroup of jobGroups.values()) {
    // Incoming events are already newest-first, so the ends of the list are
    // the group's first and last finishes.
    jobGroup.count = jobGroup.events.length;
    jobGroup.lastFinishedAt = jobGroup.events[0].finishedAt;
    jobGroup.firstFinishedAt = jobGroup.events[jobGroup.events.length - 1].finishedAt;
    jobGroup.notificationState = worstNotificationState(
      jobGroup.events.map((event) => event.notificationState),
    );
  }

  return [...jobGroups.values()].sort((a, b) =>
    b.lastFinishedAt.localeCompare(a.lastFinishedAt),
  );
}
