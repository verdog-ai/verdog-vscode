/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as vscode from 'vscode';

import {object} from '../model/reading';

const DEFAULT_ORIGIN = 'https://157.180.79.112';
const SESSION_KEY = 'verdog.backendSession';
const PRIVATE_AUTHORIZATION_KEY = 'verdog.privateAuthorization';
const API_VERSION = 14;
let secrets: vscode.SecretStorage;
let preferences: vscode.Memento;
let revision = 0;
let invalidation = Promise.resolve();
let renewGithubSession = false;
type RepositoryAccess = 'public' | 'private';

interface PrivateAuthorization {
  origin: string;
  githubAccount: string;
}

/** Workspace settings cannot opt into broader GitHub authorization. */
export function githubRepositoryAccess(): RepositoryAccess {
  const setting = vscode.workspace
    .getConfiguration('verdog')
    .inspect<string>('githubRepositoryAccess');
  return setting?.globalValue === 'private' ? 'private' : 'public';
}

function githubScopes(mode: RepositoryAccess): string[] {
  return mode === 'private' ? ['read:user', 'repo'] : ['read:user'];
}

function invalidateSession(): void {
  ++revision;
  invalidation = Promise.resolve(secrets.delete(SESSION_KEY));
  void invalidation.catch(() => {});
}

async function authorizePrivateRepositories(): Promise<void> {
  const origin = backendOrigin();
  const accepted = await vscode.window.showWarningMessage(
    `Authorize private repository access through ${origin}?`,
    {
      modal: true,
      detail: `VS Code's built-in GitHub sign-in will request the repo scope, which grants read and write access to public and private repositories. The resulting GitHub token will be sent to ${origin} for catalogue permission checks. No GitHub App registration or installation is required.`,
    },
    'Authorize',
  );
  if (accepted !== 'Authorize') {
    return;
  }
  if (backendOrigin() !== origin) {
    throw new Error(
      'The backend changed. Run Authorize Private Repository Access again for the new destination.',
    );
  }
  let github: vscode.AuthenticationSession | undefined;
  try {
    github = await vscode.authentication.getSession(
      'github',
      githubScopes('private'),
      renewGithubSession ? {forceNewSession: true} : {createIfNone: true},
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return;
    }
    // eslint-disable-next-line preserve-caught-error -- Authentication-provider errors can contain credentials.
    throw new Error('GitHub authorization was not completed.');
  }
  if (!github) {
    return;
  }
  if (backendOrigin() !== origin) {
    throw new Error(
      'The backend changed. Run Authorize Private Repository Access again for the new destination.',
    );
  }
  if (
    !github.scopes.includes('repo') ||
    github.scopes.some(scope => !githubScopes('private').includes(scope))
  ) {
    throw new Error(
      'GitHub did not grant the requested read:user and repo authorization. No token was sent to the backend.',
    );
  }
  await preferences.update(PRIVATE_AUTHORIZATION_KEY, {
    origin,
    githubAccount: github.account.id,
  } satisfies PrivateAuthorization);
  await vscode.workspace
    .getConfiguration('verdog')
    .update(
      'githubRepositoryAccess',
      'private',
      vscode.ConfigurationTarget.Global,
    );
  invalidateSession();
  await invalidation;
  renewGithubSession = false;
  await vscode.commands.executeCommand('verdog.refreshCatalogue');
}

async function usePublicCatalogueAccess(): Promise<void> {
  await preferences.update(PRIVATE_AUTHORIZATION_KEY, undefined);
  await vscode.workspace
    .getConfiguration('verdog')
    .update(
      'githubRepositoryAccess',
      'public',
      vscode.ConfigurationTarget.Global,
    );
  invalidateSession();
  await invalidation;
  renewGithubSession = true;
  await vscode.commands.executeCommand('verdog.refreshCatalogue');
}

/** A rejected GitHub token must be renewed through VS Code, not exchanged repeatedly. */
export async function rejectGitHubSession(): Promise<void> {
  renewGithubSession = true;
  invalidateSession();
  await invalidation;
}

/** Credentials for one trusted backend origin; never sent to a webview. */
export interface BackendSession {
  origin: string;
  token: string;
}

interface StoredSession extends BackendSession {
  githubSession: string;
  githubAccount: string;
  userId: string;
  repositoryAccess: RepositoryAccess;
}

/** Workspace/project settings must never choose where a GitHub token is sent. */
export function backendOrigin(): string {
  const setting = vscode.workspace
    .getConfiguration('verdog')
    .inspect<string>('backendOrigin');
  const value = setting?.globalValue ?? setting?.defaultValue ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      !/^https?:\/\//.test(value) ||
      /[?#\\]/.test(value)
    ) {
      throw new Error();
    }
    url = new URL(value);
  } catch {
    throw new Error(
      'Set verdog.backendOrigin to an HTTPS origin, for example https://157.180.79.112.',
    );
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '127.0.0.1';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.port === '0' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'verdog.backendOrigin must be an HTTPS origin without credentials, a path, query, or fragment. HTTP is allowed only on loopback for local testing.',
    );
  }
  return url.origin;
}

/** Clears cached credentials when the trusted backend or GitHub account changes. */
export function initializeBackend(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  preferences = context.globalState;
  const command = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error
          ? error.message
          : 'GitHub authorization could not be changed.',
      );
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'verdog.authorizePrivateRepositories',
      command(authorizePrivateRepositories),
    ),
    vscode.commands.registerCommand(
      'verdog.usePublicCatalogueAccess',
      command(usePublicCatalogueAccess),
    ),
    vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === 'github') {
        invalidateSession();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('verdog.backendOrigin') ||
        event.affectsConfiguration('verdog.githubRepositoryAccess')
      ) {
        invalidateSession();
      }
    }),
  );
}

/** Compiler operations use backendOrigin() directly; only catalogue actions call this. */
export async function backendSession(
  interactive = true,
): Promise<BackendSession | undefined> {
  const origin = backendOrigin();
  const repositoryAccess = githubRepositoryAccess();
  const consent = preferences.get<PrivateAuthorization>(
    PRIVATE_AUTHORIZATION_KEY,
  );
  if (repositoryAccess === 'private' && consent?.origin !== origin) {
    throw Object.assign(
      new Error(
        `Run Verdog: Authorize Private Repository Access to approve sending a GitHub repo token to ${origin}.`,
      ),
      {code: 'auth.private_authorization_required'},
    );
  }
  if (renewGithubSession && !interactive) {
    return undefined;
  }
  let github: vscode.AuthenticationSession | undefined;
  try {
    github = await vscode.authentication.getSession(
      'github',
      githubScopes(repositoryAccess),
      renewGithubSession && interactive
        ? {forceNewSession: true}
        : interactive
          ? {createIfNone: true}
          : {silent: true},
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return undefined;
    }
    // eslint-disable-next-line preserve-caught-error -- Authentication-provider errors can contain credentials.
    throw new Error('GitHub sign-in was not completed.');
  }
  if (!github) {
    return undefined;
  }
  if (
    github.scopes.some(scope => !githubScopes(repositoryAccess).includes(scope))
  ) {
    renewGithubSession = true;
    throw Object.assign(
      new Error(
        'GitHub returned broader authorization than this catalogue access mode permits. Sign in again with the requested scopes, or explicitly use Verdog: Authorize Private Repository Access.',
      ),
      {code: 'auth.scope'},
    );
  }
  if (
    repositoryAccess === 'private' &&
    (consent?.githubAccount !== github.account.id ||
      !github.scopes.includes('repo'))
  ) {
    throw Object.assign(
      new Error(
        'Run Verdog: Authorize Private Repository Access for this GitHub account.',
      ),
      {code: 'auth.private_authorization_required'},
    );
  }
  await invalidation;
  const currentRevision = revision;
  const checkCurrent = () => {
    if (
      backendOrigin() !== origin ||
      githubRepositoryAccess() !== repositoryAccess ||
      revision !== currentRevision
    ) {
      throw new Error(
        'The backend or GitHub account changed. Retry the catalogue action.',
      );
    }
  };
  checkCurrent();

  let stored = await savedSession(origin, github, repositoryAccess);
  if (stored) {
    const response = await request(origin, '/api/v1/me', {
      headers: {Authorization: `Bearer ${stored.token}`},
    });
    if (response.status === 401) {
      await secrets.delete(SESSION_KEY);
      stored = undefined;
    } else {
      await checkIdentity(response, stored.userId);
    }
  }
  if (!stored) {
    checkCurrent();
    stored = await exchangeSession(origin, github, repositoryAccess);
    checkCurrent();
    await secrets.store(SESSION_KEY, JSON.stringify(stored));
  }
  checkCurrent();
  renewGithubSession = false;
  return {origin, token: stored.token};
}

/** Reads only complete credentials for this trusted origin and GitHub account. */
async function savedSession(
  origin: string,
  github: vscode.AuthenticationSession,
  repositoryAccess: RepositoryAccess,
): Promise<StoredSession | undefined> {
  const saved = await secrets.get(SESSION_KEY);
  if (!saved) {
    return undefined;
  }
  let stored: Record<string, unknown>;
  try {
    stored = object(JSON.parse(saved));
  } catch {
    // A malformed saved entry is replaced by a fresh exchange.
    return undefined;
  }
  if (
    stored.origin !== origin ||
    stored.githubSession !== github.id ||
    stored.githubAccount !== github.account.id ||
    stored.repositoryAccess !== repositoryAccess ||
    typeof stored.token !== 'string' ||
    !/^[\x21-\x7e]{1,512}$/.test(stored.token) ||
    typeof stored.userId !== 'string' ||
    !stored.userId
  ) {
    return undefined;
  }
  return {
    origin,
    token: stored.token,
    githubSession: github.id,
    githubAccount: github.account.id,
    userId: stored.userId,
    repositoryAccess,
  };
}

/** Exchanges the GitHub token and verifies the resulting backend identity. */
async function exchangeSession(
  origin: string,
  github: vscode.AuthenticationSession,
  repositoryAccess: RepositoryAccess,
): Promise<StoredSession> {
  const response = await request(origin, '/api/v1/auth/github', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({access_token: github.accessToken}),
  });
  const body = await responseBody(response);
  const user = object(body.user);
  if (
    typeof body.session_token !== 'string' ||
    !/^[\x21-\x7e]{1,512}$/.test(body.session_token) ||
    typeof user.id !== 'string' ||
    !user.id
  ) {
    throw new Error('The backend returned an invalid sign-in response.');
  }
  const stored = {
    origin,
    token: body.session_token,
    githubSession: github.id,
    githubAccount: github.account.id,
    userId: user.id,
    repositoryAccess,
  };
  const identity = await request(origin, '/api/v1/me', {
    headers: {Authorization: `Bearer ${stored.token}`},
  });
  await checkIdentity(identity, stored.userId);
  return stored;
}

async function request(
  origin: string,
  route: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${origin}${route}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      'Could not contact the Verdog backend. Check verdog.backendOrigin and the connection.',
    );
  }
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    let code: unknown;
    try {
      code = object(object(await response.json()).error).code;
    } catch {
      // Report the status without exposing untrusted response data.
    }
    if (code === 'github.token') {
      await rejectGitHubSession();
      throw Object.assign(
        new Error(
          'GitHub rejected this authorization. Sign in with GitHub again to continue.',
        ),
        {code: 'github.token'},
      );
    }
    throw new Error(`Verdog sign-in failed (HTTP ${response.status}).`);
  }
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error();
    }
    return object(body);
  } catch {
    throw new Error('The backend returned an invalid sign-in response.');
  }
}

async function checkIdentity(
  response: Response,
  userId: string,
): Promise<void> {
  const identity = await responseBody(response);
  if (identity.api_version !== API_VERSION) {
    throw new Error(
      `This extension requires Verdog backend API ${API_VERSION}.`,
    );
  }
  if (object(identity.user).id !== userId) {
    throw new Error(
      'The backend returned an unexpected account. Sign in again.',
    );
  }
}
