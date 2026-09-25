/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Stage-one catalogue documentation.
 *
 * A catalogue record may read a README before the reader consents to inspection. The cache is
 * therefore a bare Git object database: no worktree, submodule, environment or project file is
 * created. Git uses the reader's credentials and the immutable published commit remains the
 * only revision we ask for.
 */

import {createHash} from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type {
  CatalogueDocumentation,
  CatalogueSummary,
} from '../model/catalogue';
import {packageDirectory} from '../model/names';
import {verdog} from './cli';
import {formatGitHubGitFailure, runGitHubGit} from './githubGit';
import {githubRemoteMatches} from './githubRemote';

const inflight = new Map<string, Promise<CatalogueDocumentation>>();
const MAX_README_BYTES = 1_000_000;

export function metadataRoot(storage: string, repository: string): string {
  const key = createHash('sha256').update(repository).digest('hex');
  return path.join(storage, 'catalogue-metadata', key);
}

export function readmeCandidates(packageName: string | null): string[] {
  return [
    'README.md',
    ...(packageName === null
      ? []
      : [`src/${packageDirectory(packageName)}/README.md`]),
  ];
}

async function runGit(
  root: string,
  args: string[],
  signal: AbortSignal | undefined,
) {
  return verdog(root, args, {command: ['git'], signal});
}

async function ensureBare(
  root: string,
  repository: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(root));
  const bare = await runGit(
    root,
    ['rev-parse', '--is-bare-repository'],
    signal,
  );
  if (bare.code === 0 && bare.stdout.trim() !== 'true') {
    log(
      'catalogue metadata cache is unexpectedly a worktree; remove it before retrying',
    );
    return false;
  }
  if (bare.code !== 0) {
    const initialized = await runGit(
      root,
      ['init', '--bare', '--quiet'],
      signal,
    );
    if (initialized.code !== 0) {
      log(
        `catalogue metadata cache could not be initialized: ${initialized.combined.trim()}`,
      );
      return false;
    }
  }
  const remote = await runGit(root, ['remote', 'get-url', 'origin'], signal);
  if (remote.code === 0) {
    if (githubRemoteMatches(remote.stdout, repository)) {
      return true;
    }
    log(
      `catalogue metadata cache has an unexpected origin; remove it before retrying`,
    );
    return false;
  }
  const added = await runGit(
    root,
    ['remote', 'add', 'origin', `https://github.com/${repository}.git`],
    signal,
  );
  if (added.code !== 0) {
    log(
      `catalogue metadata remote could not be configured: ${added.combined.trim()}`,
    );
    return false;
  }
  return true;
}

async function fetchFromGit(
  storage: vscode.Uri,
  entry: CatalogueSummary,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<CatalogueDocumentation> {
  const root = metadataRoot(storage.fsPath, entry.repository);
  if (!(await ensureBare(root, entry.repository, signal, log))) {
    return {
      detail:
        'The local metadata cache could not be initialized. See the Verdog output.',
      state: 'unavailable',
    };
  }
  const fetchResult = await runGitHubGit(
    args => runGit(root, args, signal),
    [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--filter=blob:none',
      'origin',
      entry.commit,
    ],
    signal,
  );
  const fetched = fetchResult.outcome;
  if (fetched.code !== 0) {
    const detail =
      fetched.code === 130
        ? 'README retrieval was cancelled.'
        : 'The exact release could not be read with your configured Git or GitHub SSH credentials.';
    log(
      `README fetch failed for ${entry.repository}@${entry.commit.slice(0, 12)}: ` +
        formatGitHubGitFailure(fetchResult),
    );
    return {detail, state: 'unavailable'};
  }
  for (const candidate of readmeCandidates(entry.package)) {
    const object = `${entry.commit}:${candidate}`;
    const sized = await runGit(root, ['cat-file', '-s', object], signal);
    if (sized.code === 130) {
      return {detail: 'README retrieval was cancelled.', state: 'unavailable'};
    }
    if (sized.code !== 0) {
      continue;
    }
    const bytes = Number(sized.stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_README_BYTES) {
      return {
        detail: 'This README exceeds the 1 MB catalogue reading limit.',
        state: 'unavailable',
      };
    }
    const shown = await runGit(root, ['show', '--no-ext-diff', object], signal);
    if (
      shown.code === 0 &&
      Buffer.byteLength(shown.stdout, 'utf8') <= MAX_README_BYTES
    ) {
      return {markdown: shown.stdout, path: candidate, state: 'ready'};
    }
    if (shown.code === 0) {
      return {
        detail: 'This README exceeds the 1 MB catalogue reading limit.',
        state: 'unavailable',
      };
    }
    if (shown.code === 130) {
      return {detail: 'README retrieval was cancelled.', state: 'unavailable'};
    }
  }
  return {
    detail: 'This release contains no root or package README.',
    state: 'absent',
  };
}

/** Read one exact release's README without creating a checkout. */
export function fetchCatalogueReadme(
  storage: vscode.Uri,
  entry: CatalogueSummary,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<CatalogueDocumentation> {
  const key = `${entry.repository}\0${entry.commit}\0${entry.package ?? ''}`;
  const existing = inflight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const promise = fetchFromGit(storage, entry, signal, log).finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}
