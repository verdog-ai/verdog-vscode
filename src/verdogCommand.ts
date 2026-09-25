/** VS Code policy around invoking the platform-neutral Verdog CLI process. */

import * as vscode from "vscode";

import { type Outcome, verdog } from "./cli";

export type CommandTrust = "required" | "caller-verified";

export type CommandProgress = {
  readonly cancellable?: boolean;
  readonly location: vscode.ProgressLocation;
  readonly reportStderr?: boolean;
  readonly title: string;
};

export type VerdogCommandOptions = {
  readonly announce?: boolean;
  readonly output: vscode.OutputChannel;
  readonly progress?: CommandProgress;
  readonly signal?: AbortSignal;
  /** Structured commands reserve stdout for their one machine-readable document. */
  readonly structured?: boolean;
  readonly streamOutput?: boolean;
  readonly trust?: CommandTrust;
};

export function cliCommand(): string[] {
  const configured = vscode.workspace
    .getConfiguration("verdog")
    .get<unknown>("command", ["verdog"]);
  return (
    Array.isArray(configured) &&
    configured.length > 0 &&
    configured.every((part): part is string => typeof part === "string" && part.length > 0)
  )
    ? configured
    : ["verdog"];
}

const shellDisplay = (part: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part);

function trustAllows(arguments_: readonly string[], options: VerdogCommandOptions): boolean {
  if (options.trust === "caller-verified" || vscode.workspace.isTrusted) return true;
  const verb = arguments_[0] ?? "command";
  void vscode.window.showWarningMessage(
    `Trust this workspace before running \`verdog ${verb}\`.`,
  );
  return false;
}

function linkedSignal(
  external: AbortSignal | undefined,
  token: vscode.CancellationToken | undefined,
): { dispose(): void; signal?: AbortSignal } {
  if (token === undefined) return { dispose() {}, signal: external };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (external?.aborted || token.isCancellationRequested) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  const cancellation = token.onCancellationRequested(abort);
  return {
    dispose() {
      cancellation.dispose();
      external?.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

/**
 * Run Verdog with the editor policies shared by ordinary project actions and run history.
 * A structured invocation never copies stdout into progress or the output channel.
 */
export function runVerdogCommand(
  root: string,
  arguments_: readonly string[],
  options: VerdogCommandOptions & { readonly trust: "caller-verified" },
): Promise<Outcome>;
export function runVerdogCommand(
  root: string,
  arguments_: readonly string[],
  options: VerdogCommandOptions,
): Promise<Outcome | undefined>;
export async function runVerdogCommand(
  root: string,
  arguments_: readonly string[],
  options: VerdogCommandOptions,
): Promise<Outcome | undefined> {
  if (!trustAllows(arguments_, options)) return undefined;
  const announce = options.announce ?? true;
  const streamOutput = options.streamOutput ?? true;
  if (announce) {
    options.output.show(true);
    options.output.appendLine(`\n$ verdog ${arguments_.map(shellDisplay).join(" ")}`);
  }

  const invoke = async (
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
  ): Promise<Outcome> => {
    const linked = linkedSignal(options.signal, token);
    try {
      return await verdog(root, [...arguments_], {
        command: cliCommand(),
        signal: linked.signal,
        onStderrLine: streamOutput || options.progress?.reportStderr
          ? (line) => {
              if (streamOutput) options.output.appendLine(line);
              if (options.progress?.reportStderr) progress?.report({ message: line });
            }
          : undefined,
        onStdoutLine: streamOutput && !options.structured
          ? (line) => options.output.appendLine(line)
          : undefined,
      });
    } finally {
      linked.dispose();
    }
  };

  const progress = options.progress;
  return progress === undefined
    ? invoke()
    : vscode.window.withProgress(
        {
          cancellable: progress.cancellable ?? false,
          location: progress.location,
          title: progress.title,
        },
        invoke,
      );
}
