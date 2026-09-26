/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  stat,
  chmod,
  symlink,
  lstat,
  rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';

import {build} from 'esbuild';
import type * as vscode from 'vscode';

import {
  decodeCatalogueDetail,
  type CatalogueSummary,
  type CatalogueDetail,
  type CatalogueRecord,
} from '../model/catalogue';
import type {Outcome} from './cli';
import type {InspectionState, Preview} from './preview';
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
      FileType: {File: 1, Directory: 2, SymbolicLink: 64},
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
    'node:fs/promises': {
      lstat: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      readdir,
      rm,
    },
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
    'node:fs/promises': {
      lstat: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      readdir,
      rm,
    },
    vscode: {
      FileType: {File: 1, Directory: 2, SymbolicLink: 64},
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
            ['outside', 66],
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

function filesystemVscode() {
  return {
    FileType: {File: 1, Directory: 2, SymbolicLink: 64},
    Uri: {
      file: (fsPath: string) => ({fsPath, scheme: 'file'}),
      joinPath: (base: MockUri, ...parts: string[]) => ({
        fsPath: path.join(base.fsPath, ...parts),
        scheme: 'file',
      }),
    },
    workspace: {
      fs: {
        createDirectory: async (location: MockUri) => {
          await mkdir(location.fsPath, {recursive: true});
        },
        readFile: (location: MockUri) => readFile(location.fsPath),
        writeFile: (location: MockUri, content: Uint8Array) =>
          writeFile(location.fsPath, content),
        rename: (from: MockUri, to: MockUri) => rename(from.fsPath, to.fsPath),
        readDirectory: async (location: MockUri) =>
          (await readdir(location.fsPath, {withFileTypes: true})).map(entry => [
            entry.name,
            entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : 1,
          ]),
      },
    },
  };
}

test('locking and removing a real cache leaves external symlink targets untouched', async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'verdog-preview-permissions-'),
  );
  const outside = path.join(temporary, 'outside');
  const root = path.join(temporary, 'preview');
  const module = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: filesystemVscode(),
  });
  try {
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'outside');
    await mkdir(path.join(root, 'src'), {recursive: true});
    await writeFile(path.join(root, 'src', 'file.py'), '# source');
    await symlink(outside, path.join(root, 'outside'));
    await symlink(outside, path.join(root, 'src', 'nested'));
    const before = (await stat(outside)).mode;
    await module.lockPreview(root, () => {});
    assert.equal((await stat(outside)).mode, before);
    await module.deleteCache(temporary, root);
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
    await assert.rejects(lstat(root), {code: 'ENOENT'});
    const link = path.join(temporary, 'root-link');
    await symlink(outside, link);
    await assert.rejects(
      module.lockPreview(link, () => {}),
      /real directory/,
    );
    await assert.rejects(module.deleteCache(temporary, link), /symbolic link/);
    assert.equal((await stat(outside)).mode, before);
  } finally {
    await chmod(root, 0o755).catch(() => {});
    await rm(temporary, {recursive: true, force: true});
  }
});

test('source-only inspection refuses old environments, including dependency environments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'verdog-preview-source-'));
  const module = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: filesystemVscode(),
  });
  try {
    assert.equal(await module.sourceOnlyProblem(root), undefined);
    await mkdir(path.join(root, 'external', 'dependency', '.venv'), {
      recursive: true,
    });
    assert.match((await module.sourceOnlyProblem(root)) ?? '', /refuses .venv/);
    await rm(path.join(root, 'external'), {recursive: true});
    await mkdir(path.join(root, '.verdog', 'environments'), {recursive: true});
    assert.match(
      (await module.sourceOnlyProblem(root)) ?? '',
      /refuses .verdog\/environments/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('launch workspaces restore independent origins and never reuse legacy ready receipts', async () => {
  const storagePath = await mkdtemp(
    path.join(tmpdir(), 'verdog-preview-origins-'),
  );
  const vscodeMock = filesystemVscode();
  const module = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: vscodeMock,
  });
  const preview = {repository, commit, workflow: 'main'};
  const root = module.checkoutRoot(storagePath, repository, commit, 'main');
  const storage = vscodeMock.Uri.file(storagePath) as unknown as vscode.Uri;
  try {
    await mkdir(path.join(root, '.git'), {recursive: true});
    await writeFile(
      path.join(root, module.MARKER),
      JSON.stringify({...preview, origin: '/stale'}),
    );
    const first = await module.configurePreviewWorkspace(storage, root, {
      ...preview,
      origin: '/projects/a',
    });
    const second = await module.configurePreviewWorkspace(storage, root, {
      ...preview,
      origin: '/projects/b',
    });
    assert.notEqual(first.fsPath, second.fsPath);
    assert.equal(
      (await module.readPreview(root, storage, first))?.origin,
      '/projects/a',
    );
    assert.equal(
      (await module.readPreview(root, storage, second))?.origin,
      '/projects/b',
    );
    assert.equal((await module.readMarker(root))?.origin, undefined);
    await writeFile(
      path.join(root, module.INSPECTION_MARKER),
      JSON.stringify({
        version: 1,
        source: 'ready',
        dependencies: 'ready',
        metadata: 'ready',
        environment: 'ready',
        preview,
      }),
    );
    assert.equal(await module.readInspectionState(root, preview), undefined);
    await module.writeInspectionState(root, {
      version: 2,
      source: 'ready',
      dependencies: 'ready',
      metadata: 'ready',
      preview,
    });
    assert.equal((await module.readInspectionState(root, preview))?.version, 2);
    assert.equal(
      'python.defaultInterpreterPath' in
        JSON.parse(await readFile(first.fsPath, 'utf8')).settings,
      false,
    );
  } finally {
    await rm(storagePath, {recursive: true, force: true});
  }
});

test('a queued authentication reload cannot supersede a newer interactive catalogue refresh', async () => {
  let provider!: {resolveWebviewView(view: vscode.WebviewView): void};
  let invalidate!: () => void;
  const commands = new Map<string, () => Promise<void>>();
  const messages: unknown[] = [];
  const requests: Array<{
    interactive: boolean;
    resolve: (result: Outcome) => void;
  }> = [];
  const {registerCatalogue} = await load<typeof import('./catalogueView')>(
    'catalogueView.ts',
    {
      './projectHost': {
        chooseSubroutineIn: () => {},
        cliCommand: () => ['verdog'],
        isEditable: () => false,
        refresh: () => {},
      },
      './verdogCommand': {
        backendCommand: (
          _root: string,
          _args: string[],
          options: {interactive: boolean},
        ) =>
          new Promise<Outcome>(resolve => {
            requests.push({interactive: options.interactive, resolve});
          }),
      },
      './webviewHtml': {webviewHtml: () => ''},
      vscode: {
        Uri: {
          joinPath: (base: MockUri, child: string) =>
            uri(path.join(base.fsPath, child)),
        },
        authentication: {onDidChangeSessions: () => ({dispose() {}})},
        commands: {
          registerCommand: (name: string, callback: () => Promise<void>) => {
            commands.set(name, callback);
            return {dispose() {}};
          },
        },
        window: {
          registerWebviewViewProvider: (
            _name: string,
            value: typeof provider,
          ) => {
            provider = value;
            return {dispose() {}};
          },
        },
        workspace: {
          onDidChangeConfiguration: (
            listener: (event: vscode.ConfigurationChangeEvent) => void,
          ) => {
            invalidate = () =>
              listener({
                affectsConfiguration: section =>
                  section === 'verdog.githubRepositoryAccess',
              });
            return {dispose() {}};
          },
        },
      },
    },
  );
  registerCatalogue(
    {
      subscriptions: [],
      extensionUri: uri('/extension'),
    } as unknown as vscode.ExtensionContext,
    {output: {appendLine() {}}} as unknown as Parameters<
      typeof registerCatalogue
    >[1],
  );
  provider.resolveWebviewView({
    webview: {
      onDidReceiveMessage() {},
      postMessage: (message: unknown) => {
        messages.push(message);
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewView);
  const refresh = commands.get('verdog.refreshCatalogue')!;
  const old = refresh();
  invalidate();
  const interactive = refresh();
  requests[0].resolve(outcome(0, JSON.stringify({entries: [], login: 'old'})));
  await old;
  assert.deepEqual(
    requests.map(request => request.interactive),
    [true, true],
  );
  requests[1].resolve(
    outcome(0, JSON.stringify({entries: [], login: 'renewed'})),
  );
  await interactive;
  assert.deepEqual(messages.at(-1), {
    kind: 'listing',
    listing: {entries: [], login: 'renewed', state: 'empty'},
  });
});

test('cache creation and deletion reject a symlinked parent and preserve outside files', async context => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verdog-cache-parent-'));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const storagePath = path.join(temporary, 'storage');
  const outside = path.join(temporary, 'outside');
  await mkdir(storagePath);
  await mkdir(outside);
  const protectedFile = path.join(outside, 'keep.code-workspace');
  await writeFile(protectedFile, 'outside');
  const vscodeMock = filesystemVscode();
  const module = await load<typeof import('./checkout')>('checkout.ts', {
    vscode: vscodeMock,
  });
  const storage = vscodeMock.Uri.file(storagePath) as unknown as vscode.Uri;
  await symlink(
    outside,
    path.join(storagePath, module.PREVIEW_WORKSPACE_DIRECTORY),
    'dir',
  );
  await assert.rejects(
    module.configurePreviewWorkspace(storage, '/source', {
      repository,
      commit,
      workflow: 'main',
    }),
    /symbolic link/,
  );
  await assert.rejects(
    module.deleteCache(
      storagePath,
      path.join(
        storagePath,
        module.PREVIEW_WORKSPACE_DIRECTORY,
        'keep.code-workspace',
      ),
    ),
    /symbolic link/,
  );
  await symlink(
    outside,
    path.join(storagePath, module.PREVIEW_DIRECTORY),
    'dir',
  );
  await assert.rejects(
    module.materialise(
      storage,
      {repository, commit, workflow: 'main'},
      () => {},
    ),
    /symbolic link/,
  );
  assert.equal(await readFile(protectedFile, 'utf8'), 'outside');
  assert.deepEqual(await readdir(outside), ['keep.code-workspace']);
});

test('an old incomplete inspection cannot overwrite a newer inspection of the same release', async () => {
  let provider!: {
    record: {
      revision: number;
      record: CatalogueRecord;
      finishIncomplete(
        root: string,
        preview: Preview,
        detail: CatalogueDetail,
        revision: number,
        message: string,
        metadata: 'unchecked',
      ): Promise<void>;
    };
  };
  let releaseRead!: (state: InspectionState | undefined) => void;
  const written: InspectionState[] = [];
  const {registerCatalogue} = await load<typeof import('./catalogueView')>(
    'catalogueView.ts',
    {
      './projectHost': {
        chooseSubroutineIn() {},
        cliCommand: () => ['verdog'],
        isEditable: () => false,
        refresh() {},
      },
      './verdogCommand': {backendCommand() {}},
      './webviewHtml': {webviewHtml: () => ''},
      './checkout': {
        checkoutRoot() {},
        configurePreviewWorkspace: async () => {},
        lockPreview: async () => {},
        materialise() {},
        deleteCache() {},
        sourceOnlyProblem() {},
        PREVIEW_DIRECTORY: 'preview-v2',
        PREVIEW_WORKSPACE_DIRECTORY: 'preview-workspaces-v2',
        openPreviewWorkspace() {},
        readMarker() {},
        readInspectionState: () =>
          new Promise<InspectionState | undefined>(resolve => {
            releaseRead = resolve;
          }),
        writeInspectionState: async (_root: string, state: InspectionState) => {
          written.push(state);
        },
      },
      vscode: {
        authentication: {onDidChangeSessions: () => ({dispose() {}})},
        commands: {registerCommand: () => ({dispose() {}})},
        window: {
          registerWebviewViewProvider: (
            _id: string,
            value: typeof provider,
          ) => {
            provider = value;
            return {dispose() {}};
          },
        },
        workspace: {onDidChangeConfiguration: () => ({dispose() {}})},
      },
    },
  );
  registerCatalogue(
    {
      subscriptions: [],
      globalStorageUri: uri('/cache'),
    } as unknown as vscode.ExtensionContext,
    {output: {appendLine() {}}} as unknown as Parameters<
      typeof registerCatalogue
    >[1],
  );
  const first = decodeCatalogueDetail({
    id: '11111111-1111-4111-a111-111111111111',
    repository,
    commit,
    workflow_id: 'main',
    package: 'example.project',
    published_at: '2026-09-02T10:00:00Z',
    scope: 'public',
    closure: [],
  });
  const second = {
    ...first,
    commit: 'b'.repeat(40),
    display_name: 'Second release',
  };
  const panel = provider.record;
  panel.revision = 1;
  const pending = panel.finishIncomplete(
    '/cache/first',
    {repository, commit, workflow: 'main'},
    first,
    1,
    'interrupted',
    'unchecked',
  );
  panel.revision = 2;
  panel.record = {
    detail: second,
    documentation: {state: 'loading'},
    inspection: {state: 'idle'},
    requested: second.id,
    state: 'ready',
  };
  // Selecting A again and finishing its newer inspection must also invalidate
  // the earlier A operation, even though its cache path and release agree.
  panel.revision = 3;
  const current: CatalogueRecord = {
    detail: first,
    documentation: {state: 'loading'},
    inspection: {state: 'ready', folder: '/cache/first'},
    requested: first.id,
    state: 'ready',
  };
  panel.record = current;
  releaseRead({
    dependencies: 'ready',
    metadata: 'ready',
    preview: {repository, commit, workflow: 'main'},
    source: 'ready',
    version: 2,
  });
  await pending;
  assert.equal(panel.record, current);
  assert.deepEqual(
    written,
    [],
    'the newer ready receipt must not be overwritten',
  );
});
