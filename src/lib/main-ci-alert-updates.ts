import type {
  MainCiAlertUpdateKind,
  MainCiSuspectedFixPr,
} from "@/lib/alerts-main-ci";

const UPDATE_KINDS = new Set<MainCiAlertUpdateKind>([
  "note",
  "diagnosis",
  "fix_opened",
  "monitoring",
]);
const BUILDKITE_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,18}$/;

export interface MainCiAlertUpdateInput {
  alertId: string;
  failureJobId: string;
  kind: MainCiAlertUpdateKind;
  message: string;
  fixPrs: MainCiSuspectedFixPr[];
  author: string;
  idempotencyKey: string;
}

export type MainCiAlertUpdateParseResult =
  | { ok: true; value: MainCiAlertUpdateInput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string } | { error: string } {
  if (typeof value !== "string") {
    return { error: `${field} must be a string.` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return {
      error: `${field} must contain 1 to ${maxLength} characters after trimming.`,
    };
  }
  return { value: trimmed };
}

function parseAlertId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === "string" && POSITIVE_INTEGER.test(value)
    ? value
    : null;
}

function parseFixPr(
  value: unknown,
  index: number,
): { value: MainCiSuspectedFixPr } | { error: string } {
  if (!isRecord(value)) {
    return { error: `fixPrs[${index}] must be an object.` };
  }
  const urlValue = boundedString(value.url, `fixPrs[${index}].url`, 2048);
  if ("error" in urlValue) return { error: urlValue.error };
  let url: URL;
  try {
    url = new URL(urlValue.value);
  } catch {
    return { error: `fixPrs[${index}].url must be a valid HTTPS URL.` };
  }
  if (url.protocol !== "https:") {
    return { error: `fixPrs[${index}].url must be a valid HTTPS URL.` };
  }

  const title = boundedString(value.title, `fixPrs[${index}].title`, 300);
  if ("error" in title) return { error: title.error };
  const number = value.number;
  if (
    number !== null &&
    (typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0)
  ) {
    return {
      error: `fixPrs[${index}].number must be a positive integer or null.`,
    };
  }
  return {
    value: {
      url: url.toString(),
      number: number as number | null,
      title: title.value,
    },
  };
}

/** Validate and normalize one authenticated responder update. */
export function parseMainCiAlertUpdate(
  body: unknown,
): MainCiAlertUpdateParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const alertId = parseAlertId(body.alertId);
  if (alertId === null) {
    return { ok: false, error: "alertId must be a positive integer." };
  }
  const failureJobId = boundedString(body.failureJobId, "failureJobId", 128);
  if ("error" in failureJobId) return { ok: false, error: failureJobId.error };
  if (!BUILDKITE_JOB_ID.test(failureJobId.value)) {
    return {
      ok: false,
      error: "failureJobId must be a Buildkite job UUID.",
    };
  }
  if (typeof body.kind !== "string" || !UPDATE_KINDS.has(body.kind as MainCiAlertUpdateKind)) {
    return {
      ok: false,
      error: "kind must be one of: note, diagnosis, fix_opened, monitoring.",
    };
  }
  const message = boundedString(body.message, "message", 4000);
  if ("error" in message) return { ok: false, error: message.error };
  const author = boundedString(body.author, "author", 80);
  if ("error" in author) return { ok: false, error: author.error };
  const idempotencyKey = boundedString(
    body.idempotencyKey,
    "idempotencyKey",
    200,
  );
  if ("error" in idempotencyKey) {
    return { ok: false, error: idempotencyKey.error };
  }
  if (!Array.isArray(body.fixPrs) || body.fixPrs.length > 10) {
    return {
      ok: false,
      error: "fixPrs must be an array containing at most 10 PRs.",
    };
  }
  const fixPrs: MainCiSuspectedFixPr[] = [];
  const fixPrUrls = new Set<string>();
  for (const [index, candidate] of body.fixPrs.entries()) {
    const parsed = parseFixPr(candidate, index);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (fixPrUrls.has(parsed.value.url)) {
      return { ok: false, error: "fixPrs must not contain duplicate URLs." };
    }
    fixPrUrls.add(parsed.value.url);
    fixPrs.push(parsed.value);
  }
  if (body.kind === "fix_opened" && fixPrs.length === 0) {
    return {
      ok: false,
      error: "fix_opened updates must include at least one fix PR.",
    };
  }

  return {
    ok: true,
    value: {
      alertId,
      failureJobId: failureJobId.value,
      kind: body.kind as MainCiAlertUpdateKind,
      message: message.value,
      fixPrs,
      author: author.value,
      idempotencyKey: idempotencyKey.value,
    },
  };
}

function canonicalFixPrs(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries: [number | null, string, string][] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const number = candidate.number;
    if (
      (number !== null && typeof number !== "number") ||
      typeof candidate.url !== "string" ||
      typeof candidate.title !== "string"
    ) {
      return null;
    }
    entries.push([number, candidate.url, candidate.title]);
  }
  return JSON.stringify(entries);
}

export function sameMainCiAlertUpdate(
  existing: {
    alert_id: string | number;
    failure_job_id: string;
    kind: MainCiAlertUpdateKind;
    message: string;
    fix_prs: unknown;
    author: string;
  },
  requested: MainCiAlertUpdateInput,
): boolean {
  return (
    String(existing.alert_id) === requested.alertId &&
    existing.failure_job_id === requested.failureJobId &&
    existing.kind === requested.kind &&
    existing.message === requested.message &&
    canonicalFixPrs(existing.fix_prs) === canonicalFixPrs(requested.fixPrs) &&
    existing.author === requested.author
  );
}
