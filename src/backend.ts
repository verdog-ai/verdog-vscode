// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import * as vscode from "vscode";

const DEFAULT_ORIGIN = "https://157.180.79.112";
const SESSION_KEY = "verdog.backendSession";
const API_VERSION = 14;
let secrets: vscode.SecretStorage;
let revision = 0;
let invalidation = Promise.resolve();

export type BackendSession = { origin: string; token: string };

type StoredSession = BackendSession & {
  githubSession: string;
  githubAccount: string;
  userId: string;
};

/** Workspace/project settings must never choose where a GitHub token is sent. */
export function backendOrigin(): string {
  const setting = vscode.workspace.getConfiguration("verdog").inspect<string>("backendOrigin");
  const value = setting?.globalValue ?? setting?.defaultValue ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    if (typeof value !== "string" || value !== value.trim() || !/^https?:\/\//.test(value) || /[?#\\]/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("Set verdog.backendOrigin to an HTTPS origin, for example https://157.180.79.112.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.port === "0" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("verdog.backendOrigin must be an HTTPS origin without credentials, a path, query, or fragment. HTTP is allowed only on loopback for local testing.");
  }
  return url.origin;
}

export function initializeBackend(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  const invalidate = () => {
    ++revision;
    invalidation = Promise.resolve(secrets.delete(SESSION_KEY));
    // Retain the rejection for the next request without an unhandled event callback rejection.
    void invalidation.catch(() => {});
  };
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === "github") invalidate();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("verdog.backendOrigin")) invalidate();
    }),
  );
}

/** Compiler operations use backendOrigin() directly; only catalogue actions call this. */
export async function backendSession(interactive = true): Promise<BackendSession | undefined> {
  const origin = backendOrigin();
  let github: vscode.AuthenticationSession | undefined;
  try {
    github = await vscode.authentication.getSession("github", ["read:user"],
      interactive ? { createIfNone: true } : { silent: true });
  } catch (error) {
    if (error instanceof vscode.CancellationError) return undefined;
    throw new Error("GitHub sign-in was not completed.");
  }
  if (!github) return undefined;
  await invalidation;
  const currentRevision = revision;
  const checkCurrent = () => {
    if (backendOrigin() !== origin || revision !== currentRevision) {
      throw new Error("The backend or GitHub account changed. Retry the catalogue action.");
    }
  };
  checkCurrent();

  let stored: StoredSession | undefined;
  const saved = await secrets.get(SESSION_KEY);
  try {
    if (saved) stored = JSON.parse(saved) as StoredSession;
  } catch { /* A malformed saved entry is replaced by a fresh exchange. */ }
  if (stored?.origin !== origin || stored.githubSession !== github.id || stored.githubAccount !== github.account.id
      || typeof stored.token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(stored.token) || typeof stored.userId !== "string") {
    stored = undefined;
  }
  if (stored) {
    const response = await request(origin, "/api/v1/me", { headers: { Authorization: `Bearer ${stored.token}` } });
    if (response.status === 401) {
      await secrets.delete(SESSION_KEY);
      stored = undefined;
    } else {
      await checkIdentity(response, stored.userId);
    }
  }
  if (!stored) {
    checkCurrent();
    const response = await request(origin, "/api/v1/auth/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: github.accessToken }),
    });
    const body = await responseBody(response);
    if (typeof body.session_token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(body.session_token)
        || typeof body.user?.id !== "string" || !body.user.id) {
      throw new Error("The backend returned an invalid sign-in response.");
    }
    stored = { origin, token: body.session_token, githubSession: github.id, githubAccount: github.account.id, userId: body.user.id };
    const identity = await request(origin, "/api/v1/me", { headers: { Authorization: `Bearer ${stored.token}` } });
    await checkIdentity(identity, stored.userId);
    checkCurrent();
    await secrets.store(SESSION_KEY, JSON.stringify(stored));
  }
  checkCurrent();
  return { origin, token: stored.token };
}

async function request(origin: string, route: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(`${origin}${route}`, { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("Could not contact the Verdog backend. Check verdog.backendOrigin and the connection.");
  }
}

async function responseBody(response: Response): Promise<{ session_token?: unknown; api_version?: unknown; user?: { id?: unknown } }> {
  if (!response.ok) throw new Error(`Verdog sign-in failed (HTTP ${response.status}).`);
  try {
    const body = await response.json();
    if (!body || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new Error("The backend returned an invalid sign-in response.");
  }
}

async function checkIdentity(response: Response, userId: string): Promise<void> {
  const identity = await responseBody(response);
  if (identity.api_version !== API_VERSION) throw new Error(`This extension requires Verdog backend API ${API_VERSION}.`);
  if (identity.user?.id !== userId) throw new Error("The backend returned an unexpected account. Sign in again.");
}
