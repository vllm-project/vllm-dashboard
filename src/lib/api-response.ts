import { NextResponse } from "next/server";

interface SharedCachePolicy {
  maxAge: number;
  staleWhileRevalidate: number;
}

/**
 * Keep browser data fresh while letting Vercel's shared cache absorb cold
 * serverless starts and expensive backend queries. Once fresh data expires,
 * stale-while-revalidate serves the last useful response immediately and
 * refreshes it in the background.
 */
export function cachedJson<T>(
  data: T,
  { maxAge, staleWhileRevalidate }: SharedCachePolicy,
) {
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Vercel-CDN-Cache-Control":
        `public, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
    },
  });
}
