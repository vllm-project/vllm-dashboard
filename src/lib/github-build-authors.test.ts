import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { enrichBuildAuthors } from "./github-build-authors";

function configureToken(t: TestContext) {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  t.after(() => {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  });
}

test("uses the PR author instead of the merger or /ci commenter", async (t) => {
  configureToken(t);
  t.mock.method(globalThis, "fetch", async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = JSON.parse(String(init?.body)) as { query: string };
    assert.match(request.query, /pullRequest\(number: 55370\)/);
    assert.match(request.query, /pullRequest\(number: 55713\)/);
    assert.match(request.query, /associatedPullRequests\(first: 1\)/);
    return Response.json({
      data: {
        repository: {
          item0: { author: { login: "cjackal", name: "Chris Jack" } },
          item1: { author: { login: "askliar" } },
          item2: {
            author: { name: "Wei Zhao", user: { login: "wzhao18" } },
            associatedPullRequests: {
              nodes: [{ number: 55499, author: { login: "wzhao18", name: "Wei Zhao" } }],
            },
          },
        },
      },
    });
  });

  const builds = await enrichBuildAuthors([
    {
      message: "A fix (#55370)",
      commit_sha: "22d95d1adc24d5834ec45bb697170a76cf4c9a95",
      author: "Isotr0py",
    },
    {
      message: "PR #55713 /ci run by @benchislett",
      commit_sha: "bd31e0dc2e6d2f9ed8421c432d51682d2803d502",
      author: "vLLM CI Bot",
    },
    {
      message: "Full CI run - daily",
      commit_sha: "8c87c333b84c85908b1d11f0044457692277c6f3",
      author: null,
    },
  ]);

  assert.equal(builds[0].author, "Chris Jack");
  assert.equal(builds[0].pr_number, "55370");
  assert.equal(builds[1].author, "askliar");
  assert.equal(builds[1].pr_number, "55713");
  assert.equal(builds[2].author, "Wei Zhao");
  assert.equal(builds[2].pr_number, "55499");
});

test("uses linked commit authors and preserves existing metadata otherwise", async (t) => {
  configureToken(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: {
        repository: {
          item0: { author: { user: { login: "direct-committer" } } },
          item1: { author: { user: null } },
        },
      },
    }),
  );

  const [linked, unlinked] = await enrichBuildAuthors([
    {
      message: "Direct commit",
      commit_sha: "1111111111111111111111111111111111111111",
      author: "Buildkite creator",
    },
    {
      message: "Unlinked commit",
      commit_sha: "3333333333333333333333333333333333333333",
      author: "Existing author",
    },
  ]);

  assert.equal(linked.author, "direct-committer");
  assert.equal(linked.pr_number, null);
  assert.equal(unlinked.author, "Existing author");
});

test("preserves existing metadata when GitHub enrichment is unavailable", async (t) => {
  const saved = process.env.GITHUB_TOKEN;
  const savedGh = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  t.after(() => {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    if (savedGh !== undefined) process.env.GH_TOKEN = savedGh;
  });

  const [build] = await enrichBuildAuthors([
    {
      message: "A fix (#59999)",
      commit_sha: "2222222222222222222222222222222222222222",
      author: "Merge operator",
    },
  ]);

  assert.equal(build.author, "Merge operator");
  assert.equal(build.pr_number, "59999");
});
