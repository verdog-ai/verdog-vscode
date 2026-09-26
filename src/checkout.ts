/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Stage-two materialisation of an immutable catalogue release.
 *
 * The checkout cache is separate from the bare Stage-one metadata cache. Completion is an
 * explicit, atomically-written state rather than the accidental presence of `project.json`.
 */

import {lstat, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {verdog} from './cli';
import {
  SUBMODULE_SYNC_ARGUMENTS,
  SUBMODULE_UPDATE_ARGUMENTS,
} from './checkoutCommands';
import {formatGitHubGitFailure, runGitHubGit} from './githubGit';
import {githubRemoteMatches} from './githubRemote';
import {
  INSPECTION_MARKER,
  MARKER,
  PREVIEW_WORKSPACE_DIRECTORY,
  type InspectionState,
  type Preview,
  checkoutRoot,
  previewWorkspace,
  workspace,
} from './preview';

export {
  INSPECTION_MARKER,
  MARKER,
  PREVIEW_DIRECTORY,
  PREVIEW_WORKSPACE_DIRECTORY,
  type InspectionState,
  type Preview,
  checkoutRoot,
  previewWorkspace,
} from './preview';

export interface MaterialisedPreview {
  dependencies: 'incomplete' | 'ready';
  folder: vscode.Uri;
}

interface MaterialiseOptions {
  phase?: (label: string) => void;
  signal?: AbortSignal;
}

async function git(root: string, args: string[], signal?: AbortSignal) {
  return verdog(root, args, {command: ['git'], signal});
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function write(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function atomicWrite(uri: vscode.Uri, content: string): Promise<void> {
  const temporary = vscode.Uri.file(
    `${uri.fsPath}.tmp-${process.pid}-${Date.now()}`,
  );
  await write(temporary, content);
  await vscode.workspace.fs.rename(temporary, uri, {overwrite: true});
}

function samePreview(left: Preview, right: Preview): boolean {
  return (
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.workflow === right.workflow
  );
}

export async function readInspectionState(
  root: string,
  expected?: Preview,
): Promise<InspectionState | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(root, INSPECTION_MARKER)),
    );
    const value = JSON.parse(
      Buffer.from(raw).toString('utf8'),
    ) as Partial<InspectionState>;
    if (
      value.version !== 2 ||
      value.source !== 'ready' ||
      value.preview === undefined ||
      !['ready', 'incomplete'].includes(value.dependencies ?? '') ||
      !['ready', 'mismatch', 'unchecked'].includes(value.metadata ?? '') ||
      (expected !== undefined && !samePreview(value.preview, expected))
    ) {
      return undefined;
    }
    return value as InspectionState;
  } catch {
    return undefined;
  }
}

export async function writeInspectionState(
  root: string,
  state: InspectionState,
): Promise<void> {
  await atomicWrite(
    vscode.Uri.file(path.join(root, INSPECTION_MARKER)),
    `${JSON.stringify(state, undefined, 2)}\n`,
  );
}

async function markPreview(
  folder: vscode.Uri,
  preview: Preview,
): Promise<void> {
  await atomicWrite(
    vscode.Uri.file(path.join(folder.fsPath, MARKER)),
    `${JSON.stringify({repository: preview.repository, commit: preview.commit, workflow: preview.workflow}, undefined, 2)}\n`,
  );
}

async function headIs(
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const found = await git(root, ['rev-parse', 'HEAD'], signal);
  return (
    found.code === 0 &&
    found.stdout.trim().toLowerCase() === commit.toLowerCase()
  );
}

async function ensureRepository(
  root: string,
  repository: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  const inside = await git(root, ['rev-parse', '--git-dir'], signal);
  if (inside.code !== 0) {
    const initialized = await git(root, ['init', '--quiet'], signal);
    if (initialized.code !== 0) {
      log(`could not initialise ${root}: ${initialized.combined.trim()}`);
      return false;
    }
  }
  const remote = await git(root, ['remote', 'get-url', 'origin'], signal);
  if (remote.code === 0) {
    if (githubRemoteMatches(remote.stdout, repository)) {
      return true;
    }
    log(`preview cache has an unexpected origin; remove it before retrying`);
    return false;
  }
  const added = await git(
    root,
    ['remote', 'add', 'origin', `https://github.com/${repository}.git`],
    signal,
  );
  if (added.code !== 0) {
    log(`could not configure the preview remote: ${added.combined.trim()}`);
    return false;
  }
  return true;
}

async function changeMode(
  root: string,
  mode: 'a-w' | 'u+w',
  log: (line: string) => void,
): Promise<void> {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('The preview root must be a real directory.');
  }
  const entries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(root),
  );
  const changed = entries
    .filter(([, type]) => !(type & vscode.FileType.SymbolicLink))
    .map(([name]) => name)
    .filter(name => !['.git', '.verdog', '.venv'].includes(name));
  if (changed.length === 0) {
    return;
  }
  const result = await verdog(root, ['-R', mode, '--', ...changed], {
    command: ['chmod'],
  });
  if (result.code !== 0 && result.code !== 127) {
    log(
      `could not make preview files ${mode === 'a-w' ? 'read-only' : 'writable'}: ${result.combined.trim()}`,
    );
  }
}

/** Make the inspected sources read-only after every operation that legitimately writes them. */
export function lockPreview(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  return changeMode(root, 'a-w', log);
}

/** Refuse managed environments in publisher source or a reused inspection checkout. */
export async function sourceOnlyProblem(
  root: string,
): Promise<string | undefined> {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    return 'The preview root must be a real directory.';
  }
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (entry.name === '.git') {
      continue;
    }
    const location = path.join(root, entry.name);
    if (
      entry.name === '.venv' ||
      (entry.name === '.verdog' && entry.isSymbolicLink())
    ) {
      return `Source-only inspection refuses ${entry.name}; import into a trusted project to prepare an environment.`;
    }
    if (entry.name === '.verdog' && entry.isDirectory()) {
      try {
        await lstat(path.join(location, 'environments'));
        return 'Source-only inspection refuses .verdog/environments; import into a trusted project to prepare an environment.';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const problem = await sourceOnlyProblem(location);
      if (problem !== undefined) {
        return problem;
      }
    }
  }
  return undefined;
}

/** Await actual removal; VS Code's provider may move files and discard later deletion errors. */
export async function deleteCache(root: string): Promise<void> {
  let status;
  try {
    status = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (status.isDirectory() && !status.isSymbolicLink()) {
    // chmod does not follow links encountered below this verified real directory.
    const writable = await verdog(root, ['-R', 'u+w', '--', '.'], {
      command: ['chmod'],
    });
    if (writable.code !== 0 && writable.code !== 127) {
      throw new Error(
        `Could not unlock the catalogue cache: ${writable.combined.trim()}`,
      );
    }
  }
  await rm(root, {recursive: true, force: true});
}

/**
 * Fetch and check out one exact release. A returned folder is useful for reading even when a
 * dependency submodule was inaccessible; callers keep Import locked in that degraded state.
 */
export async function materialise(
  storage: vscode.Uri,
  preview: Preview,
  log: (line: string) => void,
  options: MaterialiseOptions = {},
): Promise<MaterialisedPreview | undefined> {
  const root = checkoutRoot(
    storage.fsPath,
    preview.repository,
    preview.commit,
    preview.workflow,
  );
  const folder = vscode.Uri.file(root);
  options.phase?.('Fetching exact source');
  await vscode.workspace.fs.createDirectory(folder);
  for (const location of [path.dirname(root), root]) {
    const status = await lstat(location);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      log(
        'The preview cache must contain real directories, not symbolic links.',
      );
      return undefined;
    }
  }
  if (
    !(await ensureRepository(root, preview.repository, options.signal, log))
  ) {
    return undefined;
  }

  let existing = await readInspectionState(root, preview);
  const hasProject = await exists(vscode.Uri.joinPath(folder, 'project.json'));
  const atCommit =
    hasProject && (await headIs(root, preview.commit, options.signal));
  if (!atCommit) {
    // A repaired worktree is a new inspection attempt. Never carry a previous checkout's
    // verification or environment claims across the repair, even though the cache key agrees.
    existing = undefined;
    await changeMode(root, 'u+w', log);
    const fetchResult = await runGitHubGit(
      args => git(root, args, options.signal),
      ['fetch', '--quiet', '--depth', '1', 'origin', preview.commit],
      options.signal,
    );
    const fetched = fetchResult.outcome;
    if (fetched.code !== 0) {
      log(
        `${preview.repository}@${preview.commit.slice(0, 12)} could not be fetched: ` +
          `${formatGitHubGitFailure(fetchResult)}\n` +
          'Verdog tried your normal Git configuration and its automatic GitHub SSH fallback.',
      );
      return undefined;
    }
    const checkedOut = await git(
      root,
      ['checkout', '--detach', '--force', '--quiet', preview.commit],
      options.signal,
    );
    if (checkedOut.code !== 0) {
      log(
        `${preview.commit.slice(0, 12)} could not be checked out: ${checkedOut.combined.trim()}`,
      );
      return undefined;
    }
  }
  if (!(await exists(vscode.Uri.joinPath(folder, 'project.json')))) {
    log(
      `${preview.repository}@${preview.commit.slice(0, 12)} has no project.json`,
    );
    return undefined;
  }

  let dependencies: 'incomplete' | 'ready' =
    existing?.dependencies ?? 'incomplete';
  const hasSubmodules = await exists(
    vscode.Uri.joinPath(folder, '.gitmodules'),
  );
  if (!hasSubmodules) {
    dependencies = 'ready';
  } else if (dependencies !== 'ready') {
    options.phase?.('Fetching pinned dependencies');
    await changeMode(root, 'u+w', log);
    const synchronized = await git(
      root,
      [...SUBMODULE_SYNC_ARGUMENTS],
      options.signal,
    );
    if (synchronized.code !== 0) {
      dependencies = 'incomplete';
      log(
        `pinned dependency URLs were not synchronized: ${synchronized.combined.trim()}`,
      );
    } else {
      const pinnedResult = await runGitHubGit(
        args => git(root, args, options.signal),
        [...SUBMODULE_UPDATE_ARGUMENTS],
        options.signal,
      );
      const pinned = pinnedResult.outcome;
      dependencies = pinned.code === 0 ? 'ready' : 'incomplete';
      if (pinned.code !== 0) {
        log(
          `pinned dependencies were not fetched: ${formatGitHubGitFailure(pinnedResult)}`,
        );
      }
    }
  }

  await markPreview(folder, preview);
  await writeInspectionState(root, {
    ...(existing?.catalogue === undefined
      ? {}
      : {catalogue: existing.catalogue}),
    dependencies,
    metadata: existing?.metadata ?? 'unchecked',
    preview,
    source: 'ready',
    version: 2,
  });
  return {dependencies, folder};
}

/** Write the settings-bearing workspace beside, never inside, the publisher's checkout. */
export async function configurePreviewWorkspace(
  storage: vscode.Uri,
  root: string,
  preview: Preview,
): Promise<vscode.Uri> {
  const location = vscode.Uri.file(
    previewWorkspace(
      storage.fsPath,
      preview.repository,
      preview.commit,
      preview.workflow,
      preview.origin,
    ),
  );
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.file(path.dirname(location.fsPath)),
  );
  await atomicWrite(location, workspace(preview, root));
  await atomicWrite(
    vscode.Uri.file(`${location.fsPath}.json`),
    JSON.stringify(preview),
  );
  return location;
}

function developmentExtensionEnvironment(extensionRoot: string): string {
  const environment: NodeJS.ProcessEnv = {};
  const pathVariable =
    Object.keys(process.env).find(name => name.toLowerCase() === 'path') ??
    'PATH';
  const executableDirectory = path.resolve(
    extensionRoot,
    '..',
    'verdog-cli',
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
  );
  const inherited = process.env[pathVariable];
  environment[pathVariable] = inherited
    ? `${executableDirectory}${path.delimiter}${inherited}`
    : executableDirectory;
  return JSON.stringify(environment);
}

/** Open a preview in another window, including the local extension under development. */
export async function openPreviewWorkspace(
  context: Pick<vscode.ExtensionContext, 'extensionMode' | 'extensionUri'>,
  location: vscode.Uri,
  root: string,
): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    // VS Code permits only one development host for an extension path per instance. A short,
    // release-specific user-data directory gives the preview its own instance without risking
    // Unix-domain socket path limits or replacing the project from which it was opened.
    const key = path.basename(location.fsPath, '.code-workspace').slice(0, 12);
    const userData = path.join(tmpdir(), `verdog-vscode-${key}`);
    // The fresh instance has no original user settings. Give only its Extension Host the
    // CLI repository's development executable directory; installed previews never use this path.
    const launched = await verdog(
      root,
      [
        '--new-window',
        '--user-data-dir',
        userData,
        `--extensionDevelopmentPath=${context.extensionUri.fsPath}`,
        `--extensionEnvironment=${developmentExtensionEnvironment(context.extensionUri.fsPath)}`,
        location.fsPath,
      ],
      {command: ['code']},
    );
    if (launched.code !== 0) {
      const detail = launched.combined.trim();
      throw new Error(
        `code could not open the preview${detail ? `: ${detail}` : '.'}`,
      );
    }
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', location, {
    forceNewWindow: true,
  });
}

/** What this window is showing, or `undefined` for an ordinary clone. */
export async function readMarker(root: string): Promise<Preview | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(root, MARKER)),
    );
    const value = JSON.parse(
      Buffer.from(raw).toString('utf8'),
    ) as Partial<Preview>;
    if (
      typeof value.commit !== 'string' ||
      typeof value.repository !== 'string'
    ) {
      return undefined;
    }
    return {
      commit: value.commit,
      repository: value.repository,
      workflow: typeof value.workflow === 'string' ? value.workflow : '',
    };
  } catch {
    return undefined;
  }
}

/** Import destinations belong to one generated workspace, never the shared checkout. */
export async function readPreview(
  root: string,
  storage: vscode.Uri,
  workspaceFile: vscode.Uri | undefined,
): Promise<Preview | undefined> {
  const marker = await readMarker(root);
  if (marker === undefined || workspaceFile?.scheme !== 'file') {
    return marker;
  }
  if (
    path.dirname(workspaceFile.fsPath) !==
    path.join(storage.fsPath, PREVIEW_WORKSPACE_DIRECTORY)
  ) {
    return marker;
  }
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(`${workspaceFile.fsPath}.json`),
    );
    const launch = JSON.parse(Buffer.from(raw).toString('utf8')) as Preview;
    if (
      !samePreview(marker, launch) ||
      (launch.origin !== undefined &&
        (typeof launch.origin !== 'string' ||
          !path.isAbsolute(launch.origin))) ||
      path.resolve(root) !==
        checkoutRoot(
          storage.fsPath,
          marker.repository,
          marker.commit,
          marker.workflow,
        ) ||
      workspaceFile.fsPath !==
        previewWorkspace(
          storage.fsPath,
          marker.repository,
          marker.commit,
          marker.workflow,
          launch.origin,
        )
    ) {
      return marker;
    }
    return {
      ...marker,
      ...(launch.origin === undefined ? {} : {origin: launch.origin}),
    };
  } catch {
    return marker;
  }
}
