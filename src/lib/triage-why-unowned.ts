import { matchRules } from "@/lib/triage-rules";
import { priorityLabel } from "@/lib/triage-style";
import type { TriageFacets, TriagePrepass, TriageRules } from "@/lib/triage-types";

/**
 * Why a P0/P1 has no owner, in plain words, for the item drawer.
 *
 * This re-runs the router's decision for one item from data the dashboard can
 * read. It mirrors, and must be kept in step with:
 *   - `routing_candidates` in triage/store.py (open, in scope, P0/P1,
 *     labelled, no open/acked/done primary, never dropped or slopped);
 *   - `_route_one` in triage/pipeline.py (leave items assigned on GitHub to
 *     someone outside triage; wait up to RELEVANCE_GRACE for relevance
 *     judgements from every active maintainer unless one is already involved,
 *     then route among those judged);
 *   - `choose_owners` / `_excluded` / `involvement` / `assigned_elsewhere` in
 *     triage/routing.py (not_mine, min_score, away, capacity with the fresh /
 *     clear-match P0 exception, then involvement (GitHub assignee > authored
 *     > commented) > high/medium relevance > rules).
 * Rule matching itself is `matchRules` (the mirror of `match_rules`).
 */

export interface RoutingMaintainer {
  login: string;
  minScore: number;
  capacityPerWeek: number;
  away: { start: string; end: string }[];
  rules: TriageRules;
  /** Has a work profile, so Claude can judge items for them. */
  hasProfile: boolean;
}

export type RelevanceLevel = "high" | "medium" | "low" | "none";

export interface WhyUnownedInput {
  state: string;
  inScope: boolean;
  band: string | null;
  score: number | null;
  /** The score was computed from a Claude label (triage_scores.extraction_id set). */
  labelled: boolean;
  extractionStatus: string;
  /** gh_created_at, ISO. */
  createdAt: string | null;
  title: string;
  facets: TriageFacets | null;
  /** With `commenters` filled in (see `commentersFromExcerpt`). */
  prepass: TriagePrepass;
  files: { path?: string }[];
  /** Claude's judgement per maintainer; `current` is false when the item changed since. */
  relevance: { maintainer: string; relevance: RelevanceLevel; current: boolean }[];
  /** Active maintainers only (the router loads `WHERE active`). */
  maintainers: RoutingMaintainer[];
  /** Primary assignments kept in the last 7 days, per maintainer (`maintainer_load`). */
  load: Record<string, number>;
  /** Everyone who said "not mine" on this item. */
  notMine: string[];
  /** The first drop/slop action on the item, if any; the router never routes those again. */
  hidden: { action: "drop" | "slop"; actor: string } | null;
  /** Maintainer of a primary assignment already marked done, if any. */
  doneBy: string | null;
  /** That assignment was closed because the item closed on GitHub (reason.closed_by = "github"). */
  doneOnGithub?: boolean;
  /**
   * When the router started waiting for relevance judgements (RoutingRow.waiting_since:
   * GREATEST(triage_scores.routable_since, first label)). `undefined` when the
   * database can't say yet (migration 0043 not applied); `null` means the
   * router can't tell either and doesn't wait.
   */
  waitingSince?: string | null;
  /**
   * This item's place among the router's candidates (unowned, labelled P0/P1,
   * highest score first); the router reads only the first `ROUTE_LIMIT`.
   */
  queuePosition?: number;
  now: Date;
}

export interface WhyUnowned {
  /** One sentence: the reason it has no owner. */
  summary: string;
  /** At most a handful of supporting lines, strongest maintainer first. */
  lines: string[];
  /** The router should pick it up on its next run (nothing is blocking it). */
  pending: boolean;
}

/** Page-band items opened this recently may exceed a weekly cap (`FRESH_WINDOW`). */
export const FRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** `route_limit` on RouteHandler (triage/pipeline.py). */
export const ROUTE_LIMIT = 200;
/** `RELEVANCE_GRACE` in triage/pipeline.py. */
export const RELEVANCE_GRACE_MS = 2 * 60 * 60 * 1000;
/** Reason code `GH_ASSIGNED` in triage/routing.py. */
export const GH_ASSIGNED = "assigned on GitHub";
const MAX_LINES = 5;

// `_COMMENTER` in triage/prepass.py: "[login (ASSOCIATION)]: " at a line start.
const COMMENTER = /^\[([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s\((\w*)\)\]: /gm;

/** Logins that commented, in order, from the stored comment text (`prepass.commenters`). */
export function commentersFromExcerpt(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(COMMENTER)) seen.add(match[1]);
  return [...seen];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `gh_assignees` in routing.py: the item's GitHub assignees, lower case. */
export function ghAssignees(prepass: TriagePrepass): Set<string> {
  return new Set(strings(prepass.gh_assignees).filter(Boolean).map((a) => a.toLowerCase()));
}

/** `assigned_elsewhere` in routing.py: GitHub assignees, none of them one of our maintainers. */
export function assignedElsewhere(prepass: TriagePrepass, maintainers: string[]): boolean {
  const assignees = ghAssignees(prepass);
  const ours = new Set(maintainers.map((m) => m.toLowerCase()));
  return assignees.size > 0 && ![...assignees].some((a) => ours.has(a));
}

/**
 * `involvement` in routing.py: "assigned on GitHub", then "authored #N" for
 * each named PR they wrote, then "commented".
 */
export function involvementOf(login: string, prepass: TriagePrepass): string[] {
  const me = login.toLowerCase();
  const authors = prepass.referenced_pr_authors;
  const out: string[] = ghAssignees(prepass).has(me) ? [GH_ASSIGNED] : [];
  if (authors && typeof authors === "object") {
    for (const [number, author] of Object.entries(authors)) {
      if (String(author).toLowerCase() === me) out.push(`authored #${number}`);
    }
  }
  if (strings(prepass.commenters).some((c) => c.toLowerCase() === me)) out.push("commented");
  return out;
}

/** `_excluded` in routing.py: the maintainer's hard "don't send me" for relevance. */
export function excludedFor(rules: TriageRules, facets: TriageFacets | null, prepass: TriagePrepass): boolean {
  const f = facets ?? {};
  const areas = new Set([...strings(f.areas), ...strings(prepass.areas)]);
  const factsHw = strings(f.hardware);
  const hardware = factsHw.length > 0 ? factsHw : strings(prepass.hardware_hints);
  const excludedHw = new Set(rules.exclude.hardware);
  return (
    (typeof f.type === "string" && rules.exclude.types.includes(f.type)) ||
    rules.exclude.areas.some((a) => areas.has(a)) ||
    (hardware.length > 0 && hardware.every((h) => excludedHw.has(h)))
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The away window covering today (UTC), as in `is_away`. */
export function awayWindow(maintainer: RoutingMaintainer, now: Date): { start: string; end: string } | null {
  const today = now.toISOString().slice(0, 10);
  for (const window of maintainer.away) {
    if (!DATE.test(window.start) || !DATE.test(window.end)) continue;
    if (window.start <= today && today <= window.end) return window;
  }
  return null;
}

interface Assessment {
  login: string;
  involvement: string[];
  level: RelevanceLevel | null;
  relevant: boolean;
  excluded: boolean;
  matched: string[];
  load: number;
  capacity: number;
  clear: boolean;
  isMatch: boolean;
  blocker: string | null;
  /** Blocked only by the weekly cap on a P0 that is neither new nor a clear match. */
  capOnPage: boolean;
  rank: number[];
}

function assess(input: WhyUnownedInput, m: RoutingMaintainer, relevance: Map<string, RelevanceLevel>): Assessment {
  const score = input.score ?? 0;
  const involvement = involvementOf(m.login, input.prepass);
  const level = relevance.get(m.login) ?? null;
  const excluded = excludedFor(m.rules, input.facets, input.prepass);
  const relevant = (level === "high" || level === "medium") && !excluded;
  const matched =
    matchRules(m.rules, { title: input.title, facets: input.facets, prepass: input.prepass, files: input.files })
      ?.matched ?? [];
  const load = input.load[m.login] ?? 0;
  const clear = involvement.length > 0 || (relevant && level === "high");
  const isMatch = involvement.length > 0 || relevant || matched.length > 0;
  const created = input.createdAt ? Date.parse(input.createdAt) : NaN;
  const fresh = !Number.isFinite(created) || input.now.getTime() - created <= FRESH_WINDOW_MS;

  // Same order as choose_owners: not_mine, min_score, away, then capacity.
  let blocker: string | null = null;
  let capOnPage = false;
  const away = awayWindow(m, input.now);
  if (input.notMine.includes(m.login)) blocker = "said it's not theirs";
  else if (score < m.minScore) blocker = `only takes items scoring ${m.minScore}+ (this is ${score})`;
  else if (away) blocker = `is away until ${away.end}`;
  else if (load >= m.capacityPerWeek && !(input.band === "page" && (fresh || clear))) {
    blocker = `already has ${load} of ${m.capacityPerWeek} items this week`;
    capOnPage = input.band === "page";
  }

  const assigned = involvement.includes(GH_ASSIGNED);
  const authored = involvement.some((i) => i.startsWith("authored"));
  const commented = involvement.includes("commented");
  const levelRank = relevant ? (level === "high" ? 2 : 1) : 0;
  return {
    login: m.login, involvement, level, relevant, excluded, matched, load,
    capacity: m.capacityPerWeek, clear, isMatch, blocker, capOnPage,
    // Candidate.rank in routing.py, then load share, then login.
    rank: [-Number(assigned), -Number(authored), -Number(commented), -levelRank, -matched.length, load / Math.max(1, m.capacityPerWeek)],
  };
}

function compareRank(a: Assessment, b: Assessment): number {
  for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return a.login < b.login ? -1 : a.login > b.login ? 1 : 0;
}

/** "wrote #123, which it names" / "commented on it" / "is a high match" / "matches their rule area:moe". */
function matchPhrase(a: Assessment): string {
  if (a.involvement.includes(GH_ASSIGNED)) return "is assigned to it on GitHub";
  const authored = a.involvement.find((i) => i.startsWith("authored"));
  if (authored) return `wrote ${authored.slice("authored ".length)} (which it names)`;
  if (a.involvement.includes("commented")) return "commented on it";
  if (a.relevant) return `is a ${a.level} match`;
  return `matches their rule ${a.matched[0]}`;
}

function listNames(names: string[], max = 4): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Why this item has no owner, mirroring the router (see the module comment). */
export function explainUnowned(input: WhyUnownedInput): WhyUnowned {
  const done = (summary: string, lines: string[] = [], pending = false): WhyUnowned => ({ summary, lines, pending });

  if (input.state !== "open") return done("It's closed on GitHub, so the router leaves it alone.");
  if (!input.inScope) return done("It's outside triage scope, so it isn't routed.");
  if (input.band === null || input.score === null) return done("It isn't scored yet, so it can't be routed.");
  if (input.band !== "page" && input.band !== "route") {
    return done(`P2/P3 items aren't routed; only P0 and P1 get an owner. This one is ${priorityLabel(input.band)}.`);
  }
  if (input.hidden) {
    const verb = input.hidden.action === "drop" ? "dropped it" : "marked it as slop";
    return done(`${input.hidden.actor} ${verb}, so the router won't route it again. Assign it by hand if it needs an owner.`);
  }
  if (input.doneBy) {
    return done(
      input.doneOnGithub
        ? `It was closed on GitHub while ${input.doneBy} owned it; their assignment comes back on the router's next run.`
        : `${input.doneBy} already marked it done, so the router won't route it again.`,
    );
  }
  if (!input.labelled) return done("Waiting for Claude to label it; routing starts after that.");
  // From here on the item is one of the router's candidates; the router only
  // reads the top ROUTE_LIMIT of those each run.
  const position = input.queuePosition ?? 0;
  if (position > ROUTE_LIMIT) {
    const inner = explainCandidate(input);
    return done(
      `It's #${position} in the router's queue, and the router only looks at the top ${ROUTE_LIMIT} unowned P0/P1 items each run.`,
      [inner.summary, ...inner.lines].slice(0, MAX_LINES),
    );
  }
  return explainCandidate(input);
}

/** choose_owners and the relevance wait in _route_one, for a routing candidate. */
function explainCandidate(input: WhyUnownedInput): WhyUnowned {
  const done = (summary: string, lines: string[] = [], pending = false): WhyUnowned => ({ summary, lines, pending });
  if (input.maintainers.length === 0) return done("No maintainers are active, so there's nobody to route to.");

  const logins = input.maintainers.map((m) => m.login);
  if (assignedElsewhere(input.prepass, logins)) {
    return done(
      `It's assigned on GitHub to ${listNames(strings(input.prepass.gh_assignees))}, who ${
        strings(input.prepass.gh_assignees).length === 1 ? "isn't a triage maintainer" : "aren't triage maintainers"
      }, so the router leaves it with them.`,
    );
  }

  // _route_one: wait for every active maintainer's judgement unless someone
  // is involved, but only for RELEVANCE_GRACE; then route among those judged.
  const current = new Map<string, RelevanceLevel>();
  const stale = new Set<string>();
  for (const r of input.relevance) {
    if (r.current) current.set(r.maintainer, r.relevance);
    else stale.add(r.maintainer);
  }
  const people = new Set([
    ...strings(input.prepass.commenters).map((c) => c.toLowerCase()),
    ...Object.values(input.prepass.referenced_pr_authors ?? {}).map((a) => String(a).toLowerCase()),
    ...ghAssignees(input.prepass),
  ]);
  const involved = input.maintainers.some((m) => people.has(m.login.toLowerCase()));
  const missing = input.maintainers.filter((m) => !current.has(m.login));
  const graceEnds =
    input.waitingSince === undefined
      ? undefined
      : input.waitingSince === null
        ? null
        : new Date(Date.parse(input.waitingSince) + RELEVANCE_GRACE_MS);
  // relevance_grace_over: no start time means no wait.
  const graceOver = graceEnds === null || (graceEnds !== undefined && input.now >= graceEnds);
  const partialLine =
    missing.length > 0 && !involved && graceOver
      ? `Not judged yet for ${listNames(missing.map((m) => m.login))}; the router stopped waiting for them after 2 hours.`
      : null;
  if (missing.length > 0 && !involved && !graceOver) {
    const total = input.maintainers.length;
    const lines: string[] = [];
    const noProfile = missing.filter((m) => !m.hasProfile).map((m) => m.login);
    const waiting = missing.filter((m) => m.hasProfile).map((m) => m.login);
    if (waiting.length > 0 && waiting.length < total) lines.push(`Not judged yet for ${listNames(waiting)}.`);
    if (noProfile.length > 0) {
      lines.push(
        `${listNames(noProfile)} ${noProfile.length === 1 ? "has" : "have"} no work profile yet, so Claude can't judge it for them; the router builds profiles every few minutes.`,
      );
    }
    if (input.extractionStatus !== "done") lines.push("It changed and is waiting to be labelled again first.");
    else if (missing.some((m) => stale.has(m.login))) lines.push("It changed since Claude last judged it; a fresh judgement is queued.");
    const after =
      graceEnds === undefined
        ? "2 hours after it became P0/P1"
        : `at ${graceEnds.toISOString().slice(0, 10) === input.now.toISOString().slice(0, 10) ? "" : `${graceEnds.toISOString().slice(0, 10)} `}${graceEnds.toISOString().slice(11, 16)} UTC`;
    return done(
      `Waiting for Claude to judge it for ${missing.length} of ${total} maintainers; routing goes ahead without them ${after}.`,
      lines,
    );
  }
  const result = explainMatches(input, current);
  return partialLine ? { ...result, lines: [...result.lines, partialLine] } : result;
}

/** choose_owners over the active maintainers, with the judgements that exist. */
function explainMatches(input: WhyUnownedInput, current: Map<string, RelevanceLevel>): WhyUnowned {
  const done = (summary: string, lines: string[] = [], pending = false): WhyUnowned => ({ summary, lines, pending });

  const assessed = input.maintainers.map((m) => assess(input, m, current)).sort(compareRank);
  const matches = assessed.filter((a) => a.isMatch);
  const free = matches.filter((a) => a.blocker === null);
  if (free.length > 0) {
    const top = free[0];
    const room = top.load >= top.capacity ? ", and a P0 like this may go over their weekly cap," : " and has room,";
    return done(
      `${top.login} ${matchPhrase(top)}${room} so the router should assign it on its next run (every 5 minutes).`,
      [],
      true,
    );
  }

  // One line per maintainer it matches (strongest first), then anyone Claude
  // rated relevant whose own `exclude` rules it out.
  const excludedRelevant = assessed.filter(
    (a) => !a.isMatch && a.excluded && (a.level === "high" || a.level === "medium"),
  );
  const personLines = [
    ...matches.map((a) => `${a.login} ${matchPhrase(a)} but ${a.blocker}.`),
    ...excludedRelevant.map((a) => `${a.login} is a ${a.level} match but their file excludes items like this.`),
  ];
  const lines =
    personLines.length <= MAX_LINES
      ? personLines
      : [...personLines.slice(0, MAX_LINES - 1), `…and ${personLines.length - (MAX_LINES - 1)} more.`];
  if (matches.some((a) => a.capOnPage)) {
    lines.push("A P0 only goes over someone's weekly cap when it's under 3 days old or clearly theirs (involved or high).");
  }
  // Everyone left was judged low or none, or (when someone involved let it
  // skip the wait for judgements) not judged yet.
  const others = assessed.filter((a) => !a.isMatch && !excludedRelevant.includes(a));
  if (others.length > 0 && personLines.length > 0) {
    lines.push(others.some((a) => a.level === null) ? "Everyone else is low, none, or not judged yet." : "Everyone else is low or none.");
  }

  if (personLines.length === 0) {
    return done(
      assessed.some((a) => a.level === null)
        ? "Nobody is a match: everyone judged is low or none, and no one's rules match it."
        : "Nobody is a match: everyone is low or none, and no one's rules match it.",
    );
  }
  if (matches.length === 0) return done("Nobody is a match.", lines);
  return done(
    matches.length === 1
      ? "Its only match can't take it right now."
      : `It matches ${matches.length} maintainers, but none of them can take it right now.`,
    lines,
  );
}
