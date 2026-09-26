/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';

import {diagnosticRange, parseVerdict, readCheckVerdict, verdog} from './cli';

test('CLI output keeps streams separate and reports complete lines', async () => {
  const lines: string[] = [];
  const script = [
    'const output = Buffer.from("partial 💚\\r\\nlast")',
    'process.stdout.write(output.subarray(0, 10))',
    'setTimeout(() => {',
    '  process.stdout.write(output.subarray(10))',
    '  process.stderr.write("problem\\n")',
    '}, 10)',
  ].join(';\n');
  const result = await verdog(process.cwd(), [], {
    command: [process.execPath, '-e', script],
    onLine: line => lines.push(line),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'partial 💚\r\nlast');
  assert.equal(result.stderr, 'problem\n');
  assert.match(result.combined, /partial/);
  assert.match(result.combined, /problem/);
  assert.deepEqual(lines.sort(), ['last', 'partial 💚', 'problem']);
});

test('structured output is read only from stdout', async () => {
  const graphHash = 'a'.repeat(64);
  const body = JSON.stringify({
    diagnostics: [],
    graph_hash: graphHash,
    type_diagnostics: [],
  });
  const result = await verdog(process.cwd(), [], {
    command: [
      process.execPath,
      '-e',
      `process.stderr.write("{not json}\\n"); process.stdout.write(${JSON.stringify(body)})`,
    ],
  });

  assert.equal(parseVerdict(result.stdout, '/clone')?.graphHash, graphHash);
  assert.equal(parseVerdict(result.combined, '/clone'), undefined);
});

test('stream-specific line callbacks keep structured stdout away from progress', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const combined: string[] = [];
  const result = await verdog(process.cwd(), [], {
    command: [
      process.execPath,
      '-e',
      'process.stdout.write("json\\n"); process.stderr.write("progress\\n")',
    ],
    onLine: line => combined.push(line),
    onStderrLine: line => stderr.push(line),
    onStdoutLine: line => stdout.push(line),
  });

  assert.equal(result.code, 0);
  assert.deepEqual(stdout, ['json']);
  assert.deepEqual(stderr, ['progress']);
  assert.deepEqual(combined.sort(), ['json', 'progress']);
});

test('a command that cannot start reports a synthetic failure', async () => {
  const lines: string[] = [];
  const result = await verdog(process.cwd(), [], {
    command: ['/definitely/not/a/verdog/executable'],
    onLine: line => lines.push(line),
  });

  assert.equal(result.code, 127);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /could not be started/);
  assert.match(result.combined, /verdog\.command/);
  assert.match(result.combined, /uv tool install verdog-cli/);
  assert.equal(lines.length, 2);
  assert.match(lines.join('\n'), /could not be started.*verdog\.command/s);
});

test('cancellation kills the CLI process rather than merely ignoring its result', async () => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 1000);
  const result = await verdog(process.cwd(), [], {
    command: [
      process.execPath,
      '-e',
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    signal: controller.signal,
    onLine: () => controller.abort(),
  });
  clearTimeout(deadline);
  assert.equal(result.code, 130);
  assert.equal(result.stdout, 'ready\n');
  const alreadyCancelled = await verdog(process.cwd(), [], {
    command: ['/must/not/start'],
    signal: controller.signal,
  });
  assert.equal(alreadyCancelled.code, 130);
});

test('a partial JSON envelope is not a verdict', () => {
  assert.equal(parseVerdict('{}', '/clone'), undefined);
  assert.equal(
    parseVerdict(
      '{"diagnostics":[],"graph_hash":"","type_diagnostics":[]}',
      '/clone',
    )?.graphHash,
    '',
  );
});

test('diagnostic ranges use complete spans and retain a one-character fallback', () => {
  assert.deepEqual(
    diagnosticRange({
      column: 13,
      endColumn: 25,
      endLine: 18,
      line: 18,
      message: 'unknown type',
      severity: 'error',
    }),
    [17, 12, 17, 24],
  );
  assert.deepEqual(
    diagnosticRange({
      line: 4,
      column: 2,
      message: 'old diagnostic',
      severity: 'warning',
    }),
    [3, 1, 3, 2],
  );
});

test('backend origin is explicit and session credentials travel only through stdin', async () => {
  const script = `
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({
      argv: process.argv.slice(1),
      origin: process.env.VERDOG_BACKEND_ORIGIN,
      inputFlag: process.env.VERDOG_SESSION_TOKEN_STDIN,
      leaked: JSON.stringify(process.env).includes('test-session-secret'),
      tokenReceived: Buffer.concat(chunks).toString() === 'test-session-secret',
    })));
  `;
  for (const token of [undefined, 'test-session-secret']) {
    const result = await verdog(process.cwd(), ['catalogue'], {
      command: [process.execPath, '-e', script, '--'],
      backend: {origin: 'http://127.0.0.1:18765', token},
    });
    assert.equal(result.code, 0);
    const received = JSON.parse(result.stdout);
    assert.deepEqual(received.argv, [
      '--backend-origin',
      'http://127.0.0.1:18765',
      'catalogue',
    ]);
    assert.equal(received.origin, 'http://127.0.0.1:18765');
    assert.equal(received.inputFlag, token === undefined ? '0' : '1');
    assert.equal(received.leaked, false);
    assert.equal(received.tokenReceived, token !== undefined);
  }
});

test('CLI check receipts are current only for the exact saved sources', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-check-'));
  context.after(() => fs.rm(root, {recursive: true, force: true}));
  const files = {
    'project.json': '{}',
    'impl.py': 'answer = 42\r\n',
    'external/pinned/impl.py': 'value = 1\n',
  };
  const sources: Record<string, string | null> = {'ty.toml': null};
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), {recursive: true});
    await fs.writeFile(path.join(root, relative), content);
    sources[relative] = createHash('sha256').update(content).digest('hex');
  }
  const receipt = {
    version: 1,
    graph_hash: 'graph',
    sources,
    diagnostics: [],
    type_diagnostics: [],
  };
  await fs.mkdir(path.join(root, '.verdog'));
  const save = () =>
    fs.writeFile(
      path.join(root, '.verdog/check.json'),
      JSON.stringify(receipt),
    );
  assert.equal(await readCheckVerdict(root), undefined);
  await save();
  assert.equal((await readCheckVerdict(root))?.graphHash, 'graph');
  assert.equal(
    (await readCheckVerdict(root))?.graphHash,
    'graph',
    'reopening restores status',
  );
  assert.equal(
    await readCheckVerdict(root, [path.join(root, 'impl.py')]),
    undefined,
  );
  await fs.writeFile(path.join(root, 'impl.py'), 'answer = 43\n');
  assert.equal(
    await readCheckVerdict(root),
    undefined,
    'Python edits without graph changes',
  );
  await fs.writeFile(path.join(root, 'impl.py'), files['impl.py']);
  await fs.writeFile(path.join(root, 'ty.toml'), '');
  assert.equal(
    await readCheckVerdict(root),
    undefined,
    'new type checker config',
  );
  await fs.unlink(path.join(root, 'ty.toml'));
  await fs.unlink(path.join(root, 'external/pinned/impl.py'));
  assert.equal(
    await readCheckVerdict(root),
    undefined,
    'deleted pinned source',
  );
  await fs.writeFile(
    path.join(root, 'external/pinned/impl.py'),
    files['external/pinned/impl.py'],
  );
  sources['../outside'] = null;
  await save();
  assert.equal(
    await readCheckVerdict(root),
    undefined,
    'paths cannot escape the project',
  );
  delete sources['../outside'];
  receipt.version = 2;
  await save();
  assert.equal(
    await readCheckVerdict(root),
    undefined,
    'unknown receipt version',
  );
  await fs.writeFile(path.join(root, '.verdog/check.json'), '{');
  assert.equal(await readCheckVerdict(root), undefined, 'incomplete receipt');
});
