import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import type * as vscode from "vscode";

import type { Outcome } from "./cli";

/** Bundle the real policy module while replacing its editor and process boundaries. */
async function load<T>(mocks: Record<string, Record<string, unknown>>): Promise<T> {
  const key = `verdog-command-test-${Math.random()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = mocks;
  try {
    const result = await build({
      entryPoints: [path.resolve("src", "verdogCommand.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      mainFields: ["module", "main"],
      plugins: [{
        name: "test-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: specifier }) =>
            specifier in mocks ? { path: specifier, namespace: "mock" } : undefined);
          builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path: specifier }) => ({
            contents: Object.keys(mocks[specifier]!).map((name) =>
              `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`
            ).join("\n"),
          }));
        },
      }],
    });
    const code = `${result.outputFiles![0]!.text}\n//# sourceURL=verdog-command-test`;
    return await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as T;
  } finally {
    delete globals[key];
  }
}

const success = (): Outcome => ({ code: 0, combined: "", stderr: "", stdout: "" });

function output(lines: string[]): vscode.OutputChannel {
  return {
    appendLine: (line: string) => lines.push(line),
    show() {},
  } as unknown as vscode.OutputChannel;
}

test("configured CLI command arrays are used and invalid values fall back to verdog", async () => {
  let configured: unknown = ["uv", "run", "verdog"];
  const commands: string[][] = [];
  const module = await load<typeof import("./verdogCommand")>({
    vscode: {
      workspace: {
        isTrusted: true,
        getConfiguration: () => ({ get: () => configured }),
      },
      window: {},
    },
    "./cli": {
      verdog: async (_root: string, _arguments: string[], options: { command: string[] }) => {
        commands.push(options.command);
        return success();
      },
    },
  });

  assert.deepEqual(module.cliCommand(), ["uv", "run", "verdog"]);
  await module.runVerdogCommand("/project", ["check"], {
    announce: false,
    output: output([]),
  });
  assert.deepEqual(commands, [["uv", "run", "verdog"]]);

  for (const invalid of [[], "verdog", [""], ["verdog", 1]]) {
    configured = invalid;
    assert.deepEqual(module.cliCommand(), ["verdog"]);
  }
});

test("workspace trust blocks invocation unless the caller already verified trust", async () => {
  const warnings: string[] = [];
  let calls = 0;
  const module = await load<typeof import("./verdogCommand")>({
    vscode: {
      workspace: { isTrusted: false, getConfiguration: () => ({ get: () => ["verdog"] }) },
      window: { showWarningMessage: (message: string) => warnings.push(message) },
    },
    "./cli": { verdog: async () => { ++calls; return success(); } },
  });

  const blocked = await module.runVerdogCommand("/project", ["run"], {
    announce: false,
    output: output([]),
  });
  assert.equal(blocked, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(warnings, ["Trust this workspace before running `verdog run`."]);

  assert.deepEqual(await module.runVerdogCommand("/project", ["run"], {
    announce: false,
    output: output([]),
    trust: "caller-verified",
  }), success());
  assert.equal(calls, 1);
});

test("structured commands suppress stdout while stderr reaches output and progress", async () => {
  const outputLines: string[] = [];
  const progressLines: string[] = [];
  let stdoutWasConfigured = true;
  const module = await load<typeof import("./verdogCommand")>({
    vscode: {
      workspace: { isTrusted: true, getConfiguration: () => ({ get: () => ["verdog"] }) },
      window: {
        withProgress: (
          _options: unknown,
          run: (progress: vscode.Progress<{ message?: string }>) => Promise<Outcome>,
        ) => run({ report: ({ message }) => { if (message !== undefined) progressLines.push(message); } }),
      },
    },
    "./cli": {
      verdog: async (
        _root: string,
        _arguments: string[],
        options: {
          onStderrLine?: (line: string) => void;
          onStdoutLine?: (line: string) => void;
        },
      ) => {
        stdoutWasConfigured = options.onStdoutLine !== undefined;
        options.onStdoutLine?.("machine-readable stdout");
        options.onStderrLine?.("checking source");
        return success();
      },
    },
  });

  await module.runVerdogCommand("/project", ["runs", "--json"], {
    announce: false,
    output: output(outputLines),
    progress: {
      location: 1 as vscode.ProgressLocation,
      reportStderr: true,
      title: "Loading runs",
    },
    structured: true,
  });

  assert.equal(stdoutWasConfigured, false);
  assert.deepEqual(outputLines, ["checking source"]);
  assert.deepEqual(progressLines, ["checking source"]);
});

test("editor and external cancellation both abort the process signal and dispose listeners", async () => {
  let cancel: (() => void) | undefined;
  let listenerDisposed = false;
  let processSignal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const started: Promise<void>[] = [];
  const startResolvers: Array<() => void> = [];
  const makeStarted = () => {
    started.push(new Promise<void>((resolve) => startResolvers.push(resolve)));
  };
  makeStarted();
  makeStarted();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (callback: () => void) => {
      cancel = callback;
      return { dispose: () => { listenerDisposed = true; } };
    },
  } as vscode.CancellationToken;
  const module = await load<typeof import("./verdogCommand")>({
    vscode: {
      workspace: { isTrusted: true, getConfiguration: () => ({ get: () => ["verdog"] }) },
      window: {
        withProgress: (
          _options: unknown,
          run: (
            progress: vscode.Progress<{ message?: string }>,
            cancellation: vscode.CancellationToken,
          ) => Promise<Outcome>,
        ) => run({ report() {} }, token),
      },
    },
    "./cli": {
      verdog: async (_root: string, _arguments: string[], options: { signal?: AbortSignal }) => {
        processSignal = options.signal;
        startResolvers.shift()?.();
        await new Promise<void>((resolve) => { finish = resolve; });
        return success();
      },
    },
  });
  const run = (signal: AbortSignal) => module.runVerdogCommand("/project", ["run"], {
    announce: false,
    output: output([]),
    progress: { cancellable: true, location: 1 as vscode.ProgressLocation, title: "Running" },
    signal,
  });

  const external = new AbortController();
  const externalRun = run(external.signal);
  await started[0];
  assert.equal(processSignal?.aborted, false);
  external.abort();
  assert.equal(processSignal?.aborted, true);
  finish?.();
  await externalRun;
  assert.equal(listenerDisposed, true);

  listenerDisposed = false;
  const editorRun = run(new AbortController().signal);
  await started[1];
  assert.equal(processSignal?.aborted, false);
  cancel?.();
  assert.equal(processSignal?.aborted, true);
  finish?.();
  await editorRun;
  assert.equal(listenerDisposed, true);
});
