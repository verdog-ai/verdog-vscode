/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {build} from 'esbuild';
import type * as vscode from 'vscode';

type Module = typeof import('./backend');
const publicOrigin = 'https://157.180.79.112';

async function harness() {
  const setting = {
    globalValue: undefined as string | undefined,
    defaultValue: publicOrigin,
    workspaceValue: 'https://untrusted.invalid',
  };
  const accessSetting = {
    globalValue: undefined as string | undefined,
    defaultValue: 'public',
    workspaceValue: 'private',
  };
  const preferenceStore = new Map<string, unknown>();
  const commands = new Map<string, () => Promise<void>>();
  const executed: string[] = [];
  const prompts: Array<{message: string; detail: string}> = [];
  const errors: string[] = [];
  let promptChoice: string | undefined = 'Authorize';
  let cancelAuthentication = false;
  const session = {
    id: 'github-session',
    accessToken: 'github-secret',
    account: {id: 'account', label: 'person'},
    scopes: ['read:user'],
  };
  const authCalls: unknown[][] = [];
  let github: typeof session | undefined = session;
  let configurationChanged: (event: {
    affectsConfiguration: (name: string) => boolean;
  }) => void = () => {};
  let sessionChanged: (event: {provider: {id: string}}) => void = () => {};
  const store = new Map<string, string>();
  class Cancelled extends Error {}
  const mock = {
    CancellationError: Cancelled,
    ConfigurationTarget: {Global: 1},
    commands: {
      registerCommand: (id: string, handler: () => Promise<void>) => {
        commands.set(id, handler);
        return {dispose() {}};
      },
      executeCommand: async (id: string) => {
        executed.push(id);
      },
    },
    window: {
      showWarningMessage: async (
        message: string,
        options: {detail: string},
      ) => {
        prompts.push({message, detail: options.detail});
        return promptChoice;
      },
      showErrorMessage: (message: string) => {
        errors.push(message);
      },
    },
    workspace: {
      getConfiguration: () => ({
        inspect: (name: string) =>
          name === 'githubRepositoryAccess' ? accessSetting : setting,
        get: () => setting.workspaceValue,
        update: async (name: string, value: string, target: number) => {
          assert.equal(name, 'githubRepositoryAccess');
          assert.equal(target, 1);
          accessSetting.globalValue = value;
          configurationChanged({
            affectsConfiguration: candidate => candidate === `verdog.${name}`,
          });
        },
      }),
      onDidChangeConfiguration: (listener: typeof configurationChanged) => {
        configurationChanged = listener;
        return {dispose() {}};
      },
    },
    authentication: {
      getSession: async (...args: unknown[]) => {
        authCalls.push(args);
        if (cancelAuthentication) {
          throw new Cancelled();
        }
        return github;
      },
      onDidChangeSessions: (listener: typeof sessionChanged) => {
        sessionChanged = listener;
        return {dispose() {}};
      },
    },
  };
  const key = `verdog-backend-test-${Math.random()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = mock;
  let backend: Module;
  try {
    const result = await build({
      entryPoints: [path.resolve('src', 'backend.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'test-vscode',
          setup(builder) {
            builder.onResolve({filter: /^vscode$/}, () => ({
              path: 'vscode',
              namespace: 'mock',
            }));
            builder.onLoad({filter: /.*/, namespace: 'mock'}, () => ({
              contents: Object.keys(mock)
                .map(
                  name =>
                    `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];`,
                )
                .join('\n'),
            }));
          },
        },
      ],
    });
    backend = (await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )) as Module;
  } finally {
    delete globals[key];
  }
  backend.initializeBackend({
    subscriptions: [],
    globalState: {
      get: (key: string) => preferenceStore.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          preferenceStore.delete(key);
        } else {
          preferenceStore.set(key, value);
        }
      },
    },
    secrets: {
      get: async (key: string) => store.get(key),
      store: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  } as unknown as vscode.ExtensionContext);
  return {
    backend,
    accessSetting,
    preferenceStore,
    commands,
    executed,
    prompts,
    errors,
    prompt: (choice: string | undefined) => {
      promptChoice = choice;
    },
    cancelAuthentication: () => {
      cancelAuthentication = true;
    },
    setting,
    session,
    authCalls,
    store,
    signOut: () => {
      github = undefined;
      sessionChanged({provider: {id: 'github'}});
    },
    changeAccount: () => {
      session.id = 'second-session';
      session.account.id = 'second-account';
      sessionChanged({provider: {id: 'github'}});
    },
    changeOrigin: (origin: string) => {
      setting.globalValue = origin;
      configurationChanged({
        affectsConfiguration: name => name === 'verdog.backendOrigin',
      });
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function signedIn(url: string | URL | Request): Response {
  return String(url).endsWith('/auth/github')
    ? json({
        session_token: 'verdog-secret',
        user: {id: 'user-id', login: 'person'},
      })
    : json({api_version: 14, user: {id: 'user-id'}});
}

test('backend origin is user-only, anonymous, and limited to HTTPS or HTTP loopback', async () => {
  const h = await harness();
  assert.equal(h.backend.backendOrigin(), publicOrigin);
  assert.deepEqual(h.authCalls, []);
  for (const origin of [
    'http://127.0.0.1:18765',
    'http://[::1]:18765',
    'http://localhost:18765',
    'https://backend.example/',
  ]) {
    h.setting.globalValue = origin;
    assert.equal(h.backend.backendOrigin(), new URL(origin).origin);
  }
  for (const origin of [
    'http://backend.example',
    'http://127.0.0.1.attacker.example',
    'https://user:secret@backend.example',
    'https://backend.example/api/v1',
    'https://backend.example?token=secret',
    'https://backend.example#fragment',
    'file:///tmp/backend',
    'not a URL',
    'https://backend.example:0',
    'https://backend.example?',
    'https://backend.example#',
    ' https://backend.example',
    'http://127.0.0.2:18765',
  ]) {
    h.setting.globalValue = origin;
    assert.throws(() => h.backend.backendOrigin(), /verdog.backendOrigin/);
  }
});

test('catalogue sign-in exchanges the minimal GitHub scope and caches only the origin-bound Verdog session', async t => {
  const h = await harness();
  const requests: Array<{url: string; options: RequestInit}> = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, options: RequestInit) => {
      requests.push({url: String(url), options});
      return signedIn(url);
    },
  );
  assert.deepEqual(await h.backend.backendSession(), {
    origin: publicOrigin,
    token: 'verdog-secret',
  });
  assert.deepEqual(h.authCalls, [
    ['github', ['read:user'], {createIfNone: true}],
  ]);
  assert.equal(requests[0].url, `${publicOrigin}/api/v1/auth/github`);
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    access_token: 'github-secret',
  });
  assert.deepEqual(requests[1].options.headers, {
    Authorization: 'Bearer verdog-secret',
  });
  assert.ok(requests.every(({options}) => options.redirect === 'error'));
  assert.ok(
    [...h.store.values()].every(value => !value.includes('github-secret')),
  );
  await h.backend.backendSession();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, `${publicOrigin}/api/v1/me`);
  h.changeOrigin('http://127.0.0.1:18765');
  await h.backend.backendSession();
  assert.equal(requests[3].url, 'http://127.0.0.1:18765/api/v1/auth/github');
  h.changeAccount();
  await h.backend.backendSession();
  assert.equal(requests[5].url, 'http://127.0.0.1:18765/api/v1/auth/github');
  h.signOut();
  assert.equal(await h.backend.backendSession(false), undefined);
  assert.deepEqual(h.authCalls.at(-1), [
    'github',
    ['read:user'],
    {silent: true},
  ]);
  assert.equal(h.store.size, 0);
});

test('expired backend sessions are refreshed without a broad GitHub scope', async t => {
  const h = await harness();
  let expired = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    expired && ++calls === 1 ? json({}, 401) : signedIn(url),
  );
  await h.backend.backendSession();
  expired = true;
  await h.backend.backendSession();
  assert.equal(calls, 3);
});

test('redirects, backend errors, and invalid API contracts never expose tokens or get stored', async t => {
  const h = await harness();
  let scenario = 'redirect';
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, options: RequestInit) => {
      assert.equal(options.redirect, 'error');
      if (scenario === 'redirect') {
        throw new TypeError('redirect rejected github-secret');
      }
      if (scenario === 'forbidden') {
        return json({secret: 'github-secret'}, 403);
      }
      return String(url).endsWith('/me')
        ? json({api_version: 13, user: {id: 'user-id'}})
        : signedIn(url);
    },
  );
  await assert.rejects(
    h.backend.backendSession(),
    (error: Error) =>
      /Could not contact/.test(error.message) &&
      !error.message.includes('github-secret'),
  );
  scenario = 'forbidden';
  await assert.rejects(
    h.backend.backendSession(),
    /^Error: Verdog sign-in failed \(HTTP 403\)\.$/,
  );
  scenario = 'old-api';
  await assert.rejects(
    h.backend.backendSession(),
    /requires Verdog backend API 14/,
  );
  assert.equal(h.store.size, 0);
});

test('changing the trusted origin during sign-in rejects the in-flight session', async t => {
  const h = await harness();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/auth/github')) {
      h.changeOrigin('https://other.example');
    }
    return signedIn(url);
  });
  await assert.rejects(
    h.backend.backendSession(),
    /backend or GitHub account changed/,
  );
  assert.equal(h.store.size, 0);
});

test('the real HTTP client refuses a 307 token-exchange redirect', async () => {
  const h = await harness();
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url ?? '');
    request.resume();
    response.writeHead(307, {Location: '/stolen-token'});
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  h.setting.globalValue = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      h.backend.backendSession(),
      /Could not contact the Verdog backend/,
    );
    assert.deepEqual(received, ['/api/v1/auth/github']);
    assert.equal(h.store.size, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});

test('malformed saved sessions are replaced and backend identity mismatch is rejected', async t => {
  const h = await harness();
  let wrongIdentity = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    wrongIdentity && String(url).endsWith('/me')
      ? json({api_version: 14, user: {id: 'different-user'}})
      : signedIn(url),
  );
  for (const saved of [
    'null',
    '[]',
    '{',
    '{"origin":"https://untrusted.invalid","token":"wrong-service"}',
  ]) {
    h.store.set('verdog.backendSession', saved);
    assert.deepEqual(await h.backend.backendSession(), {
      origin: publicOrigin,
      token: 'verdog-secret',
    });
  }
  h.store.clear();
  wrongIdentity = true;
  await assert.rejects(h.backend.backendSession(), /unexpected account/);
  assert.equal(h.store.size, 0);
});

test('invalid sign-in payloads are rejected before credentials reach storage', async t => {
  const h = await harness();
  let payload: unknown;
  t.mock.method(globalThis, 'fetch', async () => json(payload));
  for (payload of [
    null,
    [],
    'token',
    {},
    {session_token: '\n', user: {id: 'user-id'}},
    {session_token: 'token', user: []},
    {session_token: 'token', user: {id: ''}},
  ]) {
    await assert.rejects(
      h.backend.backendSession(),
      /invalid sign-in response/,
    );
    assert.equal(h.store.size, 0);
  }
});

test('a provider-rejected authorization forces renewal only on the next interactive request', async t => {
  const h = await harness();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    signedIn(url),
  );
  await h.backend.backendSession();
  await h.backend.rejectGitHubSession();
  assert.equal(await h.backend.backendSession(false), undefined);
  await h.backend.backendSession();
  assert.deepEqual(h.authCalls.at(-1), [
    'github',
    ['read:user'],
    {forceNewSession: true},
  ]);
});

test('public mode ignores workspace scope settings and never exchanges a broader reused GitHub session', async t => {
  const h = await harness();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    ++requests;
    return signedIn(url);
  });
  assert.equal(h.backend.githubRepositoryAccess(), 'public');
  h.session.scopes = ['read:user', 'repo'];
  await assert.rejects(h.backend.backendSession(), /broader authorization/);
  assert.equal(requests, 0);
  assert.deepEqual(h.authCalls[0], [
    'github',
    ['read:user'],
    {createIfNone: true},
  ]);
  assert.equal(h.store.size, 0);
});

test('private authorization confirms its destination and binds sessions to the selected mode', async t => {
  const h = await harness();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    signedIn(url),
  );
  await h.backend.backendSession();
  h.session.scopes = ['read:user', 'repo'];
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  assert.equal(h.errors.length, 0);
  assert.equal(h.backend.githubRepositoryAccess(), 'private');
  assert.match(h.prompts[0].message, /https:\/\/157\.180\.79\.112/);
  assert.match(h.prompts[0].detail, /read and write access/);
  assert.match(
    h.prompts[0].detail,
    /token will be sent to https:\/\/157\.180\.79\.112/,
  );
  assert.deepEqual(h.authCalls.at(-1), [
    'github',
    ['read:user', 'repo'],
    {createIfNone: true},
  ]);
  assert.equal(
    h.store.size,
    0,
    'the prior public backend session is invalidated',
  );
  await h.backend.backendSession();
  assert.equal(
    JSON.parse(h.store.get('verdog.backendSession')!).repositoryAccess,
    'private',
  );
  assert.deepEqual(h.executed, ['verdog.refreshCatalogue']);

  await h.commands.get('verdog.usePublicCatalogueAccess')!();
  assert.equal(h.backend.githubRepositoryAccess(), 'public');
  assert.equal(h.preferenceStore.size, 0);
  assert.equal(h.store.size, 0);
  h.session.scopes = ['read:user'];
  await h.backend.backendSession();
  assert.deepEqual(h.authCalls.at(-1), [
    'github',
    ['read:user'],
    {forceNewSession: true},
  ]);
  assert.equal(
    JSON.parse(h.store.get('verdog.backendSession')!).repositoryAccess,
    'public',
  );
});

test('cancelled private authorization leaves public mode and its credentials intact', async t => {
  const h = await harness();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    signedIn(url),
  );
  await h.backend.backendSession();
  const saved = h.store.get('verdog.backendSession');
  h.prompt(undefined);
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  assert.equal(h.authCalls.length, 1);
  assert.equal(h.backend.githubRepositoryAccess(), 'public');
  assert.equal(h.store.get('verdog.backendSession'), saved);
  h.prompt('Authorize');
  h.cancelAuthentication();
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  assert.equal(h.backend.githubRepositoryAccess(), 'public');
  assert.equal(h.preferenceStore.size, 0);
  assert.equal(h.errors.length, 0);
});

test('a changed private destination or account requires new explicit consent before token exchange', async t => {
  const h = await harness();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    ++requests;
    return signedIn(url);
  });
  h.session.scopes = ['read:user', 'repo'];
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  await h.backend.backendSession();
  const before = requests;
  h.changeOrigin('https://another.example');
  await assert.rejects(
    h.backend.backendSession(),
    /approve sending.*https:\/\/another\.example/,
  );
  assert.equal(requests, before);
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  await h.backend.backendSession();
  const approved = requests;
  h.changeAccount();
  await assert.rejects(h.backend.backendSession(), /for this GitHub account/);
  assert.equal(requests, approved);
  assert.equal(h.store.size, 0);
});

test('private mode cannot be enabled by a setting alone or expanded to unrelated GitHub scopes', async t => {
  const h = await harness();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    ++requests;
    return signedIn(url);
  });
  h.accessSetting.globalValue = 'private';
  await assert.rejects(
    h.backend.backendSession(),
    /Authorize Private Repository Access/,
  );
  assert.equal(h.authCalls.length, 0);
  h.session.scopes = ['read:user', 'repo', 'admin:org'];
  await h.commands.get('verdog.authorizePrivateRepositories')!();
  assert.equal(h.preferenceStore.size, 0);
  assert.equal(requests, 0);
  assert.match(h.errors[0], /requested read:user and repo/);
});
