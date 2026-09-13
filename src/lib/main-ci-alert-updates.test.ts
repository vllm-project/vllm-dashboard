import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMainCiAlertUpdate,
  sameMainCiAlertUpdate,
} from "./main-ci-alert-updates";

const validBody = {
  alertId: "42",
  failureJobId: "01a0932d-c77c-43cd-a431-2b4587aff590",
  kind: "fix_opened",
  message: " Opened the narrow fix. ",
  fixPrs: [
    {
      number: 56676,
      url: "https://github.com/vllm-project/vllm/pull/56676",
      title: " Fix collective RPC teardown ",
    },
  ],
  author: " Sherlock ",
  idempotencyKey: "sherlock:alert-42:pr-56676",
};

test("valid responder updates are trimmed and normalized", () => {
  const parsed = parseMainCiAlertUpdate(validBody);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.alertId, "42");
  assert.equal(parsed.value.message, "Opened the narrow fix.");
  assert.equal(parsed.value.author, "Sherlock");
  assert.equal(parsed.value.fixPrs[0].title, "Fix collective RPC teardown");
});

test("fix_opened requires a fix PR and only accepts safe links", () => {
  const missing = parseMainCiAlertUpdate({ ...validBody, fixPrs: [] });
  assert.deepEqual(missing, {
    ok: false,
    error: "fix_opened updates must include at least one fix PR.",
  });

  const unsafe = parseMainCiAlertUpdate({
    ...validBody,
    fixPrs: [{ ...validBody.fixPrs[0], url: "javascript:alert(1)" }],
  });
  assert.deepEqual(unsafe, {
    ok: false,
    error: "fixPrs[0].url must be a valid HTTPS URL.",
  });
});

test("invalid alert and failure identities are rejected", () => {
  assert.equal(
    parseMainCiAlertUpdate({ ...validBody, alertId: "0" }).ok,
    false,
  );
  assert.equal(
    parseMainCiAlertUpdate({ ...validBody, failureJobId: "latest" }).ok,
    false,
  );
});

test("duplicate fix PR URLs are rejected after URL normalization", () => {
  const parsed = parseMainCiAlertUpdate({
    ...validBody,
    fixPrs: [validBody.fixPrs[0], { ...validBody.fixPrs[0] }],
  });

  assert.deepEqual(parsed, {
    ok: false,
    error: "fixPrs must not contain duplicate URLs.",
  });
});

test("idempotency comparison covers every persisted content field", () => {
  const parsed = parseMainCiAlertUpdate(validBody);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const existing = {
    alert_id: parsed.value.alertId,
    failure_job_id: parsed.value.failureJobId,
    kind: parsed.value.kind,
    message: parsed.value.message,
    fix_prs: parsed.value.fixPrs,
    author: parsed.value.author,
  };

  assert.equal(sameMainCiAlertUpdate(existing, parsed.value), true);
  assert.equal(
    sameMainCiAlertUpdate(
      {
        ...existing,
        // PostgreSQL jsonb does not preserve JSON object key order.
        fix_prs: [
          {
            title: parsed.value.fixPrs[0].title,
            url: parsed.value.fixPrs[0].url,
            number: parsed.value.fixPrs[0].number,
          },
        ],
      },
      parsed.value,
    ),
    true,
  );
  assert.equal(
    sameMainCiAlertUpdate(
      { ...existing, message: "Different content" },
      parsed.value,
    ),
    false,
  );
});
