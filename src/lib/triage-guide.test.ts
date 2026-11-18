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
});

test("the guide's languages and notify modes match triage/maintainers.py", () => {
  const maintainers = python("maintainers.py");
  const languages = GUIDE_FACTS.languages.map((code) => `"${code}"`).join(", ");
  assert.ok(maintainers.includes(`language not in (${languages})`), "language list changed in maintainers.py");
  assert.ok(maintainers.includes('notify in ("immediate", "digest", "off")'), "notify modes changed in maintainers.py");
  assert.deepEqual([...GUIDE_FACTS.notifyModes], [...NOTIFY_MODES]);
});

test("the guide is linked from the triage tabs", () => {
  assert.ok(TRIAGE_SECTION.links.some((link) => link.href === "/triage/guide"));
});
