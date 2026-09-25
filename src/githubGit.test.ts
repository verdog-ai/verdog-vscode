import assert from "node:assert/strict";
import { test } from "node:test";

import type { Outcome } from "./cli";
import {
  GITHUB_SSH_URL_REWRITE,
  formatGitHubGitFailure,
  runGitHubGit,
} from "./githubGit";

function outcome(code: number, combined = ""): Outcome {
  return { code, combined, stderr: combined, stdout: "" };
}

test("GitHub Git uses the configured transport without an unnecessary retry", async () => {
  for (const code of [0, 127, 130]) {
    const calls: string[][] = [];
    const result = await runGitHubGit(async (arguments_) => {
      calls.push(arguments_);
      return outcome(code);
    }, ["fetch", "origin", "abc"]);

    assert.deepEqual(calls, [["fetch", "origin", "abc"]]);
    assert.equal(result.outcome.code, code);
    assert.equal(result.usedSshFallback, false);
    assert.equal(result.attempts.length, 1);
  }
});

test("GitHub Git retries a regular failure through command-scoped SSH", async () => {
  const calls: string[][] = [];
  const outcomes = [outcome(128, "HTTPS credentials unavailable"), outcome(0)];
  const result = await runGitHubGit(async (arguments_) => {
    calls.push(arguments_);
    return outcomes.shift() ?? outcome(1);
  }, ["fetch", "--depth", "1", "origin", "abc"]);

  assert.deepEqual(calls, [
    ["fetch", "--depth", "1", "origin", "abc"],
    [
      "-c",
      "url.git@github.com:.insteadOf=https://github.com/",
      "fetch",
      "--depth",
      "1",
      "origin",
      "abc",
    ],
  ]);
  assert.equal(GITHUB_SSH_URL_REWRITE, "url.git@github.com:.insteadOf=https://github.com/");
  assert.equal(result.outcome.code, 0);
  assert.equal(result.usedSshFallback, true);
  assert.equal(formatGitHubGitFailure(result), "");
});

test("GitHub Git checks cancellation before starting its SSH retry", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  const result = await runGitHubGit(async (arguments_) => {
    calls.push(arguments_);
    controller.abort();
    return outcome(128, "authentication failed");
  }, ["fetch", "origin", "abc"], controller.signal);

  assert.deepEqual(calls, [["fetch", "origin", "abc"]]);
  assert.equal(result.outcome.code, 128);
  assert.equal(result.usedSshFallback, false);
});

test("GitHub Git preserves diagnostics from both failed transports", async () => {
  const outcomes = [
    outcome(128, "fatal: HTTPS credentials unavailable\n"),
    outcome(255, "git@github.com: Permission denied (publickey).\n"),
  ];
  const result = await runGitHubGit(
    async () => outcomes.shift() ?? outcome(1),
    ["fetch", "origin", "abc"],
  );

  assert.equal(result.outcome.code, 255);
  assert.deepEqual(result.attempts.map((attempt) => attempt.outcome.code), [128, 255]);
  assert.equal(
    formatGitHubGitFailure(result),
    [
      "Configured Git transport failed (exit 128):\nfatal: HTTPS credentials unavailable",
      "GitHub SSH fallback failed (exit 255):\ngit@github.com: Permission denied (publickey).",
    ].join("\n\n"),
  );
});
