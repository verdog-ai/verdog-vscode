/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Compare the GitHub URL forms produced by Git and its `insteadOf` configuration. */
export function githubRemoteRepository(value: string): string | undefined {
  const remote = value
    .trim()
    .replace(/\/$/, '')
    .replace(/\.git$/i, '');
  for (const expression of [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/(?:git@)?github\.com\/([^/]+)\/([^/]+)$/i,
  ]) {
    const matched = expression.exec(remote);
    if (matched !== null) {
      return `${matched[1]}/${matched[2]}`;
    }
  }
  return undefined;
}

export function githubRemoteMatches(
  value: string,
  repository: string,
): boolean {
  return (
    githubRemoteRepository(value)?.toLowerCase() === repository.toLowerCase()
  );
}
