# Incident priority

P0 means **interrupt normal work to contain an active critical incident**.
P1 means important work or an urgent verification task, handled through the
maintainer queue. A high calculated score is not enough to establish P0.

## Required evidence

All of the following must be established for automatic P0:

| Question | Qualifying evidence | Insufficient by itself |
|---|---|---|
| What breaks? | Outage, material silent wrong results, serious security exposure, effectively unusable service, broadly broken released distribution | An isolated crash, small numerical drift, a benchmark percentage, a security keyword |
| Who is exposed? | Broad supported-path impact or an identified critical deployment with concrete consequences | A popular model, H100, default flags, a file used by every request |
| Is it active for users? | Currently affected supported release or production deployment | Main-only failure, old release number, open issue, upcoming release blocker |
| What supports the claim? | Observed reproduction results, explicit maintainer confirmation, or a credible security advisory about this exposure | A command without results, an LLM confidence score, reactions, instructions to call it urgent |
| Can it be mitigated? | Failed/ruled-out recovery options or evidence that their risk/cost is unacceptable | Silence about workarounds, an assumption that rollback is easy or impossible |

Each answer carries a verbatim source excerpt. Extraction validates that the excerpt
occurs in the report; this prevents fabricated quotations, **not false source claims**.
The model still assesses meaning and can err. The dashboard exposes both its reasoning
and the evidence so maintainers can challenge the assessment. The bot does not claim
to have reproduced anything itself.

CPU, A100, AMD, TPU, multimodal, LoRA, distributed serving, and unusual configurations
all use this definition. Supported critical deployments can qualify on any backend;
rare or experimental features cannot qualify merely by causing a severe local symptom.
No hard CPU cap or mandatory tier-1/default configuration applies.

Security does not require a public exploit script. Credible serious exposure still
needs scope, affected-user and mitigation evidence. Unverified serious security
reports enter P1 verification rather than being discarded or automatically paged.
Private disclosure handling remains outside the public-issue ingestion system.

## Examples and boundaries

- A reproducible outage across supported production deployments, with failed
  rollback/fallback attempts: P0.
- A confirmed cross-tenant leak in an identified critical CPU deployment, without
  a safe mitigation: P0 even without a public reproduction script.
- A memory/performance regression that makes an important service unusable, with
  the same evidence of exposure and failed mitigation: P0. A percentage alone is not.
- An opt-in Rust frontend failing while the reporter successfully uses Python:
  ordinarily P1; do not infer an unmitigated broad serving outage.
- Small cache-logprob differences with a demonstrated low-cost workaround:
  investigate at P1/P2 according to impact; do not equate every difference with
  critical silent corruption.
- Five fewer correct answers on a fixed 132-question evaluation: evidence worth
  investigating, not proof of broad catastrophic correctness loss.
- Broken installation for a released artifact across supported environments can
  qualify without a model name or a GPU-specific severity flag.
- A failure confined to development main may be a release blocker, but is not P0
  without affected production users. A production deployment of main can qualify.

These examples guide extraction; they are not issue-number-specific score overrides.
An effective workaround may reduce urgency, but losing security, correctness or
essential service capacity is not an acceptable workaround just because it starts.

## Priority, readiness, and lifecycle

Scores order ordinary queue work. Qualifying incidents get a floor of 70; other
items get a ceiling of 69. Potentially critical reports missing evidence get a
floor of 40 so they remain visible for verification. Social points cannot cross
those policy boundaries. Low-confidence or contradictory evidence should be
investigated, not translated into a false claim of confirmed impact.

Fix PRs inherit the incident's score exactly. Draft state, failing CI, diff size,
missing tests or low-effort flags do not make the incident less urgent. Those
signals remain available to decide review readiness. Only actual fix references
inherit priority, not an incidental “related to” link. Existing issue/fix grouping
keeps competing fixes under their incident in the queue and digest.

`incident.status` is the assessment from the latest report evidence (active,
mitigated, resolved, unknown), separate from assignment acknowledgment. `release_blocker`
is likewise a separate evidence-backed field. Neither is a new manual status action.
Merging a fix does not by itself prove the affected deployment has recovered.

Open P0s remain in scope beyond the ordinary 30-day intake window, through both
routing expiration and later GitHub ingestion. Closing the item or losing P0
eligibility restores normal scope handling. This is not a backfill of incidents
that were already excluded before this policy existed.

## Rollout and review

Deploy the scoring worker and the extractor with prompt `v2-incident-evidence`.
Old extractions lack the required incident evidence: rescore them conservatively,
then reassess completed open in-scope reports under the existing extraction budget.
No database migration is needed. A falling P0 count during this transition is not
a quality metric; inspect the high-impact verification queue.

Validate both kinds of mistake: inappropriate pages **and missed emergencies**.
Use maintainer judgments and actual impact/mitigation evidence, not a desired P0
count. Update these definitions and the extractor/scorer tests together.
