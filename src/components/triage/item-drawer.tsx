"use client";

import useSWR from "swr";
import {
  Assignee,
  Chips,
  GithubLink,
  KindBadge,
  ScoreCell,
  SeverityFlags,
  TypeLabel,
} from "@/components/triage/badges";
import { bandStyle } from "@/lib/triage-style";
import { ActionButtons } from "@/components/triage/action-buttons";
import { formatAge, triageFetcher } from "@/lib/triage-format";
import type { TriageItemDetail } from "@/lib/triage-types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-zinc-200 py-4 dark:border-zinc-800">
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200">{children}</dd>
    </div>
  );
}

function yesNo(value: boolean | null | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

/** Read-only JSON rendered as text (never HTML). */
function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-zinc-50 p-2 text-[11px] leading-4 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ItemDrawer({
  itemKey,
  viewer,
  onClose,
  onChanged,
}: {
  itemKey: string;
  viewer: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { data, error, mutate } = useSWR<TriageItemDetail>(
    `/api/triage/items/detail?key=${encodeURIComponent(itemKey)}`,
    triageFetcher,
  );

  const facets = data?.extraction?.facets ?? {};
  const severity = facets.severity ?? {};
  const openAssignments = data?.assignments.filter((a) => a.status === "open" || a.status === "acked") ?? [];
  const mine = viewer
    ? data?.assignments.find(
        (a) => a.maintainer.toLowerCase() === viewer.toLowerCase(),
      )
    : undefined;
  const mineOpen = mine && (mine.status === "open" || mine.status === "acked") ? mine : undefined;

  function refresh() {
    void mutate();
    onChanged?.();
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Triage item">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative h-full w-full max-w-2xl overflow-y-auto bg-white px-5 py-4 shadow-2xl dark:bg-zinc-950">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">{itemKey}</p>
            {data && (
              <h2 className="mt-1 text-base font-semibold leading-snug text-zinc-950 dark:text-zinc-50">
                <GithubLink href={data.item.htmlUrl}>{data.item.title}</GithubLink>
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="dashboard-control rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        {error && <p className="text-sm text-red-600">{error.message}</p>}
        {!data && !error && <p className="text-sm text-zinc-400">Loading…</p>}

        {data && (
          <>
            <div className="relative mb-3 flex items-center gap-4 pl-3">
              <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 rounded-full ${bandStyle(data.score?.band).fill}`} />
              <ScoreCell band={data.score?.band ?? null} score={data.score?.score ?? null} />
              <div className="flex flex-wrap items-center gap-2">
                <TypeLabel type={facets.type ?? null} />
                <SeverityFlags facets={facets} max={8} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-3 text-xs text-zinc-500">
              <KindBadge kind={data.item.kind} draft={data.item.draft} />
              <span>{data.item.state}</span>
              <span>by {data.item.author} ({data.item.authorAssociation.toLowerCase()})</span>
              <span>opened {formatAge(data.item.ghCreatedAt)} ago</span>
              <span>{data.item.reactions} reactions · {data.item.commentCount} comments</span>
            </div>
            {facets.summary && (
              <p className="pb-3 text-sm text-zinc-700 dark:text-zinc-300">{facets.summary}</p>
            )}

            <div className="pb-3">
              <ActionButtons
                itemKey={itemKey}
                assignmentId={mineOpen?.id ?? (mine && openAssignments.length === 0 ? mine.id : null)}
                mode={
                  mineOpen
                    ? mineOpen.status === "acked"
                      ? "acked"
                      : "open"
                    : openAssignments.length === 0
                      ? mine
                        ? "closed"
                        : "unassigned"
                      : "others"
                }
                onDone={refresh}
              />
              {!mineOpen && openAssignments.length > 0 && (
                <p className="mt-1 text-[11px] text-zinc-500">
                  Assigned to {openAssignments.map((a) => `${a.maintainer} (${a.role}, ${a.status})`).join(", ")}.
                  You can reassign it; other actions are for the assignee.
                </p>
              )}
            </div>

            <Section title="Score">
              {data.score ? (
                <table className="w-full text-xs">
                  <tbody>
                    {data.score.breakdown.map((entry, index) => (
                      <tr key={`${entry.factor}-${index}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                        <td className="py-1 pr-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{entry.factor}</td>
                        <td className="py-1 pr-2 text-zinc-500">{entry.detail ?? ""}</td>
                        <td className={`py-1 text-right tabular-nums ${entry.points < 0 ? "text-red-600" : "text-zinc-900 dark:text-zinc-100"}`}>
                          {entry.points > 0 ? `+${entry.points}` : entry.points}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="pt-2 font-semibold" colSpan={2}>Total ({data.score.scoringVersion})</td>
                      <td className="pt-2 text-right font-semibold tabular-nums">{data.score.score}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-zinc-500">Not scored yet (extraction: {data.item.extractionStatus}).</p>
              )}
            </Section>

            <Section title="Facets">
              {data.extraction ? (
                <dl>
                  <Row label="Type">{facets.type ?? "—"}</Row>
                  <Row label="Models"><Chips kind="model" values={(facets.models ?? []).map((m) => m?.name ?? "").filter(Boolean)} max={10} /></Row>
                  <Row label="Model traits"><Chips values={facets.model_traits ?? []} max={10} /></Row>
                  <Row label="Hardware"><Chips kind="hardware" values={facets.hardware ?? []} max={10} /></Row>
                  <Row label="Serving"><Chips kind="serving" values={facets.serving ?? []} max={20} /></Row>
                  <Row label="Areas"><Chips kind="area" values={facets.areas ?? []} max={10} /></Row>
                  <Row label="Serving broken">{yesNo(severity.serving_broken)}</Row>
                  <Row label="Crash / hang">{yesNo(severity.crash)} / {yesNo(severity.hang)}</Row>
                  <Row label="Wrong output">{yesNo(severity.wrong_output)}</Row>
                  <Row label="Perf regression">{severity.perf_regression_pct != null ? `${severity.perf_regression_pct}%` : "—"}</Row>
                  <Row label="Default config">{yesNo(facets.default_config)}</Row>
                  <Row label="Versions">
                    {facets.versions?.good ?? "?"} → {facets.versions?.bad ?? "?"} · main {yesNo(facets.versions?.affects_main)} · release {yesNo(facets.versions?.affects_latest_release)}
                  </Row>
                  <Row label="Repro">{yesNo(facets.has_repro)}</Row>
                  {facets.pr && <Row label="PR"><JsonBlock value={facets.pr} /></Row>}
                  <Row label="Slop signals"><Chips values={facets.slop_signals ?? []} max={10} /></Row>
                  <Row label="Confidence">{facets.confidence ?? "—"}</Row>
                  {facets.notes && <Row label="Notes">{facets.notes}</Row>}
                  <Row label="Model">{data.extraction.model} · {data.extraction.promptVersion} · {formatAge(data.extraction.createdAt)} ago</Row>
                </dl>
              ) : (
                <p className="text-xs text-zinc-500">
                  No extraction yet ({data.item.extractionStatus}
                  {data.item.extractionError ? `: ${data.item.extractionError}` : ""}).
                </p>
              )}
            </Section>

            <Section title="Prepass">
              <JsonBlock value={data.item.prepass} />
              {data.item.files.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500">{data.item.files.length} changed files</p>
              )}
            </Section>

            <Section title="Assignments">
              {data.assignments.length === 0 ? (
                <p className="text-xs text-zinc-500">Not routed.</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {data.assignments.map((assignment) => (
                    <li key={assignment.id}>
                      <Assignee login={assignment.maintainer} status={assignment.status} role={assignment.role} />{" "}
                      <span className="text-zinc-500">
                        {assignment.role} · by {assignment.assignedBy} {formatAge(assignment.assignedAt)} ago · score {assignment.scoreAtAssign}
                      </span>
                      {Object.keys(assignment.reason).length > 0 && <JsonBlock value={assignment.reason} />}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="History">
              {data.actions.length === 0 ? (
                <p className="text-xs text-zinc-500">No actions yet.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.actions.map((action) => (
                    <li key={action.id}>
                      <span className="font-medium">{action.actor}</span>{" "}
                      <span>{action.action}</span>
                      {action.target && <span> → {action.target}</span>}
                      <span className="text-zinc-500"> · {action.source} · {formatAge(action.createdAt)} ago</span>
                      {action.note && <p className="text-zinc-600 dark:text-zinc-400">{action.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
