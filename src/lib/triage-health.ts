import type { TriagePipelineHealth } from "@/lib/triage-types";

/**
 * Grades the triage pipeline's raw health signals (see getStats) so silent
 * failures show up on the queue page: labelling and relevance both run from
 * cron on the extractor host every 10 minutes, and when either stops (a
 * failing model call, an expired Claude login) nothing else complains.
 */

export type HealthTone = "ok" | "warn" | "bad";

export interface HealthSignal {
  key: "labels" | "judgements" | "failures" | "login" | "warnings";
  tone: HealthTone;
  /** Short text for the strip, e.g. "Labelled 4m ago". */
  text: string;
  /** Longer plain-language explanation for the tooltip. */
  detail: string;
}

export interface PipelineHealthView {
  tone: HealthTone;
  signals: HealthSignal[];
}

/** The extractor cron runs every 10 minutes; one missed run is normal, two is a warning. */
export const STALE_WARN_MS = 25 * 60 * 1000;
export const STALE_BAD_MS = 60 * 60 * 1000;
export const FAILURES_WARN = 3;
export const FAILURES_BAD = 10;
export const LOGIN_WARN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "just now", "4m ago", "2h ago", "3d ago", or "never". */
export function agoText(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How long work has gone undone: since the step last ran, or since the oldest
 * waiting item arrived if that is later (after a quiet spell the step has
 * nothing to do, so an old "last ran" alone is not a problem). Only matters
 * while something is waiting.
 */
export function staleness(last: string | null, waitingSince: string | null, waiting: number, now: number): HealthTone {
  if (waiting === 0) return "ok";
  const times = [last, waitingSince].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  const age = times.length > 0 ? now - Math.max(...times) : Infinity;
  if (!(age <= STALE_BAD_MS)) return "bad";
  return age > STALE_WARN_MS ? "warn" : "ok";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const RANK: Record<HealthTone, number> = { ok: 0, warn: 1, bad: 2 };

export function worst(tones: HealthTone[]): HealthTone {
  return tones.reduce<HealthTone>((acc, tone) => (RANK[tone] > RANK[acc] ? tone : acc), "ok");
}

export function pipelineHealth(health: TriagePipelineHealth, now: number = Date.now()): PipelineHealthView {
  const signals: HealthSignal[] = [];

  const labelTone = staleness(health.lastLabelledAt, health.labelWaitSince, health.waitingForLabel, now);
  signals.push({
    key: "labels",
    tone: labelTone,
    text:
      health.waitingForLabel > 0
        ? `Labelled ${agoText(health.lastLabelledAt, now)} · ${health.waitingForLabel} waiting`
        : `Labelled ${agoText(health.lastLabelledAt, now)} · none waiting`,
    detail:
      `Claude last labelled an item ${agoText(health.lastLabelledAt, now)}. ` +
      `${plural(health.waitingForLabel, "open item")} ${health.waitingForLabel === 1 ? "is" : "are"} waiting to be labelled.` +
      (labelTone === "ok"
        ? ""
        : " Labelling runs every 10 minutes on the extractor host; check its log and its Claude login."),
  });

  const judgeTone = staleness(health.lastJudgedAt, health.judgementWaitSince, health.waitingForJudgement, now);
  signals.push({
    key: "judgements",
    tone: judgeTone,
    text:
      health.waitingForJudgement > 0
        ? `Judged ${agoText(health.lastJudgedAt, now)} · ${health.waitingForJudgement} P0/P1 waiting`
        : `Judged ${agoText(health.lastJudgedAt, now)} · no P0/P1 waiting`,
    detail:
      `Claude last judged who an item is for ${agoText(health.lastJudgedAt, now)}. ` +
      `${plural(health.waitingForJudgement, "unowned P0/P1 item")} ${health.waitingForJudgement === 1 ? "is" : "are"} waiting for those judgements; ` +
      "the router doesn't assign an item until every maintainer has been judged." +
      (judgeTone === "ok" ? "" : " The relevance step runs after labelling on the extractor host; check its log."),
  });

  const failures = health.labelFailures24h;
  const failTone: HealthTone =
    failures >= FAILURES_BAD ? "bad" : failures >= FAILURES_WARN || health.labelGaveUp > 0 ? "warn" : "ok";
  signals.push({
    key: "failures",
    tone: failTone,
    text:
      health.labelGaveUp > 0
        ? `${failures} failed · 24h · ${health.labelGaveUp} gave up`
        : `${failures} failed · 24h`,
    detail:
      `${plural(failures, "item")} failed to label in the last 24 hours (they are retried).` +
      (health.labelGaveUp > 0
        ? ` ${plural(health.labelGaveUp, "open item")} failed every attempt and won't be retried until ${health.labelGaveUp === 1 ? "it changes" : "they change"}.`
        : "") +
      (health.lastLabelError ? ` Latest error: ${health.lastLabelError.slice(0, 200)}` : ""),
  });

  if (health.loginExpiresOn && /^\d{4}-\d{2}-\d{2}$/.test(health.loginExpiresOn)) {
    const days = Math.ceil((Date.parse(`${health.loginExpiresOn}T00:00:00Z`) - now) / DAY_MS);
    if (days <= LOGIN_WARN_DAYS) {
      signals.push({
        key: "login",
        tone: days <= 0 ? "bad" : "warn",
        text: days <= 0 ? "Claude login expired" : `Claude login expires in ${plural(days, "day")}`,
        detail:
          `The extractor host's Claude login ${days <= 0 ? "expired" : "expires"} on ${health.loginExpiresOn}. ` +
          "Labelling and relevance stop when it does. Log in again on the host, then update TRIAGE_CLAUDE_LOGIN_EXPIRES.",
      });
    }
  }

  if ((health.workerWarnings24h ?? 0) > 0) {
    const count = health.workerWarnings24h ?? 0;
    signals.push({
      key: "warnings",
      tone: "warn",
      text: `${plural(count, "worker warning")} · 24h`,
      detail:
        `${plural(count, "triage worker run")} logged warnings in the last 24 hours.` +
        (health.latestWorkerWarning ? ` Latest: ${health.latestWorkerWarning.slice(0, 240)}` : ""),
    });
  }

  return { tone: worst(signals.map((s) => s.tone)), signals };
}
