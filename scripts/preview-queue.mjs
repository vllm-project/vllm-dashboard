#!/usr/bin/env node

import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const SOURCE = "https://ci.vllm.ai";
const HOST = "127.0.0.1";
const PORT = 3101;
const ROUTES = new Map([
  ["/api/metrics", new Set(["hours", "queue", "v"])],
  ["/api/queue/jobs", new Set(["queue"])],
]);

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Queue-Preview-Source": SOURCE,
    ...headers,
  });
  response.end(JSON.stringify({ ...body, previewSource: SOURCE }));
}

async function readPublicData(url, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (attempt === 0 && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        await delay(500, undefined, { signal });
        continue;
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Unexpected public queue response");
      }
      return { response, body };
    } catch (error) {
      if (attempt > 0 || signal.aborted) throw error;
      await delay(500, undefined, { signal });
    }
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Queue preview only supports GET requests." }, {
      Allow: "GET",
    });
    return;
  }

  let incoming;
  try {
    incoming = new URL(request.url, `http://${HOST}:${PORT}`);
  } catch {
    sendJson(response, 400, { error: "Invalid preview request." });
    return;
  }

  const allowedParams = ROUTES.get(incoming.pathname);
  if (!allowedParams) {
    sendJson(response, 404, { error: "This endpoint is unavailable in queue preview." });
    return;
  }

  for (const [key, value] of incoming.searchParams) {
    if (!allowedParams.has(key) || value.length > 200) {
      sendJson(response, 400, { error: "Invalid queue preview query parameters." });
      return;
    }
  }
  const hours = incoming.searchParams.get("hours");
  if (hours !== null && (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 2160)) {
    sendJson(response, 400, { error: "History hours must be between 1 and 2160." });
    return;
  }

  const upstream = new URL(incoming.pathname, SOURCE);
  upstream.search = incoming.search;
  const signal = AbortSignal.timeout(20_000);

  try {
    const { response: publicResponse, body } = await readPublicData(upstream, signal);
    const retryAfter = publicResponse.headers.get("retry-after");
    sendJson(response, publicResponse.status, body, retryAfter ? {
      "Retry-After": retryAfter,
    } : {});
  } catch {
    sendJson(response, signal.aborted ? 504 : 502, {
      error: signal.aborted
        ? "Public queue data timed out. Retry in a moment."
        : "Public queue data could not be loaded. Retry in a moment.",
    });
  }
});

server.on("error", (error) => {
  console.error(`Queue preview could not start: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Queue preview data: http://${HOST}:${PORT}`);
  console.log(`Reading public queue metrics and job details from ${SOURCE}.`);
  console.log("Start the dashboard with QUEUE_PREVIEW=1 npm run dev, then open /queue.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close());
}
