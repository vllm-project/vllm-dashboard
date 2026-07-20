import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
