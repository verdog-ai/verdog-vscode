// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import type * as vscode from "vscode";

import type { CanvasAction, CanvasToHost, HostToCanvas, HostToNavigationBrowser, NavigationBrowserToHost, NavigationEntry, NavigationTarget } from "../model/protocol";
import { projectIn, subroutineAddress, subroutineIn, type ProjectSnapshot } from "../model/snapshot";
import type { Project } from "../model/editing";
import type { OpenHost } from "./projectHost";
import { testProject } from "./fixtures";
import { navigationPage } from "../webview/navigation";
import { agentProfileId, agentSessionId, edgeId, featureId, graphId, nodeId } from "../model/identifiers";
import { terminationRevision, type TerminationReport } from "../model/termination";

/** Bundle the real host code with just its editor/IO boundaries replaced in memory. */
async function load<T>(entry: string, mocks: Record<string, Record<string, unknown>>): Promise<T> {
  const key = `verdog-test-${entry}-${Math.random()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = mocks;
  try {
    const result = await build({
      entryPoints: [path.resolve("src", entry)], bundle: true, write: false,
      format: "esm", platform: "node", logLevel: "silent", mainFields: ["module", "main"],
      plugins: [{ name: "test-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: specifier }) =>
          specifier in mocks ? { path: specifier, namespace: "mock" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path: specifier }) => ({
          contents: Object.keys(mocks[specifier]!).map((name) =>
            `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`
          ).join("\n"),
        }));
      } }],
    });
    const code = `${result.outputFiles![0]!.text}\n//# sourceURL=verdog-test-${entry}`;
    return await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as T;
  } finally {
    delete globals[key];
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(hash: string): ProjectSnapshot {
  return {
    checked: false, diagnostic_count: 0, editable: true,
    entity_documents: { edges: {}, features: {}, nodes: {}, profiles: {}, sessions: {}, profile_parameters: {}, session_parameters: {} },
    graph_hash: hash, initial_scope: "main", pinned: {}, project: testProject(),
  } as unknown as ProjectSnapshot;
}

function host(current?: ProjectSnapshot): OpenHost {
  return {
    canvasNavigationVersion: 0, canvasReady: false, navigationRevision: 0, refreshRevision: 0,
    root: "/test/project", snapshot: current,
    output: { appendLine() {}, show() {} }, problems: { clear() {} }, protectedDocuments: new Set(),
  } as unknown as OpenHost;
}

test("run history refreshes after committed checkpoint events without a run.json write", { timeout: 10000 }, async () => {
  const watchers = new Map<string, Map<string, () => void>>();
  const disposable = { dispose() {} };
  let refreshed = deferred<void>();
  let reads = 0;
  const { registerRunHistory } = await load<typeof import("./runHistoryView")>("runHistoryView.ts", {
    vscode: {
      commands: { registerCommand: () => disposable },
      EventEmitter: class {
        event() { return disposable; }
        fire() { refreshed.resolve(); }
        dispose() {}
      },
      RelativePattern: class {
        constructor(readonly base: string, readonly pattern: string) {}
      },
      window: { createTreeView: () => ({ ...disposable, message: "" }) },
      workspace: {
        isTrusted: true,
        createFileSystemWatcher: ({ pattern }: { pattern: string }) => {
          const events = new Map<string, () => void>();
          watchers.set(pattern, events);
          return {
            ...disposable,
            onDidChange: (callback: () => void) => { events.set("change", callback); return disposable; },
            onDidCreate: (callback: () => void) => { events.set("create", callback); return disposable; },
            onDidDelete: (callback: () => void) => { events.set("delete", callback); return disposable; },
          };
        },
      },
    },
    "./verdogCommand": {
      runVerdogCommand: async (_root: string, arguments_: string[]) => {
        assert.deepEqual(arguments_, ["runs", "--json"]);
        ++reads;
        return {
          code: 0, combined: "", stderr: "",
          stdout: JSON.stringify({ schema_version: 1, operation: "runs", project: "/test/project", runs: [] }),
        };
      },
    },
  });
  const subscriptions = registerRunHistory(host());
  try {
    assert.deepEqual([...watchers.keys()].sort(), [
      ".verdog/run-registry.json",
      ".verdog/runs/**/.verdog/checkpoints/*",
      ".verdog/runs/**/.verdog/checkpoints/*/manifest.json",
      ".verdog/runs/**/.verdog/run.json",
    ], "watch committed checkpoints and manifests, never the staging directory");
    for (const [pattern, event] of [
      [".verdog/runs/**/.verdog/checkpoints/*", "create"],
      [".verdog/runs/**/.verdog/checkpoints/*/manifest.json", "change"],
      [".verdog/runs/**/.verdog/checkpoints/*", "delete"],
    ]) {
      refreshed = deferred<void>();
      watchers.get(pattern!)!.get(event!)!();
      await refreshed.promise;
    }
    assert.equal(reads, 3);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
  }
});

async function graphActions() {
  const state = host(snapshot("graph"));
  const picks: unknown[] = [];
  const inputs: string[] = [];
  const prompts: { choices: unknown[]; title: string }[] = [];
  const reveals: NavigationTarget[] = [];
  const warnings: string[] = [];
  let saved = true;
  let navigateDuringSave = false;
  let warningAnswer: string | undefined;
  let edits = 0;
  const { handleCanvasAction } = await load<typeof import("./projectActions")>("projectActions.ts", {
    vscode: { window: {
      showQuickPick: (choices: unknown[], options: { title: string }) => {
        prompts.push({ choices, title: options.title });
        return picks.shift();
      },
      showInputBox: () => inputs.shift(),
      showWarningMessage: (message: string) => { warnings.push(message); return warningAnswer; },
      showInformationMessage() {},
    } },
    "./projectHost": {
      chooseSubroutine: () => "main", cliCommand: () => ["verdog"],
      editSubroutine: async (_: OpenHost, subroutine: string, _describe: string,
        change: Parameters<typeof import("./projectHost").editSubroutine>[3]) => {
        const at = projectIn(state.snapshot!, subroutine);
        const result = await change(at.project as unknown as Project, at.id);
        if (!saved || result === undefined) return false;
        ++edits;
        const { ownerPath } = subroutineAddress(state.snapshot!.pinned, subroutine);
        const project = result.project as unknown as ProjectSnapshot["project"];
        state.snapshot = ownerPath === undefined
          ? { ...state.snapshot!, project }
          : { ...state.snapshot!, pinned: { ...state.snapshot!.pinned, [ownerPath]: project } };
        if (navigateDuringSave) ++state.navigationRevision;
        return true;
      },
      entities: (_: OpenHost, subroutine: string, kind: string) => {
        const graph = subroutineIn(state.snapshot!, subroutine) as unknown as Record<string, unknown>;
        return graph?.[kind] ?? [];
      },
      followNavigation() {}, followNavigationTarget: (_: OpenHost, target: NavigationTarget) => reveals.push(target),
      projectOf: (_: OpenHost, subroutine: string) => projectIn(state.snapshot!, subroutine).project,
      isEditable: () => state.snapshot!.editable,
      locate: (_: OpenHost, subroutine: string) => ({ root: state.root, subroutine: projectIn(state.snapshot!, subroutine).id }),
      readAccess() {}, refresh() {}, runVerb() {}, subroutineIds: () => ["main"],
    },
  });
  return {
    state, picks, inputs, prompts, reveals, warnings,
    run: (action: CanvasAction, subroutine = "main") => handleCanvasAction(state, { ...action, subroutine }),
    failSave: () => { saved = false; },
    navigateDuringSave: () => { navigateDuringSave = true; },
    confirm: (answer: string) => { warningAnswer = answer; },
    editCount: () => edits,
  };
}

test("selected-node connection asks only for a valid target and reveals the resulting edge", async () => {
  const run = await graphActions();
  run.picks.push("exit");
  await run.run({ kind: "connect", source: nodeId("profile") });
  assert.deepEqual(run.prompts.map(({ title }) => title), ["From profile to which node?"]);
  assert.ok(!run.prompts[0]!.choices.includes("enter"));
  assert.equal(run.editCount(), 1);
  assert.equal(run.reveals[0]?.selection?.entity, "edges");
  const cancelled = await graphActions();
  await cancelled.run({ kind: "connect", source: nodeId("profile") });
  assert.equal(cancelled.editCount(), 0);
  assert.deepEqual(cancelled.reveals, []);
});

test("endpoint pickers filter port directions and preserve relink implementation confirmation", async () => {
  const run = await graphActions();
  run.picks.push({ label: "prepare_optimization" });
  await run.run({ kind: "relink-endpoint", edge: edgeId("enter__profile"), endpoint: "source" });
  const labels = run.prompts[0]!.choices.map((item) => (item as { label: string }).label);
  assert.ok(!labels.includes("exit") && !labels.includes("failure"));
  assert.equal(run.warnings.length, 1);
  assert.equal(run.editCount(), 0, "cancelling implementation move must leave the edge untouched");
  run.picks.push({ label: "prepare_optimization" });
  run.confirm("Move implementation and relink");
  await run.run({ kind: "relink-endpoint", edge: edgeId("enter__profile"), endpoint: "source" });
  assert.equal(run.editCount(), 1);
  assert.ok(subroutineIn(run.state.snapshot!, "main")!.edges.some((edge) => edge.source === "prepare_optimization" && edge.target === "profile"));
  const target = await graphActions();
  await target.run({ kind: "relink-endpoint", edge: edgeId("enter__profile"), endpoint: "target" });
  assert.ok(!target.prompts[0]!.choices.some((item) => (item as { label: string }).label === "enter"));
});

test("creation reveals nodes, definitions, features, and workflow or parameter resources", async () => {
  const cases: { action: CanvasAction; picks: unknown[]; inputs: string[]; entity: string; scope: string }[] = [
    { action: { kind: "add-node" }, picks: [{ label: "python" }], inputs: ["Created"], entity: "nodes", scope: "main" },
    { action: { kind: "add-definition" }, picks: [{ definitionKind: "subroutine" }], inputs: ["Created"], entity: "subroutines", scope: "main__created" },
    { action: { kind: "add-call" }, picks: [{ label: "subroutine_call" }, { label: "main__implement" }], inputs: ["Created"], entity: "nodes", scope: "main" },
    { action: { kind: "add-feature" }, picks: [{ label: "boolean" }], inputs: ["Created", "An explicit flag"], entity: "features", scope: "main" },
    { action: { kind: "add-profile" }, picks: [{ parameter: true }], inputs: ["Created"], entity: "profile_parameters", scope: "main" },
    { action: { kind: "add-session" }, picks: [{ parameter: true }], inputs: ["Created"], entity: "session_parameters", scope: "main" },
    { action: { kind: "add-profile", workflow: graphId("main") }, picks: [], inputs: ["Created"], entity: "profiles", scope: "workflow:main" },
    { action: { kind: "add-session", workflow: graphId("main") }, picks: [{ value: true }], inputs: ["Created"], entity: "sessions", scope: "workflow:main" },
  ];
  for (const item of cases) {
    const run = await graphActions();
    run.picks.push(...item.picks);
    run.inputs.push(...item.inputs);
    await run.run(item.action);
    assert.equal(run.editCount(), 1, JSON.stringify(item.action));
    assert.equal(run.reveals.length, 1, JSON.stringify(item.action));
    assert.equal(run.reveals[0]?.inspection?.entity, item.entity, JSON.stringify(item.action));
    assert.equal(run.reveals[0]?.scope, item.scope, JSON.stringify(item.action));
  }
});

test("creation does not steal navigation after a failed save or an intervening navigation", async () => {
  for (const reason of ["save", "navigate"] as const) {
    const run = await graphActions();
    run.picks.push({ label: "python" });
    run.inputs.push("Created");
    if (reason === "save") run.failSave();
    else run.navigateDuringSave();
    await run.run({ kind: "add-node" });
    assert.deepEqual(run.reveals, [], reason);
  }
  const pinned = await graphActions();
  pinned.state.snapshot = { ...pinned.state.snapshot!, pinned: { "local.tools": testProject() as unknown as ProjectSnapshot["project"] } };
  pinned.picks.push({ label: "python" });
  pinned.inputs.push("Created");
  await pinned.run({ kind: "add-node" }, "local.tools/main");
  assert.equal(pinned.reveals[0]?.scope, "local.tools/main");
});

test("only the latest refresh publishes a snapshot or read failure", async () => {
  const reads = [deferred<ProjectSnapshot>(), deferred<ProjectSnapshot>(), deferred<ProjectSnapshot>(), deferred<ProjectSnapshot>()];
  let index = 0;
  const errors: string[] = [];
  const posted: HostToCanvas[] = [];
  const { refresh } = await load<typeof import("./projectHost")>("projectHost.ts", {
    vscode: {
      commands: {},
      window: { showErrorMessage: (message: string) => errors.push(message) },
      workspace: { isTrusted: true },
    },
    "./clone": { readClone: () => reads[index++]!.promise, projectFileReadonly() {}, subroutineFile() {} },
  });
  const state = host(snapshot("initial"));
  state.view = { webview: { postMessage: (message: HostToCanvas) => posted.push(message) } } as unknown as vscode.WebviewView;
  const older = refresh(state);
  const newer = refresh(state);
  reads[1]!.resolve(snapshot("new"));
  await newer;
  reads[0]!.resolve(snapshot("old"));
  assert.equal((await older)?.graph_hash, "new");
  assert.equal(state.snapshot?.graph_hash, "new");
  assert.equal(posted.length, 1);
  const failed = refresh(state);
  const newest = refresh(state);
  reads[3]!.resolve(snapshot("newest"));
  await newest;
  reads[2]!.reject(new Error("old invalid JSON"));
  assert.equal((await failed)?.graph_hash, "newest");
  assert.deepEqual(errors, []);
  assert.equal(posted.length, 2);
  state.termination?.dispose();
});

test("automatic service analysis waits for Workspace Trust", async () => {
  let trusted = false;
  let calls = 0;
  const { refresh } = await load<typeof import("./projectHost")>("projectHost.ts", {
    vscode: {
      commands: {}, window: {},
      workspace: { get isTrusted() { return trusted; } },
    },
    "./clone": { readClone: async () => snapshot("graph"), projectFileReadonly() {}, subroutineFile() {} },
    "./verdogCommand": {
      cliCommand: () => ["verdog"],
      runVerdogCommand: async (_root: string, arguments_: string[]) => {
        assert.deepEqual(arguments_, ["analyze", "--json"]);
        ++calls;
        return {
          code: 0, combined: "", stderr: "",
          stdout: JSON.stringify({ projects: { "": "graph" }, definitions: {} }),
        };
      },
    },
  });
  const state = host();
  try {
    await refresh(state);
    assert.equal(state.snapshot?.editable, false);
    assert.equal(state.snapshot?.termination?.status, "unavailable");
    if (state.snapshot?.termination?.status === "unavailable") {
      assert.match(state.snapshot.termination.reason, /Trust this workspace.*send project manifests/);
    }
    await delay(300);
    assert.equal(calls, 0, "Restricted Mode must not upload project manifests");
    trusted = true;
    await refresh(state);
    await delay(300);
    assert.equal(calls, 1);
    assert.equal(state.snapshot?.termination?.status, "ready");
  } finally { state.termination?.dispose(); }
});

test("workspace trust centrally gates editing and executable workflow verbs", async () => {
  let trusted = false;
  const warnings: string[] = [];
  let calls = 0;
  const { isEditable, runVerb } = await load<typeof import("./projectHost")>(
    "projectHost.ts",
    {
      vscode: {
        ProgressLocation: { Window: 1 },
        workspace: {
          get isTrusted() { return trusted; },
          getConfiguration: () => ({ get: () => ["verdog"] }),
        },
        window: {
          showWarningMessage: (message: string) => warnings.push(message),
          withProgress: (_options: unknown, run: () => unknown) => run(),
        },
      },
      "./cli": {
        diagnosticRange() {},
        parseVerdict() {},
        verdog: async () => {
          ++calls;
          return { code: 0, combined: "", stderr: "", stdout: "" };
        },
      },
    },
  );
  const state = host(snapshot("graph"));

  assert.equal(isEditable(state), false);
  trusted = true;
  assert.equal(isEditable(state), true);
  trusted = false;
  for (const verb of ["check", "run", "sync"] as const) await runVerb(state, state.root, verb);
  assert.equal(calls, 0);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((warning) => warning.includes("Trust this workspace")));
  trusted = true;
  await runVerb(state, state.root, "run", ["argument with spaces"]);
  assert.equal(calls, 1);
});

test("property action handlers return the actual edit or rename result, including cancellation", async () => {
  let saved = false;
  let exitCode = 1;
  const { handleCanvasAction } = await load<typeof import("./projectActions")>("projectActions.ts", {
    vscode: {
      workspace: { isTrusted: true, getConfiguration: () => ({ get: () => ["verdog"] }) },
      window: {
        showWarningMessage() {}, showInformationMessage() {}, showQuickPick() {},
        withProgress: (_options: unknown, run: () => unknown) => run(),
      },
      ProgressLocation: { Window: 1 },
    },
    "./cli": { verdog: async () => ({ code: exitCode }) },
    "./projectHost": {
      chooseSubroutine() {}, cliCommand: () => ["verdog"], editSubroutine: async () => saved,
      entities: () => [], followNavigation() {}, followNavigationTarget() {}, projectOf: testProject, isEditable: () => true,
      locate: () => ({ root: "/test/project", subroutine: "main" }), readAccess() {}, refresh() {},
      runVerb() {}, subroutineIds: () => [],
    },
  });
  const state = host(snapshot("graph"));
  const actions: CanvasAction[] = [
    { kind: "name", entity: "nodes", id: nodeId("profile"), name: "renamed" },
    { kind: "unconstrain", edge: edgeId("enter__profile"), collection: "conditions", feature: featureId("remaining_iterations") },
    { kind: "set-session-persistence", session: agentSessionId("session"), persistent: true },
    { kind: "set-profile-configuration", profile: agentProfileId("profile"), provider: "codex", options: { model: null, reasoning_effort: null, extra_args: [] } },
    { kind: "set-node-resources", node: nodeId("profile"), resources: [] },
    { kind: "set-workflow-resources", workflow: graphId("main"), resources: [] },
  ];
  for (const message of actions) {
    saved = false;
    assert.equal(await handleCanvasAction(state, { ...message, subroutine: "main" }), false, message.kind);
    saved = true;
    assert.equal(await handleCanvasAction(state, { ...message, subroutine: "main" }), true, message.kind);
  }
  assert.equal(await handleCanvasAction(state, { kind: "constrain", edge: edgeId("enter__profile"), subroutine: "main" }), false);
  const rename = { kind: "rename", entity: "nodes", id: nodeId("profile"), to: "renamed", subroutine: "main" } as const;
  assert.equal(await handleCanvasAction(state, rename), false);
  exitCode = 0;
  assert.equal(await handleCanvasAction(state, rename), true);
});

test("a failed document save is not saved; a later generation warning does not undo a saved graph", async () => {
  let save = false;
  let generations = 0;
  const warnings: string[] = [];
  const before = testProject();
  const { editSubroutine } = await load<typeof import("./projectHost")>("projectHost.ts", {
    vscode: {
      Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
      Range: class {}, WorkspaceEdit: class { replace() {} },
      window: { showErrorMessage: (message: string) => warnings.push(message), showWarningMessage: (message: string) => warnings.push(message) },
      workspace: {
        isTrusted: true,
        textDocuments: [], applyEdit: async () => true,
        getConfiguration: () => ({ get: () => ["verdog"] }),
        openTextDocument: async () => ({ getText: () => JSON.stringify(before), version: 1, positionAt: () => ({}), save: async () => save }),
      },
    },
    "./clone": { readClone: async () => snapshot("saved"), projectFileReadonly() {}, subroutineFile: () => ({ root: "/test/project", subroutine: "main" }) },
    "./cli": { verdog: async () => { ++generations; return { code: 1, combined: "generation failed" }; }, diagnosticRange() {}, parseVerdict() {} },
  });
  const change = () => ({ project: { ...before, package: "changed.project" } });
  assert.equal(await editSubroutine(host(), "main", "name", change), false);
  assert.equal(generations, 0);
  save = true;
  assert.equal(await editSubroutine(host(), "main", "name", change), true);
  assert.equal(generations, 1);
  assert.ok(warnings.some((warning) => warning.includes("graph was saved")));
});

test("host navigation shares history dispatch, prunes branches, and acknowledges every property result", async () => {
  const state = host(snapshot("graph"));
  const canvasMessages: HostToCanvas[] = [];
  const browserMessages: HostToNavigationBrowser[] = [];
  let canvasReceive!: (message: CanvasToHost) => Promise<void>;
  let browserReceive!: (message: NavigationBrowserToHost) => Promise<void>;
  let disposeBrowser!: () => void;
  let provider!: vscode.WebviewViewProvider;
  const commands = new Map<string, () => Promise<void>>();
  const followed: NavigationTarget[] = [];
  const followedEntries: NavigationEntry[] = [];
  const errors: string[] = [];
  const action = deferred<boolean>();
  let outcome: () => Promise<boolean> = () => action.promise;
  let calls = 0;
  const panel = {
    webview: { onDidReceiveMessage: (receive: typeof browserReceive) => { browserReceive = receive; }, postMessage: (message: HostToNavigationBrowser) => browserMessages.push(message) },
    onDidDispose: (dispose: () => void) => { disposeBrowser = dispose; },
    reveal() {}, dispose: () => disposeBrowser(),
  };
  const { registerCanvas } = await load<typeof import("./canvasView")>("canvasView.ts", {
    vscode: {
      Uri: { joinPath: () => ({}) }, ViewColumn: { Active: 1 },
      window: {
        createWebviewPanel: () => panel,
        registerWebviewViewProvider: (_id: string, value: vscode.WebviewViewProvider) => { provider = value; },
        showErrorMessage: (message: string) => errors.push(message),
      },
      commands: { registerCommand: (id: string, callback: () => Promise<void>) => commands.set(id, callback) },
    },
    "./webviewHtml": { webviewHtml: () => "" },
    "./projectActions": { handleCanvasAction: () => { ++calls; return outcome(); } },
    "./projectHost": {
      deliverPendingReveal() {},
      followNavigation: (_host: OpenHost, entry: NavigationEntry) => followedEntries.push(entry),
      followNavigationTarget: (_host: OpenHost, target: NavigationTarget) => followed.push(target),
      hasProject: () => true, openProjectDocument() {}, refresh() {}, selectWorkflowEnvironment() {},
    },
  });
  registerCanvas(state, {} as vscode.Uri);
  const view = {
    webview: { onDidReceiveMessage: (receive: typeof canvasReceive) => { canvasReceive = receive; }, postMessage: (message: HostToCanvas) => canvasMessages.push(message) },
    onDidDispose() {},
  } as unknown as vscode.WebviewView;
  provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  await commands.get("verdog.canvasBack")!();
  assert.deepEqual(canvasMessages.pop(), { kind: "navigate", direction: "back" });

  const browse = async (category: "profiles" | "sessions" | "features") => {
    await canvasReceive({ kind: "browse", page: navigationPage(state.snapshot!, "main", category), target: { scope: "main" }, panel: category });
  };
  await browse("profiles");
  await browse("sessions");
  await commands.get("verdog.canvasBack")!();
  const back = browserMessages.at(-1)!;
  assert.equal(back.kind, "page");
  assert.equal(back.page.category, "profiles");
  assert.deepEqual(canvasMessages.at(-1), { kind: "navigation-state", canGoBack: false, canGoForward: true });
  // Simulate the canvas completing this history restoration before branching.
  await canvasReceive({ kind: "browse", page: back.page, target: { scope: "main" }, panel: "profiles", restoration: back.route });
  await browse("features");
  const internals = provider as unknown as { browserVisits: Map<string, unknown>; browserTraversal: { entries: string[] } };
  assert.equal(internals.browserVisits.size, 2);
  assert.deepEqual(new Set(internals.browserVisits.keys()), new Set(internals.browserTraversal.entries));
  const branch = browserMessages.at(-1)!;
  assert.equal(branch.kind, "page");
  assert.deepEqual(branch.retainedRoutes, internals.browserTraversal.entries);
  await browse("profiles");
  assert.equal(internals.browserVisits.size, 2, "a repeated route shares its retained page");
  await canvasReceive({ kind: "navigate", direction: "back" });
  assert.equal(browserMessages.at(-1)?.kind, "page");
  await browserReceive({ kind: "navigate", direction: "forward" });

  // A real entity page supplies the authoritative target for property editing.
  await canvasReceive({ kind: "cancel-navigation", navigationVersion: 1 });
  const { entityPropertyPage } = await import("../webview/propertyData");
  const { snapshotCanvasGraphs } = await import("../webview/subroutineGraphs");
  const inspection = { entity: "nodes", id: nodeId("profile"), subroutine: "main" } as const;
  const page = entityPropertyPage(state.snapshot!, snapshotCanvasGraphs(state.snapshot!).main!, inspection, "main");
  assert.ok(page);
  await canvasReceive({ kind: "browse", page, target: { scope: "main", inspection } });
  const current = browserMessages.at(-1)!;
  assert.equal(current.kind, "page");
  assert.equal(current.overview?.inspection?.entity, "subroutines");
  assert.equal(current.overview?.scope, "main");
  const previousFollowed = followed.length;
  await browserReceive({ kind: "overview", route: "stale" });
  assert.equal(followed.length, previousFollowed);
  await browserReceive({ kind: "overview", route: current.route });
  assert.deepEqual(followed.at(-1), current.overview);
  const request = { kind: "property", requestId: 1, route: current.route, edit: { kind: "name", name: "Changed" } } as const;
  const pending = browserReceive(request);
  await browserReceive({ ...request, requestId: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(browserMessages.at(-1), { kind: "property-result", requestId: 2, route: request.route, saved: false });
  action.resolve(false);
  await pending;
  assert.deepEqual(browserMessages.at(-1), { kind: "property-result", requestId: 1, route: request.route, saved: false });
  outcome = async () => true;
  await browserReceive({ ...request, requestId: 3 });
  assert.equal((browserMessages.at(-1) as { saved: boolean }).saved, true);
  outcome = async () => { throw new Error("save failed"); };
  await browserReceive({ ...request, requestId: 4 });
  assert.equal((browserMessages.at(-1) as { saved: boolean }).saved, false);
  assert.equal(errors.length, 1);
  await browserReceive({ ...request, requestId: 5, route: "stale" });
  assert.deepEqual(browserMessages.at(-1), { kind: "property-result", requestId: 5, route: "stale", saved: false });

  const report: TerminationReport = {
    projects: { "": "graph" },
    definitions: { main: {
      status: "not_certified", local_status: "not_certified", reason: "residual cycle", memory_states: 2, rules: 2,
      dependencies: [], edges: { enter__profile: "remaining" },
      regions: [{
        id: "region-1", nodes: ["profile"], edges: ["enter__profile"], witnesses: [],
        cycle: [{ node: "profile", values: [], edge: "enter__profile" }],
      }],
    } },
  };
  state.snapshot!.termination = { status: "ready", report };
  state.snapshotChanged?.();
  const highlight = {
    kind: "termination-highlight", route: current.route, region: "region-1", revision: terminationRevision(report),
  } as const;
  const beforeHighlight = canvasMessages.length;
  for (const invalid of [
    { ...highlight, route: "stale" }, { ...highlight, revision: "stale" }, { ...highlight, region: "missing" },
  ]) await browserReceive(invalid);
  assert.equal(canvasMessages.length, beforeHighlight, "stale routes, revisions, and unknown regions never reach the canvas");
  await browserReceive(highlight);
  assert.deepEqual(canvasMessages.at(-1), {
    kind: "termination-highlight", scope: "main", region: "region-1", revision: highlight.revision,
  });
  await browserReceive({ ...highlight, region: null });
  assert.equal((canvasMessages.at(-1) as { region: unknown }).region, null);
  state.snapshot!.termination = { status: "checking" };
  const checkingMessages = canvasMessages.length;
  await browserReceive(highlight);
  assert.equal(canvasMessages.length, checkingMessages, "a refresh immediately disables prior report highlights");
  state.snapshot!.termination = { status: "ready", report };
  const statusPage = navigationPage(state.snapshot!, "main", "status");
  await canvasReceive({ kind: "browse", page: statusPage, target: { scope: "main" }, panel: "status" });
  const statusRoute = browserMessages.at(-1)!;
  assert.equal(statusRoute.kind, "page");
  const edge = statusPage.termination?.entries.find(({ entity }) => entity === "edges");
  assert.ok(edge);
  await browserReceive({ kind: "reveal", route: statusRoute.route, key: edge.key });
  assert.equal(followedEntries.at(-1)?.id, edge.id, "termination references use ordinary entity navigation");
  panel.dispose();
  await commands.get("verdog.canvasForward")!();
  assert.deepEqual(canvasMessages.at(-1), { kind: "navigate", direction: "forward" });
});
