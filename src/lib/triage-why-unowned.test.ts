import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_RULES } from "./triage-rules";
import type { TriageRules } from "./triage-types";
import {
  awayWindow,
  commentersFromExcerpt,
  excludedFor,
  explainUnowned,
  involvementOf,
  type RelevanceLevel,
  type RoutingMaintainer,
  type WhyUnownedInput,
} from "./triage-why-unowned";

const NOW = new Date("2026-11-18T12:00:00Z");
const OLD = "2026-11-01T00:00:00Z"; // older than the 3-day fresh window
const NEW = "2026-11-17T00:00:00Z";

function rules(patch: Partial<TriageRules> = {}): TriageRules {
  return { ...EMPTY_RULES, ...patch, exclude: { ...EMPTY_RULES.exclude, ...(patch.exclude ?? {}) } };
}

function person(login: string, patch: Partial<RoutingMaintainer> = {}): RoutingMaintainer {
  return { login, minScore: 40, capacityPerWeek: 10, away: [], rules: rules(), hasProfile: true, ...patch };
}

const TEN = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "gau-nernst"].map((l) => person(l));

function judged(levels: Record<string, RelevanceLevel>, current = true) {
  return Object.entries(levels).map(([maintainer, relevance]) => ({ maintainer, relevance, current }));
}

function allLow(except: Record<string, RelevanceLevel> = {}, people = TEN) {
  return judged(Object.fromEntries(people.map((p) => [p.login, except[p.login] ?? "low"])));
}

function input(patch: Partial<WhyUnownedInput> = {}): WhyUnownedInput {
  return {
    state: "open",
    inScope: true,
    band: "page",
    score: 99,
    labelled: true,
    extractionStatus: "done",
    createdAt: OLD,
    title: "DeepSeek-V3 crashes on B200",
    facets: { type: "bug", areas: ["moe"], hardware: ["B200"], summary: "EP hang" },
    prepass: { commenters: [] },
    files: [],
    relevance: allLow(),
    maintainers: TEN,
    load: {},
    notMine: [],
    hidden: null,
    doneBy: null,
    now: NOW,
    ...patch,
  };
}

test("items the router never looks at say why", () => {
  assert.match(explainUnowned(input({ state: "closed" })).summary, /closed on GitHub/);
  assert.match(explainUnowned(input({ inScope: false })).summary, /outside triage scope/);
  assert.match(explainUnowned(input({ band: null, score: null })).summary, /isn't scored yet/);
  assert.equal(
    explainUnowned(input({ band: "watch", score: 30 })).summary,
    "P2/P3 items aren't routed; only P0 and P1 get an owner. This one is P2.",
  );
  assert.match(explainUnowned(input({ hidden: { action: "drop", actor: "khluu" } })).summary, /^khluu dropped it, so the router won't route it again/);
  assert.match(explainUnowned(input({ hidden: { action: "slop", actor: "khluu" } })).summary, /marked it as slop/);
  assert.match(explainUnowned(input({ doneBy: "mgoin" })).summary, /mgoin already marked it done/);
  assert.match(explainUnowned(input({ labelled: false })).summary, /Waiting for Claude to label it/);
  assert.match(explainUnowned(input({ maintainers: [] })).summary, /No maintainers are active/);
});

test("waits for relevance judgements from everyone", () => {
  const why = explainUnowned(input({ relevance: allLow().slice(0, 8), waitingSince: "2026-11-18T11:30:00Z" }));
  assert.equal(
    why.summary,
    "Waiting for Claude to judge it for 2 of 10 maintainers; routing goes ahead without them at 13:30 UTC.",
  );
  assert.deepEqual(why.lines, ["Not judged yet for a9, gau-nernst."]);
  assert.equal(why.pending, false);
});

test("stale judgements count as missing, and say the item changed", () => {
  const relevance = [...allLow().slice(0, 9), { maintainer: "gau-nernst", relevance: "high" as const, current: false }];
  const why = explainUnowned(input({ relevance }));
  assert.match(why.summary, /^Waiting for Claude to judge it for 1 of 10 maintainers; routing goes ahead without them 2 hours after it became P0\/P1\.$/);
  assert.ok(why.lines.some((l) => /changed since Claude last judged it/.test(l)));
  const relabel = explainUnowned(input({ relevance, extractionStatus: "pending" }));
  assert.ok(relabel.lines.some((l) => /waiting to be labelled again/.test(l)));
});

test("a maintainer without a work profile blocks judging, and is named", () => {
  const maintainers = [...TEN.slice(0, 9), person("newbie", { hasProfile: false })];
  const why = explainUnowned(input({ maintainers, relevance: allLow({}, TEN.slice(0, 9)) }));
  assert.match(why.summary, /^Waiting for Claude to judge it for 1 of 10 maintainers; routing goes ahead without them 2 hours after it became P0\/P1\.$/);
  assert.match(why.lines[0], /^newbie has no work profile yet/);
});

test("someone already involved skips the wait for judgements", () => {
  const why = explainUnowned(
    input({ relevance: [], prepass: { commenters: ["Gau-Nernst"] } }),
  );
  assert.equal(why.pending, true);
  assert.match(why.summary, /^gau-nernst commented on it and has room/);
});

test("nobody is a match", () => {
  const why = explainUnowned(input({ relevance: allLow({ a1: "none" }) }));
  assert.equal(why.summary, "Nobody is a match: everyone is low or none, and no one's rules match it.");
  assert.deepEqual(why.lines, []);
});

test("a full weekly cap blocks a P1, with the numbers", () => {
  const why = explainUnowned(
    input({
      band: "route",
      score: 60,
      relevance: allLow({ "gau-nernst": "high" }),
      maintainers: [...TEN.slice(0, 9), person("gau-nernst", { capacityPerWeek: 8 })],
      load: { "gau-nernst": 8 },
    }),
  );
  assert.equal(why.summary, "Its only match can't take it right now.");
  assert.deepEqual(why.lines, ["gau-nernst is a high match but already has 8 of 8 items this week.", "Everyone else is low or none."]);
});

test("a P0 goes over the cap when it is fresh or a clear match, not otherwise", () => {
  const base = {
    maintainers: [...TEN.slice(0, 9), person("gau-nernst", { capacityPerWeek: 8 })],
    load: { "gau-nernst": 8 },
  };
  // High match: clear, so the cap doesn't apply to a P0.
  const high = explainUnowned(input({ ...base, relevance: allLow({ "gau-nernst": "high" }) }));
  assert.equal(high.pending, true);
  assert.match(high.summary, /^gau-nernst is a high match, and a P0 like this may go over their weekly cap/);
  // Medium on an old P0: capped, with the P0 rule spelled out.
  const medium = explainUnowned(input({ ...base, relevance: allLow({ "gau-nernst": "medium" }) }));
  assert.equal(medium.pending, false);
  assert.equal(medium.lines[0], "gau-nernst is a medium match but already has 8 of 8 items this week.");
  assert.match(medium.lines[1], /A P0 only goes over someone's weekly cap/);
  // Medium on a fresh P0: goes over.
  const fresh = explainUnowned(input({ ...base, createdAt: NEW, relevance: allLow({ "gau-nernst": "medium" }) }));
  assert.equal(fresh.pending, true);
});

test("min_score, away and not_mine block a match, in the router's order", () => {
  const relevance = allLow({ a1: "high", a2: "high", a3: "medium" });
  const maintainers = [
    person("a1", { minScore: 100 }),
    person("a2", { away: [{ start: "2026-11-10", end: "2026-12-03" }] }),
    person("a3"),
    ...TEN.slice(3),
  ];
  const why = explainUnowned(input({ relevance, maintainers, notMine: ["a3"] }));
  assert.equal(why.summary, "It matches 3 maintainers, but none of them can take it right now.");
  assert.deepEqual(why.lines, [
    "a1 is a high match but only takes items scoring 100+ (this is 99).",
    "a2 is a high match but is away until 2026-12-03.",
    "a3 is a medium match but said it's not theirs.",
    "Everyone else is low or none.",
  ]);
});

test("strongest first: authored beats commented beats high beats rules", () => {
  const maintainers = [person("r", { rules: rules({ areas: ["moe"] }) }), person("h"), person("c"), person("w")];
  const why = explainUnowned(
    input({
      maintainers,
      relevance: judged({ r: "low", h: "high", c: "low", w: "none" }),
      prepass: { commenters: ["c"], referenced_pr_authors: { "4242": "w" } },
      notMine: ["r", "h", "c", "w"],
    }),
  );
  assert.deepEqual(why.lines, [
    "w wrote #4242 (which it names) but said it's not theirs.",
    "c commented on it but said it's not theirs.",
    "h is a high match but said it's not theirs.",
    "r matches their rule area:moe but said it's not theirs.",
  ]);
});

test("the free match the router would pick is named", () => {
  const maintainers = [person("busy", { capacityPerWeek: 2 }), person("idle"), ...TEN.slice(2)];
  const why = explainUnowned(
    input({ band: "route", score: 50, maintainers, relevance: allLow({ busy: "high", idle: "medium" }, maintainers), load: { busy: 2 } }),
  );
  assert.equal(why.pending, true);
  assert.equal(why.summary, "idle is a medium match and has room, so the router should assign it on its next run (every 5 minutes).");
});

test("relevance ruled out by the person's own exclude is mentioned", () => {
  const maintainers = [person("amd", { rules: rules({ exclude: { types: [], areas: [], hardware: ["B200"] } }) }), ...TEN.slice(1)];
  const why = explainUnowned(input({ maintainers, relevance: allLow({ amd: "high" }, maintainers) }));
  assert.equal(why.summary, "Nobody is a match.");
  assert.deepEqual(why.lines, ["amd is a high match but their file excludes items like this.", "Everyone else is low or none."]);
});

test("at most five lines per maintainer list", () => {
  const relevance = allLow(Object.fromEntries(TEN.map((p) => [p.login, "high" as const])));
  const why = explainUnowned(input({ relevance, notMine: TEN.map((p) => p.login) }));
  assert.equal(why.lines.length, 5);
  assert.equal(why.lines[4], "…and 6 more.");
});

test("helpers mirror routing.py", () => {
  assert.deepEqual(commentersFromExcerpt("[mgoin (MEMBER)]: looks good\n\n[bob ()]: hi\n[mgoin (MEMBER)]: again"), ["mgoin", "bob"]);
  assert.deepEqual(commentersFromExcerpt("not [a (B)]: at line start"), []);
  assert.deepEqual(involvementOf("Mgoin", { referenced_pr_authors: { "1": "mgoin", "2": "x" }, commenters: ["MGOIN"] }), [
    "authored #1",
    "commented",
  ]);
  // Hardware excludes only when the item is about nothing but excluded hardware.
  const noAmd = rules({ exclude: { types: [], areas: [], hardware: ["MI300X"] } });
  assert.equal(excludedFor(noAmd, { hardware: ["MI300X"] }, {}), true);
  assert.equal(excludedFor(noAmd, { hardware: ["MI300X", "H100"] }, {}), false);
  assert.equal(excludedFor(noAmd, { hardware: [] }, { hardware_hints: ["MI300X"] }), true);
  assert.equal(excludedFor(rules({ exclude: { types: ["question"], areas: [], hardware: [] } }), { type: "question" }, {}), true);
  assert.equal(excludedFor(rules({ exclude: { types: [], areas: ["rocm"], hardware: [] } }), {}, { areas: ["rocm"] }), true);
  const away = person("x", { away: [{ start: "2026-11-18", end: "2026-11-18" }, { start: "bad", end: "2026-12-01" }] });
  assert.deepEqual(awayWindow(away, NOW), { start: "2026-11-18", end: "2026-11-18" });
  assert.equal(awayWindow(away, new Date("2026-11-19T00:00:00Z")), null);
});

test("a clear P0 match over their cap is still routed, and says so", () => {
  const why = explainUnowned(
    input({
      relevance: allLow({ "gau-nernst": "high" }),
      maintainers: [...TEN.slice(0, 9), person("gau-nernst", { capacityPerWeek: 8 })],
      load: { "gau-nernst": 9 },
    }),
  );
  assert.equal(why.pending, true);
  assert.equal(
    why.summary,
    "gau-nernst is a high match, and a P0 like this may go over their weekly cap, so the router should assign it on its next run (every 5 minutes).",
  );
});

test("past the router's per-run limit, that comes first", () => {
  const why = explainUnowned(input({ band: "route", score: 41, relevance: allLow({ a1: "high" }), queuePosition: 250 }));
  assert.equal(why.pending, false);
  assert.equal(why.summary, "It's #250 in the router's queue, and the router only looks at the top 200 unowned P0/P1 items each run.");
  assert.match(why.lines[0], /^a1 is a high match and has room/);
  assert.equal(explainUnowned(input({ relevance: allLow({ a1: "high" }), queuePosition: 200 })).pending, true);
});

test("someone involved lets it skip the wait; unjudged people are not called low", () => {
  const why = explainUnowned(
    input({ relevance: [], prepass: { commenters: ["a1"] }, notMine: ["a1"] }),
  );
  assert.deepEqual(why.lines, ["a1 commented on it but said it's not theirs.", "Everyone else is low, none, or not judged yet."]);
});

test("after the 2-hour wait it routes among those judged", () => {
  const relevance = allLow({ a1: "high" }).slice(0, 8); // a9 and gau-nernst unjudged
  const over = explainUnowned(input({ relevance, waitingSince: "2026-11-18T09:00:00Z" }));
  assert.equal(over.pending, true);
  assert.match(over.summary, /^a1 is a high match and has room/);
  assert.match(over.lines[0], /^Not judged yet for a9, gau-nernst; the router stopped waiting for them after 2 hours\.$/);
  // Exactly at the deadline counts as over (>= in relevance_grace_over).
  assert.equal(explainUnowned(input({ relevance, waitingSince: "2026-11-18T10:00:00Z" })).pending, true);
  // A wait that started on another day shows the date.
  const tomorrow = explainUnowned(input({ relevance, waitingSince: "2026-11-18T23:00:00Z" }));
  assert.match(tomorrow.summary, /without them at 2026-11-19 01:00 UTC\.$/);
  // The router can't tell when the wait started: it doesn't wait.
  assert.equal(explainUnowned(input({ relevance, waitingSince: null })).pending, true);
  // Unjudged people are never a relevance match, but rules still route.
  const rulesOnly = [...TEN.slice(0, 9), person("gau-nernst", { rules: rules({ areas: ["moe"] }) })];
  const viaRule = explainUnowned(input({ maintainers: rulesOnly, relevance: allLow({}, TEN.slice(0, 8)), waitingSince: null }));
  assert.match(viaRule.summary, /^gau-nernst matches their rule area:moe and has room/);
  // Nobody judged matches: say so without calling the unjudged "low".
  const none = explainUnowned(input({ relevance: allLow().slice(0, 8), waitingSince: null }));
  assert.equal(none.summary, "Nobody is a match: everyone judged is low or none, and no one's rules match it.");
});

test("assigned on GitHub to someone outside triage: left alone", () => {
  const why = explainUnowned(input({ prepass: { commenters: [], gh_assignees: ["outsider"] } }));
  assert.equal(why.summary, "It's assigned on GitHub to outsider, who isn't a triage maintainer, so the router leaves it with them.");
  assert.match(
    explainUnowned(input({ prepass: { gh_assignees: ["x", "y"] } })).summary,
    /to x, y, who aren't triage maintainers/,
  );
});

test("a GitHub assignee who is a maintainer is involved, ranks first, and skips the wait", () => {
  const why = explainUnowned(
    input({
      relevance: [],
      prepass: { commenters: ["a1"], gh_assignees: ["outsider", "A2"] },
      notMine: ["a1", "a2"],
    }),
  );
  assert.deepEqual(why.lines.slice(0, 2), [
    "a2 is assigned to it on GitHub but said it's not theirs.",
    "a1 commented on it but said it's not theirs.",
  ]);
  // Clear match: a P0 may go over the cap for them.
  const full = explainUnowned(
    input({ relevance: [], prepass: { gh_assignees: ["a2"] }, load: { a2: 10 } }),
  );
  assert.equal(full.pending, true);
  assert.match(full.summary, /^a2 is assigned to it on GitHub, and a P0 like this may go over their weekly cap/);
});

test("closed on GitHub while owned, then reopened: the assignment comes back", () => {
  const why = explainUnowned(input({ doneBy: "mgoin", doneOnGithub: true }));
  assert.match(why.summary, /closed on GitHub while mgoin owned it; their assignment comes back/);
});
