// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Run one GitHub network operation with the user's configured Git transport first.
 *
 * Catalogue records retain canonical HTTPS remotes. If that transport cannot authenticate,
 * retry only this command through SSH; `git -c` leaves both repository and global
 * configuration untouched.
 */

import type { Outcome } from "./cli";

export const GITHUB_SSH_URL_REWRITE =
  "url.git@github.com:.insteadOf=https://github.com/";

export type GitHubGitAttempt = {
  outcome: Outcome;
  transport: "configured" | "github-ssh";
};

export type GitHubGitResult = {
  attempts: readonly GitHubGitAttempt[];
  outcome: Outcome;
  usedSshFallback: boolean;
};

export type GitRunner = (arguments_: string[]) => Promise<Outcome>;

function result(
  outcome: Outcome,
  attempts: readonly GitHubGitAttempt[],
  usedSshFallback: boolean,
): GitHubGitResult {
  return { attempts, outcome, usedSshFallback };
}

/** Run `arguments_`, retrying an ordinary Git failure with a command-local GitHub SSH rewrite. */
export async function runGitHubGit(
  run: GitRunner,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<GitHubGitResult> {
  const configured = await run([...arguments_]);
  const configuredAttempt: GitHubGitAttempt = {
    outcome: configured,
    transport: "configured",
  };
  if (
    configured.code === 0 ||
    configured.code === 127 ||
    configured.code === 130
  ) {
    return result(configured, [configuredAttempt], false);
  }

  // Check cancellation before invoking the runner a second time: callers can abort while the
  // configured attempt is settling, and a cancelled catalogue read must not start new I/O.
  if (signal?.aborted) return result(configured, [configuredAttempt], false);
  const ssh = await run([
    "-c",
    GITHUB_SSH_URL_REWRITE,
    ...arguments_,
  ]);
  return result(
    ssh,
    [configuredAttempt, { outcome: ssh, transport: "github-ssh" }],
    true,
  );
}

function attemptFailure(attempt: GitHubGitAttempt): string {
  const label = attempt.transport === "configured"
    ? "Configured Git transport"
    : "GitHub SSH fallback";
  const detail = attempt.outcome.combined.trim();
  const heading = `${label} failed (exit ${attempt.outcome.code})`;
  return detail ? `${heading}:\n${detail}` : `${heading} with no output.`;
}

/** Format every failed attempt, so an SSH retry never hides the original Git diagnostic. */
export function formatGitHubGitFailure(result_: GitHubGitResult): string {
  if (result_.outcome.code === 0) return "";
  return result_.attempts.map(attemptFailure).join("\n\n");
}
