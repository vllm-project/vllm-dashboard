const apiToken = process.env.BUILDKITE_API_TOKEN;
const ingestToken = process.env.OTEL_INGEST_TOKEN;
const organization =
  process.env.BUILDKITE_ORGANIZATION ?? process.env.BUILDKITE_ORG_SLUG ?? "vllm";
const configuredEndpoint = process.env.OTEL_ENDPOINT;

if (!apiToken) throw new Error("BUILDKITE_API_TOKEN is not set");
if (!ingestToken) throw new Error("OTEL_INGEST_TOKEN is not set");
if (!configuredEndpoint) throw new Error("OTEL_ENDPOINT is not set");

const endpointUrl = new URL(configuredEndpoint);
if (endpointUrl.protocol !== "https:") {
  throw new Error("OTEL_ENDPOINT must use HTTPS");
}
if (endpointUrl.search || endpointUrl.hash) {
  throw new Error("OTEL_ENDPOINT must not contain a query string or fragment");
}

const endpoint = configuredEndpoint.replace(/\/+$/, "");
if (endpoint.endsWith("/v1/traces")) {
  throw new Error("OTEL_ENDPOINT must be the base URL without /v1/traces");
}

const apiBase = `https://api.buildkite.com/v2/organizations/${encodeURIComponent(organization)}`;
const buildStates = {
  build_passed: true,
  build_fixed: true,
  build_failed: true,
  build_blocked: true,
  build_canceled: true,
  build_failing: true,
  job_activated: true,
};

async function buildkiteRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = body?.message ?? body?.error ?? text ?? response.statusText;
    throw new Error(`Buildkite API ${response.status}: ${detail}`);
  }
  return body;
}

async function listServices() {
  const services = [];
  let next = `${apiBase}/services?per_page=100`;
  while (next) {
    const page = await buildkiteRequest(next);
    services.push(...(page.items ?? []));
    next = page.links?.next ?? null;
  }
  return services;
}

const services = await listServices();
const matches = services.filter(
  (service) =>
    service.provider?.id === "open_telemetry_tracing" &&
    service.settings?.endpoint?.replace(/\/+$/, "") === endpoint,
);

if (matches.length > 1) {
  throw new Error(
    `Found ${matches.length} OpenTelemetry services for ${endpoint}; reconcile them manually`,
  );
}

const payload = {
  provider: "open_telemetry_tracing",
  description: "vLLM CI dashboard trace ingestion",
  scope: "all",
  branch_configuration: "",
  build_states: buildStates,
  settings: {
    endpoint,
    service_name: "buildkite",
    headers: { Authorization: `Bearer ${ingestToken}` },
    resource_attributes: { destination: "vllm-ci-dashboard" },
  },
};

let service;
if (matches.length === 0) {
  service = await buildkiteRequest(`${apiBase}/services`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(`Created Buildkite OpenTelemetry service ${service.id}`);
} else {
  service = await buildkiteRequest(matches[0].url, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  console.log(`Updated Buildkite OpenTelemetry service ${service.id}`);
}

if (!service.enabled) {
  service = await buildkiteRequest(`${service.url}/enable`, { method: "PUT" });
  console.log(`Enabled Buildkite OpenTelemetry service ${service.id}`);
}

const verified = await buildkiteRequest(service.url);
if (
  verified.provider?.id !== "open_telemetry_tracing" ||
  verified.settings?.endpoint?.replace(/\/+$/, "") !== endpoint ||
  verified.scope !== "all" ||
  Object.keys(buildStates).some(
    (state) => verified.build_states?.[state] !== true,
  ) ||
  !verified.enabled
) {
  throw new Error("Buildkite OpenTelemetry service verification failed");
}

console.log(
  `Verified Buildkite OpenTelemetry service ${verified.id}: enabled, scope=all, endpoint=${endpoint}`,
);
