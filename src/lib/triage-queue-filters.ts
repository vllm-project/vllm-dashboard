import type { getDb } from "./db";
import type { QueueFilters } from "./triage-query";

type Db = ReturnType<typeof getDb>;

/** Build links once, before filtering/pagination; competitors may be outside the visible page. */
export function queueFocusCte(db: Db, focus: QueueFilters["focus"], review: QueueFilters["review"] = null) {
  if (focus !== "cleanup" && focus !== "has-fix" && review !== "cleanup") return db``;
  return db`WITH open_fix_links AS (
    SELECT DISTINCT p.item_key AS pr_key, p.repo, n.num AS issue_number
    FROM triage_items p
    LEFT JOIN LATERAL (
      SELECT x.facets FROM triage_extractions x WHERE x.item_key = p.item_key
      ORDER BY x.created_at DESC, x.id DESC LIMIT 1
    ) e ON true
    CROSS JOIN LATERAL jsonb_array_elements_text(
      (CASE WHEN jsonb_typeof(p.prepass->'fixes_issues') = 'array'
            THEN p.prepass->'fixes_issues' ELSE '[]'::jsonb END)
      || (CASE WHEN jsonb_typeof(e.facets->'pr'->'fixes_issues') = 'array'
               THEN e.facets->'pr'->'fixes_issues' ELSE '[]'::jsonb END)
    ) n(num)
    WHERE p.kind = 'pr' AND p.state = 'open' AND n.num ~ '^[0-9]{1,9}$'
  )`;
}

/** Predicates share the queue's i (item), e (latest extraction), and s (score) aliases. */
export function queueViewWhere(db: Db, filters: Pick<QueueFilters, "review" | "focus">) {
  const review = filters.review === "ready"
    ? db`AND i.kind = 'pr' AND i.state = 'open' AND NOT i.draft
         AND i.prepass->>'waiting_on' = 'reviewer'
         AND COALESCE(i.prepass->>'review_decision', '') <> 'APPROVED'`
    : filters.review === "blocked"
      ? db`AND i.kind = 'pr' AND i.state = 'open' AND i.prepass->>'waiting_on' = 'author'`
      : filters.review === "merge"
        ? db`AND i.kind = 'pr' AND i.state = 'open' AND NOT i.draft
             AND i.prepass->>'waiting_on' = 'reviewer'
             AND i.prepass->>'merge_ready' = 'true'
             AND (i.prepass->>'merge_checked_at')::timestamptz > now() - interval '1 hour'`
        : db``;
  return db`${review} ${queueFocusWhere(db, filters.focus)} ${filters.review === "cleanup" ? queueFocusWhere(db, "cleanup") : db``}`;
}

function queueFocusWhere(db: Db, value: QueueFilters["focus"]) {
  let focus = db``;
  switch (value) {
    case "cleanup":
      focus = db`AND i.kind = 'pr' AND i.state = 'open' AND (
        e.facets->'pr'->>'low_effort' = 'true'
        OR jsonb_array_length(CASE WHEN jsonb_typeof(e.facets->'slop_signals') = 'array'
             THEN e.facets->'slop_signals' ELSE '[]'::jsonb END) > 0
        OR EXISTS (
          SELECT 1 FROM open_fix_links a JOIN open_fix_links b
            ON a.repo = b.repo AND a.issue_number = b.issue_number AND a.pr_key <> b.pr_key
          WHERE a.pr_key = i.item_key
        ))`;
      break;
    case "fires":
      focus = db`AND i.state = 'open' AND (
        e.facets->'severity'->>'serving_broken' = 'true'
        OR e.facets->'severity'->>'security' = 'true'
        OR e.facets->>'type' IN ('regression', 'perf_regression')
        OR e.facets->'severity'->>'memory_regression' = 'true'
        OR CASE WHEN jsonb_typeof(e.facets->'severity'->'perf_regression_pct') = 'number'
             THEN (e.facets->'severity'->>'perf_regression_pct')::numeric > 0 ELSE false END)`;
      break;
    case "has-fix":
      focus = db`AND i.kind = 'issue' AND i.state = 'open' AND s.band IN ('page', 'route')
        AND EXISTS (SELECT 1 FROM open_fix_links l
                    WHERE l.repo = i.repo AND l.issue_number = i.number::text)`;
      break;
    case "stale":
      focus = db`AND i.state = 'open' AND s.band IN ('page', 'route') AND (
        (NOT EXISTS (SELECT 1 FROM triage_assignments a
                     WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked'))
         AND COALESCE(s.routable_since, s.scored_at) < now() - interval '3 days')
        OR (EXISTS (SELECT 1 FROM triage_assignments a
                    WHERE a.item_key = i.item_key AND a.role = 'primary' AND a.status = 'open'
                      AND a.assigned_at < now() - interval '3 days')
            AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                            WHERE a.item_key = i.item_key AND a.role = 'primary' AND a.status = 'acked'))
      )`;
  }
  return focus;
}
