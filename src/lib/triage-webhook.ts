import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_WEBHOOK_REPO = "vllm-project/vllm";

export interface QueuedWebhookItem {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  event: string;
}

/** Verify GitHub's `X-Hub-Signature-256` HMAC header using constant-time comparison. */
export function verifyWebhookSignature(body: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret || !signatureHeader.startsWith("sha256=")) return false;
  const providedHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(providedHex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Extract `(repo, number, kind, event)` targets to enqueue from a GitHub
 * webhook payload for `allowedRepo`. Unknown events or other repos return [].
 */
export function parseWebhookEvent(
  eventName: string,
  payload: unknown,
  allowedRepo: string = DEFAULT_WEBHOOK_REPO,
): QueuedWebhookItem[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  const repoObj = data.repository as { full_name?: unknown } | undefined;
  const repo = typeof repoObj?.full_name === "string" ? repoObj.full_name : "";
  if (repo.toLowerCase() !== allowedRepo.toLowerCase()) return [];

  const action = typeof data.action === "string" ? data.action : "";
  const label = action ? `${eventName}.${action}` : eventName;

  if (eventName === "issues") {
    const issue = data.issue as { number?: unknown } | undefined;
    const num = asPositiveInt(issue?.number);
    return num ? [{ repo, number: num, kind: "issue", event: label }] : [];
  }

  if (eventName === "pull_request" || eventName === "pull_request_review") {
    const pr = data.pull_request as { number?: unknown } | undefined;
    const num = asPositiveInt(pr?.number);
    return num ? [{ repo, number: num, kind: "pr", event: label }] : [];
  }

  if (eventName === "issue_comment") {
    const issue = data.issue as { number?: unknown; pull_request?: unknown } | undefined;
    const num = asPositiveInt(issue?.number);
    if (!num) return [];
    const kind: "issue" | "pr" = issue?.pull_request ? "pr" : "issue";
    return [{ repo, number: num, kind, event: label }];
  }

  if (eventName === "check_suite") {
    const suite = data.check_suite as { pull_requests?: unknown } | undefined;
    const prs = Array.isArray(suite?.pull_requests) ? suite.pull_requests : [];
    const seen = new Set<number>();
    const out: QueuedWebhookItem[] = [];
    for (const entry of prs) {
      const num = asPositiveInt((entry as { number?: unknown } | null)?.number);
      if (num && !seen.has(num)) {
        seen.add(num);
        out.push({ repo, number: num, kind: "pr", event: label });
      }
    }
    return out;
  }

  return [];
}
