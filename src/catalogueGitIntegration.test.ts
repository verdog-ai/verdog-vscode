/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';

import {build} from 'esbuild';
import type * as vscode from 'vscode';

import type {CatalogueSummary} from '../model/catalogue';
import type {Outcome} from './cli';
import type {Preview} from './preview';
import {
  SUBMODULE_SYNC_ARGUMENTS,
  SUBMODULE_UPDATE_ARGUMENTS,
} from './checkoutCommands';
import {GITHUB_SSH_URL_REWRITE} from './githubGit';

interface MockUri {
  fsPath: string;
}

/** Bundle the real catalogue host code with only VS Code and process execution replaced. */
async function load<T>(
  entry: string,
  mocks: Record<string, Record<string, unknown>>,
): Promise<T> {
  const key = `verdog-test-${entry}-${Math.random()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = mocks;
  try {
    const result = await build({
      entryPoints: [path.resolve('src', entry)],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      mainFields: ['module', 'main'],
      plugins: [
        {
          name: 'test-boundaries',
          setup(builder) {
            builder.onResolve({filter: /.*/}, ({path: specifier}) =>
              specifier in mocks
                ? {path: specifier, namespace: 'mock'}
                : undefined,
            );
            builder.onLoad(
              {filter: /.*/, namespace: 'mock'},
              ({path: specifier}) => ({
                contents: Object.keys(mocks[specifier])
                  .map(
                    name =>
                      `export const ${name} = globalThis[${JSON.stringify(key)}]` +
                      `[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`,
                  )
                  .join('\n'),
              }),
            );
          },
        },
      ],
    });
    const code = `${result.outputFiles[0].text}\n//# sourceURL=verdog-test-${entry}`;
    return (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )) as T;
  } finally {
    delete globals[key];
  }
}

function outcome(code: number, stdout = '', stderr = ''): Outcome {
  return {code, combined: stdout + stderr, stderr, stdout};
}

function uri(fsPath: string): MockUri {
  return {fsPath};
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const commit = 'a'.repeat(40);
const repository = 'planning-and-learning/example';

test('an installed extension opens the generated workspace in a new window', async () => {
  const calls: unknown[][] = [];
  const launches: string[][] = [];
  const {openPreviewWorkspace} = await load<typeof import('./checkout')>(
    'checkout.ts',
    {
      './cli': {
        verdog: async (_root: string, args: string[]) => {
          launches.push([...args]);
          return outcome(0);
        },
      },
      vscode: {
        ExtensionMode: {Development: 2},
        commands: {
          executeCommand: async (...args: unknown[]) => {
            calls.push(args);
          },
        },
      },
    },
  );
  const workspace = uri(
    '/cache/preview-workspaces/release.code-workspace',
  ) as unknown as vscode.Uri;
  const context = {
    extensionMode: 1,
    extensionUri: uri('/extension') as unknown as vscode.Uri,
  };

  await openPreviewWorkspace(context, workspace, '/cache/release');

  assert.deepEqual(calls, [
    ['vscode.openFolder', workspace, {forceNewWindow: true}],
  ]);
  assert.deepEqual(launches, []);
});

test('development opens an isolated host with the local Verdog extension', async () => {
  const commands: unknown[][] = [];
  const launches: Array<{
    args: string[];
    command: string[] | undefined;
    root: string;
  }> = [];
  let launch = outcome(0);
  const {openPreviewWorkspace} = await load<typeof import('./checkout')>(
    'checkout.ts',
    {
      './cli': {
        verdog: async (
          root: string,
          args: string[],
          options: {command?: string[]},
        ) => {
          launches.push({
            args: [...args],
            command: options.command,
            root,
          });
          return launch;
        },
      },
      vscode: {
        ExtensionMode: {Development: 2},
        commands: {
          executeCommand: async (...args: unknown[]) => {
            commands.push(args);
          },
        },
      },
    },
  );
  const hash = 'b'.repeat(64);
  const workspace = uri(
    `/cache/preview-workspaces/${hash}.code-workspace`,
  ) as unknown as vscode.Uri;
  const context = {
    extensionMode: 2,
    extensionUri: uri('/src/verdog-vscode') as unknown as vscode.Uri,
  };

  await openPreviewWorkspace(context, workspace, '/cache/release');

  const userData = launches[0].args[2];
  assert.equal(path.basename(userData), `verdog-vscode-${hash.slice(0, 12)}`);
  assert.equal(path.dirname(userData), tmpdir());
  const environmentArgument = launches[0].args[4];
  assert.match(environmentArgument, /^--extensionEnvironment=/);
  const environment = JSON.parse(
    environmentArgument.slice('--extensionEnvironment='.length),
  ) as NodeJS.ProcessEnv;
  const pathVariable =
    Object.keys(process.env).find(name => name.toLowerCase() === 'path') ??
    'PATH';
  const executableDirectory = path.resolve(
    context.extensionUri.fsPath,
    '..',
    'verdog-cli',
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
  );
  const inherited = process.env[pathVariable];
  assert.equal(
    environment[pathVariable],
    inherited
      ? `${executableDirectory}${path.delimiter}${inherited}`
      : executableDirectory,
  );
  assert.deepEqual(commands, []);
  assert.deepEqual(launches, [
    {
      args: [
        '--new-window',
        '--user-data-dir',
        userData,
        '--extensionDevelopmentPath=/src/verdog-vscode',
        environmentArgument,
        workspace.fsPath,
      ],
      command: ['code'],
      root: '/cache/release',
    },
  ]);

  launch = outcome(1, '', 'launch failed\n');
  await assert.rejects(
    () => openPreviewWorkspace(context, workspace, '/cache/release'),
    /launch failed/,
  );
  assert.deepEqual(commands, []);
});

test('README fetch retries the exact release through command-scoped GitHub SSH', async () => {
  const readme = '# Example\n';
  const fetch = [
    'fetch',
    '--quiet',
    '--depth',
    '1',
    '--filter=blob:none',
    'origin',
    commit,
  ];
  const calls: string[][] = [];
  const run = async (_root: string, args: string[]): Promise<Outcome> => {
    calls.push([...args]);
    if (same(args, ['rev-parse', '--is-bare-repository'])) {
      return outcome(0, 'true\n');
    }
    if (same(args, ['remote', 'get-url', 'origin'])) {
      return outcome(0, `https://github.com/${repository}.git\n`);
    }
    if (same(args, fetch)) {
      return outcome(128, '', 'fatal: HTTPS credentials unavailable\n');
    }
    if (same(args, ['-c', GITHUB_SSH_URL_REWRITE, ...fetch])) {
      return outcome(0);
    }
    if (same(args, ['cat-file', '-s', `${commit}:README.md`])) {
      return outcome(0, `${Buffer.byteLength(readme)}\n`);
    }
    if (same(args, ['show', '--no-ext-diff', `${commit}:README.md`])) {
      return outcome(0, readme);
    }
    return outcome(1, '', `unexpected Git command: ${args.join(' ')}\n`);
  };
  const {fetchCatalogueReadme} = await load<
    typeof import('./catalogueMetadata')
  >('catalogueMetadata.ts', {
    vscode: {
      Uri: {file: uri},
      workspace: {fs: {createDirectory: async () => undefined}},
    },
    './cli': {verdog: run},
  });
  const entry: CatalogueSummary = {
    commit,
    dependency_count: 0,
    description: null,
    display_name: 'Example',
    id: '00000000-0000-4000-8000-000000000000',
    package: null,
    published_at: '2026-09-14T00:00:00Z',
    published_by_me: false,
    release_count: 1,
    releases: [],
    repository,
    visibility: 'restricted',
    workflow_id: 'main',
  };

  const result = await fetchCatalogueReadme(
    uri('/catalogue') as unknown as vscode.Uri,
    entry,
    undefined,
    () => undefined,
  );

  assert.deepEqual(result, {
    markdown: readme,
    path: 'README.md',
    state: 'ready',
  });
  assert.deepEqual(
    calls.filter(args => args.includes('fetch')),
    [fetch, ['-c', GITHUB_SSH_URL_REWRITE, ...fetch]],
  );
  assert.equal(
    calls.some(args => args[0] === 'config'),
    false,
  );
});

test('inspection retries source and recursive dependencies through command-scoped GitHub SSH', async () => {
  const sourceFetch = ['fetch', '--quiet', '--depth', '1', 'origin', commit];
  const submoduleSync = [...SUBMODULE_SYNC_ARGUMENTS];
  const submoduleUpdate = [...SUBMODULE_UPDATE_ARGUMENTS];
  const calls: string[][] = [];
  let checkedOut = false;
  const run = async (_root: string, args: string[]): Promise<Outcome> => {
    calls.push([...args]);
    if (same(args, ['rev-parse', '--git-dir'])) {
      return outcome(0, '.git\n');
    }
    if (same(args, ['remote', 'get-url', 'origin'])) {
      return outcome(0, `https://github.com/${repository}.git\n`);
    }
    if (same(args, sourceFetch)) {
      return outcome(128, '', 'fatal: HTTPS source denied\n');
    }
    if (same(args, ['-c', GITHUB_SSH_URL_REWRITE, ...sourceFetch])) {
      return outcome(0);
    }
    if (same(args, ['checkout', '--detach', '--force', '--quiet', commit])) {
      checkedOut = true;
      return outcome(0);
    }
    if (same(args, submoduleSync)) {
      return outcome(0);
    }
    if (same(args, submoduleUpdate)) {
      return outcome(128, '', 'fatal: HTTPS dependency denied\n');
    }
    if (same(args, ['-c', GITHUB_SSH_URL_REWRITE, ...submoduleUpdate])) {
      return outcome(0);
    }
    return outcome(1, '', `unexpected Git command: ${args.join(' ')}\n`);
  };
  const fs = {
    createDirectory: async () => undefined,
    readDirectory: async () => [],
    readFile: async () => {
      throw new Error('missing');
    },
    rename: async () => undefined,
    stat: async (location: MockUri) => {
      const name = path.basename(location.fsPath);
      if (checkedOut && (name === 'project.json' || name === '.gitmodules')) {
        return {};
      }
      throw new Error('missing');
    },
    writeFile: async () => undefined,
  };
  const {materialise} = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: {
      Uri: {
        file: uri,
        joinPath: (base: MockUri, ...parts: string[]) =>
          uri(path.join(base.fsPath, ...parts)),
      },
      workspace: {fs},
    },
    './cli': {verdog: run},
  });
  const preview: Preview = {commit, repository, workflow: 'main'};

  const result = await materialise(
    uri('/catalogue') as unknown as vscode.Uri,
    preview,
    () => undefined,
  );

  assert.equal(result?.dependencies, 'ready');
  assert.deepEqual(
    calls.filter(args => args.includes('fetch')),
    [sourceFetch, ['-c', GITHUB_SSH_URL_REWRITE, ...sourceFetch]],
  );
  assert.deepEqual(
    calls.filter(args => args.includes('submodule')),
    [
      submoduleSync,
      submoduleUpdate,
      ['-c', GITHUB_SSH_URL_REWRITE, ...submoduleUpdate],
    ],
  );
  assert.equal(
    calls.some(args => args[0] === 'config'),
    false,
  );
});

test('preview locking leaves generated environments writable while locking publisher sources', async () => {
  const calls: Array<{
    args: string[];
    command: string[] | undefined;
    root: string;
  }> = [];
  const {lockPreview} = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: {
      Uri: {file: uri},
      workspace: {
        fs: {
          readDirectory: async () => [
            ['.git', 2],
            ['.verdog', 2],
            ['.venv', 2],
            ['.vscode', 2],
            ['project.json', 1],
            ['src', 2],
          ],
        },
      },
    },
    './cli': {
      verdog: async (
        root: string,
        args: string[],
        options: {command?: string[]},
      ): Promise<Outcome> => {
        calls.push({
          args: [...args],
          command: options.command,
          root,
        });
        return outcome(0);
      },
    },
  });

  await lockPreview('/catalogue/exact-release', () => undefined);

  assert.deepEqual(calls, [
    {
      args: ['-R', 'a-w', '--', '.vscode', 'project.json', 'src'],
      command: ['chmod'],
      root: '/catalogue/exact-release',
    },
  ]);
});

test('legacy preview environment repair makes only an untracked real .venv writable', async () => {
  const root = '/catalogue/exact-release';
  const signal = new AbortController().signal;
  const calls: Array<{
    args: string[];
    command: string[] | undefined;
    root: string;
    signal?: AbortSignal;
  }> = [];
  const {preparePreviewEnvironment} = await load<typeof import('./checkout')>(
    'checkout.ts',
    {
      'node:fs/promises': {
        lstat: async (location: string) => {
          assert.equal(location, path.join(root, '.venv'));
          return {isDirectory: () => true};
        },
      },
      vscode: {Uri: {file: uri}, workspace: {fs: {}}},
      './cli': {
        verdog: async (
          calledRoot: string,
          args: string[],
          options: {command?: string[]; signal?: AbortSignal},
        ): Promise<Outcome> => {
          calls.push({
            args: [...args],
            command: options.command,
            root: calledRoot,
            signal: options.signal,
          });
          return outcome(0);
        },
      },
    },
  );

  assert.equal(
    await preparePreviewEnvironment(root, () => undefined, signal),
    true,
  );
  assert.deepEqual(calls, [
    {args: ['ls-files', '--', '.venv'], command: ['git'], root, signal},
    {
      args: ['-R', 'u+w', '--', '.venv'],
      command: ['chmod'],
      root,
      signal,
    },
  ]);
});

test('preview environment repair refuses symlinked and tracked .venv state', async () => {
  for (const scenario of [
    {
      directory: false,
      label: 'symlink',
      tracked: '',
      warning: /not a real directory/,
    },
    {
      directory: true,
      label: 'tracked',
      tracked: '.venv/pyvenv.cfg\n',
      warning: /source tracks \.venv/,
    },
  ]) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const {preparePreviewEnvironment} = await load<typeof import('./checkout')>(
      'checkout.ts',
      {
        'node:fs/promises': {
          lstat: async () => ({
            isDirectory: () => scenario.directory,
            isSymbolicLink: () => !scenario.directory,
          }),
        },
        vscode: {Uri: {file: uri}, workspace: {fs: {}}},
        './cli': {
          verdog: async (_root: string, args: string[]): Promise<Outcome> => {
            calls.push([...args]);
            return outcome(0, scenario.tracked);
          },
        },
      },
    );

    assert.equal(
      await preparePreviewEnvironment('/catalogue/exact-release', line =>
        logs.push(line),
      ),
      false,
      scenario.label,
    );
    assert.deepEqual(
      calls,
      scenario.directory ? [['ls-files', '--', '.venv']] : [],
      scenario.label,
    );
    assert.match(logs.join('\n'), scenario.warning, scenario.label);
  }
});
