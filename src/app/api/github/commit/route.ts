import { NextResponse } from "next/server";

const VLLM_REPO = "vllm-project/vllm";
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

interface GithubCommitResponse {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { date?: string; name?: string };
    committer?: { date?: string };
  };
}

export type GithubCommitQuery = {
  sha: string; // Commit SHA matching ^[0-9a-f]{7,40}$ (case-insensitive); 400 if missing/invalid, 404 if not found
};

/**
 * Look up a commit in vllm-project/vllm
 * @description Proxies the GitHub API for a commit in vllm-project/vllm.
 * @params GithubCommitQuery
 * @tag GitHub
 * @openapi
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sha = (searchParams.get("sha") ?? "").trim();

  if (!sha) {
    return NextResponse.json({ error: "Missing sha" }, { status: 400 });
  }
  if (!SHA_PATTERN.test(sha)) {
    return NextResponse.json({ error: "Invalid sha" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vllm-dashboard",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const upstream = await fetch(
    `https://api.github.com/repos/${VLLM_REPO}/commits/${sha}`,
    { headers, next: { revalidate: 60 * 60 * 24 } }
  );

  if (upstream.status === 404) {
    return NextResponse.json(
      { error: "Commit not found" },
      { status: 404, headers: { "Cache-Control": "public, max-age=300" } }
    );
  }
  if (!upstream.ok) {
    return NextResponse.json(
      { error: `GitHub responded ${upstream.status}` },
      { status: 502 }
    );
  }

  const body = (await upstream.json()) as GithubCommitResponse;
  const fullMessage = body.commit?.message ?? "";
  const subject = fullMessage.split("\n", 1)[0] ?? "";
  const date = body.commit?.author?.date ?? body.commit?.committer?.date ?? null;

  return NextResponse.json(
    {
      sha: body.sha ?? sha,
      url: body.html_url ?? `https://github.com/${VLLM_REPO}/commit/${sha}`,
      date,
      message: subject,
      author: body.commit?.author?.name ?? null,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    }
  );
}
