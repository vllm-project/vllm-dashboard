import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseWebhookEvent, verifyWebhookSignature } from "./triage-webhook";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("verifyWebhookSignature checks HMAC-SHA256 strictly", () => {
  const secret = "top-secret-webhook-key";
  const body = JSON.stringify({ action: "opened" });
  assert.equal(verifyWebhookSignature(body, sign(body, secret), secret), true);
  assert.equal(verifyWebhookSignature(body, sign(body, "wrong"), secret), false);
  assert.equal(verifyWebhookSignature(body, "sha256=short", secret), false);
  assert.equal(verifyWebhookSignature(body, null, secret), false);
  assert.equal(verifyWebhookSignature(body, sign(body, secret), ""), false);
});

test("parseWebhookEvent extracts issues, PRs, comments, reviews, and check_suites", () => {
  const repo = { full_name: "vllm-project/vllm" };
  assert.deepEqual(
    parseWebhookEvent("issues", { action: "opened", repository: repo, issue: { number: 123 } }),
    [{ repo: "vllm-project/vllm", number: 123, kind: "issue", event: "issues.opened" }],
  );
  assert.deepEqual(
    parseWebhookEvent("pull_request", { action: "synchronize", repository: repo, pull_request: { number: 456 } }),
    [{ repo: "vllm-project/vllm", number: 456, kind: "pr", event: "pull_request.synchronize" }],
  );
  assert.deepEqual(
    parseWebhookEvent("issue_comment", {
      action: "created",
      repository: repo,
      issue: { number: 789, pull_request: { url: "u" } },
    }),
    [{ repo: "vllm-project/vllm", number: 789, kind: "pr", event: "issue_comment.created" }],
  );
  assert.deepEqual(
    parseWebhookEvent("pull_request_review", { action: "submitted", repository: repo, pull_request: { number: 42 } }),
    [{ repo: "vllm-project/vllm", number: 42, kind: "pr", event: "pull_request_review.submitted" }],
  );
  assert.deepEqual(
    parseWebhookEvent("check_suite", {
      action: "completed",
      repository: repo,
      check_suite: { pull_requests: [{ number: 10 }, { number: 10 }, { number: 11 }] },
    }),
    [
      { repo: "vllm-project/vllm", number: 10, kind: "pr", event: "check_suite.completed" },
      { repo: "vllm-project/vllm", number: 11, kind: "pr", event: "check_suite.completed" },
    ],
  );
  // Other repos and unrelated events are ignored.
  assert.deepEqual(
    parseWebhookEvent("issues", { action: "opened", repository: { full_name: "other/repo" }, issue: { number: 1 } }),
    [],
  );
  assert.deepEqual(parseWebhookEvent("star", { action: "created", repository: repo }), []);
});
