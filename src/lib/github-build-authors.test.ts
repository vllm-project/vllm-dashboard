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
    return Response.json({
      data: {
        repository: {
          item0: { author: { login: "cjackal" } },
          item1: { author: { login: "askliar" } },
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
  ]);

  assert.equal(builds[0].author, "cjackal");
  assert.equal(builds[0].pr_number, "55370");
  assert.equal(builds[1].author, "askliar");
  assert.equal(builds[1].pr_number, "55713");
});

test("uses the commit author when a build has no pull request", async (t) => {
  configureToken(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: {
        repository: {
          item0: { author: { user: { login: "direct-committer" } } },
        },
      },
    }),
  );

  const [build] = await enrichBuildAuthors([
    {
      message: "Direct commit",
      commit_sha: "1111111111111111111111111111111111111111",
      author: "Buildkite creator",
    },
  ]);

  assert.equal(build.author, "direct-committer");
  assert.equal(build.pr_number, null);
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
