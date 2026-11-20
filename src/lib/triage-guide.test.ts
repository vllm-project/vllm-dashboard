import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TRIAGE_SECTION } from "./dashboard-navigation";
import { GUIDE_FACTS } from "./triage-guide";
import { NOTIFY_MODES } from "./triage-vocab";

function python(name: string): string {
  return readFileSync(join(process.cwd(), "triage", name), "utf8");
}

test("the guide's routing windows match triage/pipeline.py", () => {
  const pipeline = python("pipeline.py");
  assert.match(pipeline, new RegExp(`^PROFILE_WINDOW = timedelta\\(days=${GUIDE_FACTS.profileDays}\\)$`, "m"));
  assert.match(pipeline, new RegExp(`^FRESH_WINDOW = timedelta\\(days=${GUIDE_FACTS.freshDays}\\)$`, "m"));
  assert.match(pipeline, new RegExp(`^RELEVANCE_GRACE = timedelta\\(hours=${GUIDE_FACTS.relevanceGraceHours}\\)$`, "m"));
  assert.match(pipeline, new RegExp(`^DEFAULT_DIGEST_HOUR = ${GUIDE_FACTS.defaultDigestHour}$`, "m"));
});

test("the guide's feedback and reminder windows match relevance.py and notify.py", () => {
  assert.match(python("relevance.py"), new RegExp(`^FEEDBACK_WINDOW = timedelta\\(days=${GUIDE_FACTS.feedbackDays}\\)$`, "m"));
  assert.match(python("notify.py"), new RegExp(`^WAITING_AFTER_DAYS = ${GUIDE_FACTS.waitingAfterDays}$`, "m"));
});

test("the guide's languages and notify modes match triage/maintainers.py", () => {
  const maintainers = python("maintainers.py");
  const languages = GUIDE_FACTS.languages.map((code) => `"${code}"`).join(", ");
  assert.ok(maintainers.includes(`language not in (${languages})`), "language list changed in maintainers.py");
  assert.ok(maintainers.includes('notify in ("immediate", "digest", "off")'), "notify modes changed in maintainers.py");
  assert.deepEqual([...GUIDE_FACTS.notifyModes], [...NOTIFY_MODES]);
});

test("the guide is linked from the triage header", () => {
  assert.ok(TRIAGE_SECTION.referenceLinks.some((link) => link.href === "/triage/guide"));
});
