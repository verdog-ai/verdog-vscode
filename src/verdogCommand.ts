/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview VS Code policy around invoking the platform-neutral Verdog CLI process. */

import * as vscode from 'vscode';
import {homedir} from 'node:os';

import {type Outcome, verdog} from './cli';
import {backendOrigin, backendSession} from './backend';

export type CommandTrust = 'required' | 'caller-verified';

export interface CommandProgress {
  readonly cancellable?: boolean;
  readonly location: vscode.ProgressLocation;
  readonly reportStderr?: boolean;
  readonly title: string;
}

export interface VerdogCommandOptions {
  readonly announce?: boolean;
  readonly output: vscode.OutputChannel;
  readonly progress?: CommandProgress;
  readonly signal?: AbortSignal;
  /** Structured commands reserve stdout for their one machine-readable document. */
  readonly structured?: boolean;
  readonly streamOutput?: boolean;
  readonly trust?: CommandTrust;
}

export function cliCommand(): string[] {
  const configured = vscode.workspace
    .getConfiguration('verdog')
    .get<unknown>('command', ['verdog']);
  return Array.isArray(configured) &&
    configured.length > 0 &&
    configured.every(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    ? configured
    : ['verdog'];
}

/** All service calls use the trusted editor origin, independent of a clone or CLI login. */
export async function backendCommand(
  root: string,
  args: string[],
  options: NonNullable<Parameters<typeof verdog>[2]> & {
    interactive?: boolean;
  } = {},
): Promise<Outcome> {
  try {
    const authenticated = [
      'catalogue',
      'access',
      'import',
      'publish',
      'retract',
      'token',
      'whoami',
    ].includes(args[0]);
    const backend = authenticated
      ? await backendSession(options.interactive ?? true)
      : {origin: backendOrigin()};
    if (backend === undefined) {
      const message = 'Sign in with GitHub to use the Verdog catalogue.';
      return {
        code: 1,
        stdout: JSON.stringify({error: {code: 'auth.required', message}}),
        stderr: message,
        combined: message,
      };
    }
    // Browsing is available in Restricted Mode: a launcher must not resolve code from that workspace.
    const directory = ['catalogue', 'whoami'].includes(args[0])
      ? homedir()
      : root;
    return await verdog(directory, args, {
      ...options,
      command: options.command ?? cliCommand(),
      backend,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'The Verdog backend request failed.';
    return {code: 1, stdout: '', stderr: message, combined: message};
  }
}

function shellDisplay(part: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part);
}

function trustAllows(
  args: readonly string[],
  options: VerdogCommandOptions,
): boolean {
  if (options.trust === 'caller-verified' || vscode.workspace.isTrusted) {
    return true;
  }
  const verb = args[0] ?? 'command';
  void vscode.window.showWarningMessage(
    `Trust this workspace before running \`verdog ${verb}\`.`,
  );
  return false;
}

function linkedSignal(
  external: AbortSignal | undefined,
  token: vscode.CancellationToken | undefined,
): {dispose(): void; signal?: AbortSignal} {
  if (token === undefined) {
    return {dispose() {}, signal: external};
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (external?.aborted || token.isCancellationRequested) {
    controller.abort();
  } else {
    external?.addEventListener('abort', abort, {once: true});
  }
  const cancellation = token.onCancellationRequested(abort);
  return {
    dispose() {
      cancellation.dispose();
      external?.removeEventListener('abort', abort);
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
  args: readonly string[],
  options: VerdogCommandOptions & {readonly trust: 'caller-verified'},
): Promise<Outcome>;
export function runVerdogCommand(
  root: string,
  args: readonly string[],
  options: VerdogCommandOptions,
): Promise<Outcome | undefined>;
export async function runVerdogCommand(
  root: string,
  args: readonly string[],
  options: VerdogCommandOptions,
): Promise<Outcome | undefined> {
  if (!trustAllows(args, options)) {
    return undefined;
  }
  const announce = options.announce ?? true;
  const streamOutput = options.streamOutput ?? true;
  if (announce) {
    options.output.show(true);
    options.output.appendLine(`\n$ verdog ${args.map(shellDisplay).join(' ')}`);
  }

  const invoke = async (
    progress?: vscode.Progress<{message?: string}>,
    token?: vscode.CancellationToken,
  ): Promise<Outcome> => {
    const linked = linkedSignal(options.signal, token);
    try {
      return await backendCommand(root, [...args], {
        command: cliCommand(),
        signal: linked.signal,
        onStderrLine:
          streamOutput || options.progress?.reportStderr
            ? line => {
                if (streamOutput) {
                  options.output.appendLine(line);
                }
                if (options.progress?.reportStderr) {
                  progress?.report({message: line});
                }
              }
            : undefined,
        onStdoutLine:
          streamOutput && !options.structured
            ? line => options.output.appendLine(line)
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
