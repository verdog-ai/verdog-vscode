/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview The extension reaches the service through the CLI so credentials stay out of webviews and
 * protocol handling has one implementation. Machine-readable commands own stdout; stderr is
 * kept separate for diagnostics.
 */

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {createInterface} from 'node:readline';

import {directProjectPath} from './projectPath';

export interface Outcome {
  code: number;
  /** Stdout and stderr in the order their chunks reached this process. */
  combined: string;
  stderr: string;
  stdout: string;
}

export interface CliDiagnostic {
  /** Stable machine-readable diagnostic identifier. */
  code?: string;
  column?: number;
  endColumn?: number;
  endLine?: number;
  file?: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
}

/** What the canvas reads from `verdog check --json`. */
export interface Verdict {
  diagnostics: CliDiagnostic[];
  /** The graph this verdict describes, so a later edit can invalidate it. */
  graphHash: string;
}

/**
 * Run the CLI.
 *
 * `command` is the whole invocation, because `verdog` is usually on `PATH` but not always --
 * a user may keep the runtime-provided CLI in a virtual environment. It is a parameter
 * rather than a setting read in here so this file stays free
 * of `vscode` and can be tested by `node --test`.
 */
export function verdog(
  root: string,
  args: string[],
  options: {
    command?: string[];
    /** A trusted editor setting; credentials are sent through stdin, never argv or env. */
    backend?: {origin: string; token?: string};
    onLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    onStdoutLine?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Outcome> {
  const {onLine, onStderrLine, onStdoutLine, signal} = options;
  const [executable, ...prefix] = options.command?.length
    ? options.command
    : ['verdog'];
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({code: 130, combined: '', stderr: '', stdout: ''});
      return;
    }
    // A configurable launcher (for example uv) may have a Python child of its own.
    const processGroup = signal !== undefined && process.platform !== 'win32';
    const env = {...process.env};
    delete env.VERDOG_BACKEND_ORIGIN;
    delete env.VERDOG_SESSION_TOKEN_STDIN;
    if (options.backend !== undefined) {
      env.VERDOG_BACKEND_ORIGIN = options.backend.origin;
      env.VERDOG_SESSION_TOKEN_STDIN =
        options.backend.token === undefined ? '0' : '1';
    }
    // An older CLI must reject this option instead of silently using its saved backend.
    const backendArguments =
      options.backend === undefined
        ? []
        : ['--backend-origin', options.backend.origin];
    const child = spawn(executable, [...prefix, ...backendArguments, ...args], {
      cwd: root,
      detached: processGroup,
      env,
    });
    let combined = '';
    let stderr = '';
    let stdout = '';
    let settled = false;
    const abort = () => {
      if (child.pid === undefined || settled) {
        return;
      }
      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          {windowsHide: true},
        );
        killer.once('error', () => child.kill('SIGKILL'));
        return;
      }
      try {
        process.kill(processGroup ? -child.pid : child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    signal?.addEventListener('abort', abort, {once: true});
    const finish = (outcome: Outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(outcome);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      combined += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      combined += chunk;
    });
    for (const [stream, specific] of [
      [child.stdout, onStdoutLine],
      [child.stderr, onStderrLine],
    ] as const) {
      if (onLine === undefined && specific === undefined) {
        continue;
      }
      createInterface({input: stream, crlfDelay: Infinity}).on('line', line => {
        if (!line) {
          return;
        }
        onLine?.(line);
        specific?.(line);
      });
    }
    child.once('error', error => {
      const lines = [
        `${executable} could not be started: ${error.message}`,
        'Install the CLI with `uv tool install verdog-cli`, or set ' +
          '`verdog.command` to an argument array containing its executable path.',
      ];
      for (const line of lines) {
        onLine?.(line);
        onStderrLine?.(line);
      }
      const message = lines.join('\n');
      finish({
        code: 127,
        combined: combined + message,
        stderr: stderr + message,
        stdout,
      });
    });
    child.once('close', code =>
      finish({
        code: signal?.aborted ? 130 : (code ?? 1),
        combined,
        stderr,
        stdout,
      }),
    );
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A process that fails before reading stdin reports its own exit status.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        child.kill();
        const message = 'The Verdog CLI input pipe failed.';
        finish({code: 1, combined: message, stderr: message, stdout: ''});
      }
    });
    child.stdin.end(options.backend?.token ?? '');
  });
}

function diagnostic(value: unknown, root: string): CliDiagnostic | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  const message = typeof item.message === 'string' ? item.message : '';
  if (!message) {
    return undefined;
  }
  const severity = item.severity === 'warning' ? 'warning' : 'error';
  const file =
    typeof item.path === 'string' && item.path
      ? path.join(root, ...item.path.split('/'))
      : undefined;
  const code =
    typeof item.code === 'string' && item.code ? item.code : undefined;
  return {
    code,
    column: typeof item.column === 'number' ? item.column : undefined,
    endColumn:
      typeof item.end_column === 'number' ? item.end_column : undefined,
    endLine: typeof item.end_line === 'number' ? item.end_line : undefined,
    file,
    line: typeof item.line === 'number' ? item.line : undefined,
    message: code ? `${message} [${code}]` : message,
    severity,
  };
}

/** Convert the CLI's one-based, end-exclusive source span to VS Code coordinates. */
export function diagnosticRange(
  item: CliDiagnostic,
): [number, number, number, number] {
  const line = Math.max((item.line ?? 1) - 1, 0);
  const column = Math.max((item.column ?? 1) - 1, 0);
  if (
    item.line === undefined ||
    item.column === undefined ||
    item.endLine === undefined ||
    item.endColumn === undefined
  ) {
    return [line, column, line, column + 1];
  }
  const endLine = Math.max(item.endLine - 1, 0);
  const endColumn = Math.max(item.endColumn - 1, 0);
  return endLine < line || (endLine === line && endColumn <= column)
    ? [line, column, line, column + 1]
    : [line, column, endLine, endColumn];
}

/** Read the single object emitted by `check --json`. */
export function parseVerdict(
  stdout: string,
  root: string,
): Verdict | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return undefined;
  }
  const body = decoded as Record<string, unknown>;
  if (
    typeof body.graph_hash !== 'string' ||
    !Array.isArray(body.diagnostics) ||
    !Array.isArray(body.type_diagnostics)
  ) {
    return undefined;
  }
  return {
    diagnostics: [...body.diagnostics, ...body.type_diagnostics]
      .map(item => diagnostic(item, root))
      .filter((item): item is CliDiagnostic => item !== undefined),
    graphHash: body.graph_hash,
  };
}

/** Read a successful CLI check only while its saved inputs still match. */
export async function readCheckVerdict(
  root: string,
  dirtyFiles: readonly string[] = [],
): Promise<Verdict | undefined> {
  try {
    const raw = await fs.readFile(
      await directProjectPath(root, '.verdog/check.json'),
      'utf8',
    );
    const verdict = parseVerdict(raw, root);
    const receipt: unknown = JSON.parse(raw);
    if (!verdict || !receipt || typeof receipt !== 'object') {
      return undefined;
    }
    const {version, sources} = receipt as Record<string, unknown>;
    if (
      version !== 1 ||
      !sources ||
      typeof sources !== 'object' ||
      Array.isArray(sources) ||
      typeof (sources as Record<string, unknown>)['project.json'] !== 'string'
    ) {
      return undefined;
    }
    for (const [relative, expected] of Object.entries(sources)) {
      if (
        expected !== null &&
        (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
      ) {
        return undefined;
      }
      const file = await directProjectPath(root, relative);
      if (dirtyFiles.includes(file)) {
        return undefined;
      }
      let actual: string | null;
      try {
        actual = createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        actual = null;
      }
      if (actual !== expected) {
        return undefined;
      }
    }
    return verdict;
  } catch {
    // Missing, stale, malformed, or unsafe receipts are not successful checks.
    return undefined;
  }
}
