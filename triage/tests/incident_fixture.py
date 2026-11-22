"""Illustrative critical incident with verbatim supporting evidence."""
REPORT = (
    "Normal requests fail across supported deployments. "
    "The supported release is failing in production today. "
    "We reproduced this and captured server errors. "
    "Rollback and fallback configurations failed to restore service."
)
INCIDENT = dict(
    impact="outage", exposure="broad_supported", affected_context="supported_release",
    verification="reproduced", mitigation="none", status="active", release_blocker=None,
    reason="Normal traffic fails across supported deployments; recovery attempts failed.",
    evidence=dict(impact="Normal requests fail across supported deployments.",
                  exposure="Normal requests fail across supported deployments.",
                  current="The supported release is failing in production today.",
                  verification="We reproduced this and captured server errors.",
                  mitigation="Rollback and fallback configurations failed to restore service."),
)

