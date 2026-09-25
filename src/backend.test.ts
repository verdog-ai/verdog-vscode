// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import * as path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { build } from "esbuild";
import type * as vscode from "vscode";

type Module = typeof import("./backend");
const publicOrigin = "https://157.180.79.112";

async function harness() {
  const setting = { globalValue: undefined as string | undefined, defaultValue: publicOrigin, workspaceValue: "https://untrusted.invalid" };
  const session = { id: "github-session", accessToken: "github-secret", account: { id: "account", label: "person" }, scopes: ["read:user"] };
  const authCalls: unknown[][] = [];
  let github: typeof session | undefined = session;
  let configurationChanged: (event: { affectsConfiguration: (name: string) => boolean }) => void = () => {};
  let sessionChanged: (event: { provider: { id: string } }) => void = () => {};
  const store = new Map<string, string>();
  const mock = {
    CancellationError: class extends Error {},
    workspace: {
      getConfiguration: () => ({ inspect: () => setting, get: () => setting.workspaceValue }),
      onDidChangeConfiguration: (listener: typeof configurationChanged) => { configurationChanged = listener; return { dispose() {} }; },
    },
    authentication: {
      getSession: async (...args: unknown[]) => { authCalls.push(args); return github; },
      onDidChangeSessions: (listener: typeof sessionChanged) => { sessionChanged = listener; return { dispose() {} }; },
    },
  };
  const key = `verdog-backend-test-${Math.random()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = mock;
  let backend: Module;
  try {
    const result = await build({
      entryPoints: [path.resolve("src", "backend.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      plugins: [{
        name: "test-vscode",
        setup(builder) {
          builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "mock" }));
          builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
            contents: Object.keys(mock).map((name) => `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];`).join("\n"),
          }));
        },
      }],
    });
    backend = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.text).toString("base64")}`) as Module;
  } finally {
    delete globals[key];
  }
  backend.initializeBackend({
    subscriptions: [],
    secrets: {
      get: async (key: string) => store.get(key),
      store: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
  } as unknown as vscode.ExtensionContext);
  return {
    backend, setting, session, authCalls, store,
    signOut: () => { github = undefined; sessionChanged({ provider: { id: "github" } }); },
    changeAccount: () => { session.id = "second-session"; session.account.id = "second-account"; sessionChanged({ provider: { id: "github" } }); },
    changeOrigin: (origin: string) => { setting.globalValue = origin; configurationChanged({ affectsConfiguration: (name) => name === "verdog.backendOrigin" }); },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function signedIn(url: string | URL | Request): Response {
  return String(url).endsWith("/auth/github")
    ? json({ session_token: "verdog-secret", user: { id: "user-id", login: "person" } })
    : json({ api_version: 14, user: { id: "user-id" } });
}

test("backend origin is user-only, anonymous, and limited to HTTPS or HTTP loopback", async () => {
  const h = await harness();
  assert.equal(h.backend.backendOrigin(), publicOrigin);
  assert.deepEqual(h.authCalls, []);
  for (const origin of ["http://127.0.0.1:18765", "http://[::1]:18765", "http://localhost:18765", "https://backend.example/"]) {
    h.setting.globalValue = origin;
    assert.equal(h.backend.backendOrigin(), new URL(origin).origin);
  }
  for (const origin of ["http://backend.example", "http://127.0.0.1.attacker.example", "https://user:secret@backend.example", "https://backend.example/api/v1", "https://backend.example?token=secret", "https://backend.example#fragment", "file:///tmp/backend", "not a URL", "https://backend.example:0", "https://backend.example?", "https://backend.example#", " https://backend.example", "http://127.0.0.2:18765"]) {
    h.setting.globalValue = origin;
    assert.throws(() => h.backend.backendOrigin(), /verdog.backendOrigin/);
  }
});

test("catalogue sign-in exchanges the minimal GitHub scope and caches only the origin-bound Verdog session", async (t) => {
  const h = await harness();
  const requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    requests.push({ url: String(url), options });
    return signedIn(url);
  });
  assert.deepEqual(await h.backend.backendSession(), { origin: publicOrigin, token: "verdog-secret" });
  assert.deepEqual(h.authCalls, [["github", ["read:user"], { createIfNone: true }]]);
  assert.equal(requests[0]!.url, `${publicOrigin}/api/v1/auth/github`);
  assert.deepEqual(JSON.parse(String(requests[0]!.options.body)), { access_token: "github-secret" });
  assert.deepEqual(requests[1]!.options.headers, { Authorization: "Bearer verdog-secret" });
  assert.ok(requests.every(({ options }) => options.redirect === "error"));
  assert.ok([...h.store.values()].every((value) => !value.includes("github-secret")));
  await h.backend.backendSession();
  assert.equal(requests.length, 3);
  assert.equal(requests[2]!.url, `${publicOrigin}/api/v1/me`);
  h.changeOrigin("http://127.0.0.1:18765");
  await h.backend.backendSession();
  assert.equal(requests[3]!.url, "http://127.0.0.1:18765/api/v1/auth/github");
  h.changeAccount();
  await h.backend.backendSession();
  assert.equal(requests[5]!.url, "http://127.0.0.1:18765/api/v1/auth/github");
  h.signOut();
  assert.equal(await h.backend.backendSession(false), undefined);
  assert.deepEqual(h.authCalls.at(-1), ["github", ["read:user"], { silent: true }]);
  assert.equal(h.store.size, 0);
});

test("expired backend sessions are refreshed without a broad GitHub scope", async (t) => {
  const h = await harness();
  let expired = false;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => expired && ++calls === 1 ? json({}, 401) : signedIn(url));
  await h.backend.backendSession();
  expired = true;
  await h.backend.backendSession();
  assert.equal(calls, 3);
});

test("redirects, backend errors, and invalid API contracts never expose tokens or get stored", async (t) => {
  const h = await harness();
  let scenario = "redirect";
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    if (scenario === "redirect") throw new TypeError("redirect rejected github-secret");
    if (scenario === "forbidden") return json({ secret: "github-secret" }, 403);
    return String(url).endsWith("/me") ? json({ api_version: 13, user: { id: "user-id" } }) : signedIn(url);
  });
  await assert.rejects(h.backend.backendSession(), (error: Error) => /Could not contact/.test(error.message) && !error.message.includes("github-secret"));
  scenario = "forbidden";
  await assert.rejects(h.backend.backendSession(), /^Error: Verdog sign-in failed \(HTTP 403\)\.$/);
  scenario = "old-api";
  await assert.rejects(h.backend.backendSession(), /requires Verdog backend API 14/);
  assert.equal(h.store.size, 0);
});

test("changing the trusted origin during sign-in rejects the in-flight session", async (t) => {
  const h = await harness();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/auth/github")) h.changeOrigin("https://other.example");
    return signedIn(url);
  });
  await assert.rejects(h.backend.backendSession(), /backend or GitHub account changed/);
  assert.equal(h.store.size, 0);
});


test("the real HTTP client refuses a 307 token-exchange redirect", async () => {
  const h = await harness();
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url ?? "");
    request.resume();
    response.writeHead(307, { Location: "/stolen-token" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  h.setting.globalValue = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(h.backend.backendSession(), /Could not contact the Verdog backend/);
    assert.deepEqual(received, ["/api/v1/auth/github"]);
    assert.equal(h.store.size, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("malformed saved sessions are replaced and backend identity mismatch is rejected", async (t) => {
  const h = await harness();
  let wrongIdentity = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => wrongIdentity && String(url).endsWith("/me")
    ? json({ api_version: 14, user: { id: "different-user" } })
    : signedIn(url));
  for (const saved of ["null", "[]", "{", '{"origin":"https://untrusted.invalid","token":"wrong-service"}']) {
    h.store.set("verdog.backendSession", saved);
    assert.deepEqual(await h.backend.backendSession(), { origin: publicOrigin, token: "verdog-secret" });
  }
  h.store.clear();
  wrongIdentity = true;
  await assert.rejects(h.backend.backendSession(), /unexpected account/);
  assert.equal(h.store.size, 0);
});
