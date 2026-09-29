import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const preview =
      process.env.NODE_ENV === "development" &&
      process.env.QUEUE_PREVIEW === "1";
    return {
      beforeFiles: preview
        ? [
            {
              source: "/api/metrics",
              destination: "http://127.0.0.1:3101/api/metrics",
            },
            {
              source: "/api/queue/jobs",
              destination: "http://127.0.0.1:3101/api/queue/jobs",
            },
          ]
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    return [
      {
        // Keep ingestion APIs on their configured hostname: cross-host
        // redirects can cause reporters to drop their Authorization header.
        source: "/gpu",
        has: [
          {
            type: "host",
            value: "vllm-ci-dashboard.vercel.app",
          },
        ],
        destination: "https://ci.vllm.ai/gpu",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
