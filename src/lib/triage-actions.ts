import type { AssignmentStatus, TriageAction } from "@/lib/triage-vocab";
import { TRIAGE_ACTIONS, isOneOf } from "@/lib/triage-vocab";
import { isValidLogin } from "@/lib/triage-auth";

/**
 * The pure state transition behind POST /api/triage/actions, per the action
 * table in triage/docs/data-model.md. The route loads the item's assignments
 * (locked), asks `planTriageAction` what to do, and applies the plan plus one
 * `triage_actions` row in a single transaction.
 *
 * Permissions (kept deliberately simple):
 * - ack / not_mine / drop / slop / done act on the actor's own open or acked
 *   assignment. `ack` with no open primary assignment on the item takes it:
 *   it creates an acked primary assignment for the actor.
 * - reassign may be done by any signed-in maintainer, on any open/acked
 *   assignment (or, when the item has none, it creates a primary for the
 *   target). The target must be an active maintainer other than the current
 *   assignee.
 * - reopen re-opens the actor's own most recently closed assignment, if the
 *   same role has no open assignment.
 */

export interface AssignmentState {
  id: number;
  maintainer: string;
  role: "primary" | "backup";
  status: AssignmentStatus;
  closedAt: string | null;
  assignedAt: string;
}

export interface ActionRequest {
  itemKey: string;
  action: TriageAction;
  assignmentId: number | null;
  target: string | null;
  note: string | null;
}

export interface ActionPlan {
  /** The assignment the action row refers to. */
  assignmentId: number | null;
  update: {
    id: number;
    status: AssignmentStatus;
    /** "close" sets closed_at = now(); "reopen" clears it. */
    closedAt: "close" | "reopen" | "keep";
  } | null;
  insert: {
    maintainer: string;
    role: "primary" | "backup";
    status: "open" | "acked";
  } | null;
}

export type PlanResult =
  | { ok: true; plan: ActionPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const ITEM_KEY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const OPEN: readonly AssignmentStatus[] = ["open", "acked"];

const CLOSING_STATUS: Partial<Record<TriageAction, AssignmentStatus>> = {
  not_mine: "not_mine",
  drop: "dropped",
  slop: "slop",
  done: "done",
};

export function isItemKey(value: unknown): value is string {
  return typeof value === "string" && ITEM_KEY.test(value) && value.length <= 200;
}

export function parseActionRequest(
  body: unknown,
): { ok: true; value: ActionRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };
  const input = body as Record<string, unknown>;
  if (!isItemKey(input.itemKey)) return { ok: false, error: "itemKey must look like owner/repo#123." };
  if (!isOneOf(TRIAGE_ACTIONS, input.action)) {
    return { ok: false, error: `action must be one of ${TRIAGE_ACTIONS.join(", ")}.` };
  }
  let assignmentId: number | null = null;
  if (input.assignmentId !== undefined && input.assignmentId !== null) {
    const id = Number(input.assignmentId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "assignmentId must be a positive integer." };
    assignmentId = id;
  }
  let target: string | null = null;
  if (input.action === "reassign") {
    if (typeof input.target !== "string" || !isValidLogin(input.target)) {
      return { ok: false, error: "reassign needs a target GitHub login." };
    }
    target = input.target;
  } else if (input.target !== undefined && input.target !== null) {
    return { ok: false, error: "Only reassign takes a target." };
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || input.note.length > 2000) {
      return { ok: false, error: "note must be text of at most 2000 characters." };
    }
    note = input.note.trim() || null;
  }
  return {
    ok: true,
    value: { itemKey: input.itemKey, action: input.action, assignmentId, target, note },
  };
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function planTriageAction(
  request: ActionRequest,
  actor: string,
  assignments: readonly AssignmentState[],
  activeMaintainers: ReadonlySet<string>,
): PlanResult {
  const open = assignments.filter((assignment) => OPEN.includes(assignment.status));
  const pick = (candidates: readonly AssignmentState[]) =>
    request.assignmentId !== null
      ? candidates.find((assignment) => assignment.id === request.assignmentId)
      : undefined;

  if (request.action === "reassign") {
    const target = request.target!;
    if (!activeMaintainers.has(target.toLowerCase())) {
      return { ok: false, status: 400, error: `${target} is not an active triage maintainer.` };
    }
    const current =
      pick(open) ??
      (request.assignmentId === null
        ? open.find((assignment) => sameLogin(assignment.maintainer, actor)) ??
          open.find((assignment) => assignment.role === "primary") ??
          open[0]
        : undefined);
    if (request.assignmentId !== null && !current) {
      return { ok: false, status: 409, error: "That assignment is not open." };
    }
    if (current && sameLogin(current.maintainer, target)) {
      return { ok: false, status: 400, error: `Already assigned to ${target}.` };
    }
    const role = current?.role ?? "primary";
    if (
      !current &&
      open.some((assignment) => assignment.role === role)
    ) {
      return { ok: false, status: 409, error: "The item already has an open assignment." };
    }
    return {
      ok: true,
      plan: {
        assignmentId: current?.id ?? null,
        update: current ? { id: current.id, status: "reassigned", closedAt: "close" } : null,
        insert: { maintainer: target, role, status: "open" },
      },
    };
  }

  if (request.action === "reopen") {
    const mine = assignments
      .filter(
        (assignment) =>
          sameLogin(assignment.maintainer, actor) && !OPEN.includes(assignment.status),
      )
      .sort((a, b) => (b.closedAt ?? b.assignedAt).localeCompare(a.closedAt ?? a.assignedAt));
    const chosen = request.assignmentId !== null ? pick(mine) : mine[0];
    if (!chosen) return { ok: false, status: 404, error: "You have no closed assignment on this item." };
    if (open.some((assignment) => assignment.role === chosen.role)) {
      return { ok: false, status: 409, error: `The item already has an open ${chosen.role} assignment.` };
    }
    return {
      ok: true,
      plan: {
        assignmentId: chosen.id,
        update: { id: chosen.id, status: "open", closedAt: "reopen" },
        insert: null,
      },
    };
  }

  // ack / not_mine / drop / slop / done: the actor's own open assignment.
  const own = open.filter((assignment) => sameLogin(assignment.maintainer, actor));
  let chosen: AssignmentState | undefined;
  if (request.assignmentId !== null) {
    const any = assignments.find((assignment) => assignment.id === request.assignmentId);
    if (!any) return { ok: false, status: 404, error: "No such assignment on this item." };
    if (!sameLogin(any.maintainer, actor)) {
      return { ok: false, status: 403, error: "That assignment belongs to someone else." };
    }
    if (!OPEN.includes(any.status)) return { ok: false, status: 409, error: "That assignment is already closed." };
    chosen = any;
  } else {
    chosen = own.find((assignment) => assignment.role === "primary") ?? own[0];
  }

  if (!chosen) {
    if (request.action === "ack" && !open.some((assignment) => assignment.role === "primary")) {
      return {
        ok: true,
        plan: {
          assignmentId: null,
          update: null,
          insert: { maintainer: actor, role: "primary", status: "acked" },
        },
      };
    }
    return { ok: false, status: 403, error: "You have no open assignment on this item." };
  }

  if (request.action === "ack") {
    if (chosen.status === "acked") return { ok: false, status: 409, error: "Already acknowledged." };
    return {
      ok: true,
      plan: {
        assignmentId: chosen.id,
        update: { id: chosen.id, status: "acked", closedAt: "keep" },
        insert: null,
      },
    };
  }

  return {
    ok: true,
    plan: {
      assignmentId: chosen.id,
      update: { id: chosen.id, status: CLOSING_STATUS[request.action]!, closedAt: "close" },
      insert: null,
    },
  };
}
