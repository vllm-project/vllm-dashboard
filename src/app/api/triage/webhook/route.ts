import { getDb } from "@/lib/db";
import { triageEnabled } from "@/lib/triage-auth";
import { triageJson } from "@/lib/triage-http";
import { DEFAULT_WEBHOOK_REPO, parseWebhookEvent, verifyWebhookSignature } from "@/lib/triage-webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!triageEnabled()) {
    return triageJson({ error: "Not found" }, 404);
  }
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return triageJson({ error: "GitHub webhook secret not configured" }, 503);
  }
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(body, signature, secret)) {
    return triageJson({ error: "Invalid webhook signature" }, 401);
  }
  const event = (request.headers.get("x-github-event") ?? "").trim().toLowerCase();
  if (event === "ping") {
    return triageJson({ ok: true, pong: true });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return triageJson({ error: "Invalid JSON payload" }, 400);
  }
  const allowedRepo = process.env.TRIAGE_WEBHOOK_REPO?.trim() || DEFAULT_WEBHOOK_REPO;
  const items = parseWebhookEvent(event, payload, allowedRepo);
  if (items.length === 0) {
    return triageJson({ ok: true, queued: 0 });
  }
  const db = getDb();
  for (const item of items) {
    await db`
      INSERT INTO triage_webhook_queue (repo, number, kind, event, received_at)
      VALUES (${item.repo}, ${item.number}, ${item.kind}, ${item.event}, now())
      ON CONFLICT (repo, number) DO UPDATE SET
        kind = EXCLUDED.kind,
        event = EXCLUDED.event,
        received_at = EXCLUDED.received_at
    `;
  }
  return triageJson({ ok: true, queued: items.length });
}
