/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';

import {RunTrace} from './runTrace';

test('trace tails retain complete lines across partial UTF-8 appends', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-trace-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  const file = path.join(root, 'trace.log');
  const trace = new RunTrace(root);
  assert.equal(await trace.read(), undefined);
  await fs.writeFile(file, 'first\nnext ');
  assert.equal(await trace.read(), 'first');
  const unicode = Buffer.from('✓');
  await fs.appendFile(file, unicode.subarray(0, 1));
  assert.equal(await trace.read(), 'first');
  await fs.appendFile(
    file,
    Buffer.concat([unicode.subarray(1), Buffer.from('\r\n')]),
  );
  assert.equal(await trace.read(), 'next ✓');
  assert.equal(await trace.read(), 'next ✓');
  await fs.appendFile(file, 'third\nfourth\npartial');
  assert.equal(await trace.read(), 'fourth');
});

test('trace tails reset after replacement, truncation, and deletion', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-trace-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  const file = path.join(root, 'trace.log');
  const trace = new RunTrace(root);
  await fs.writeFile(file, 'old long line\nuncommitted');
  assert.equal(await trace.read(), 'old long line');
  await fs.writeFile(file, 'new\n');
  assert.equal(await trace.read(), 'new');
  const replacement = path.join(root, 'replacement');
  await fs.writeFile(replacement, 'replacement\n');
  await fs.rename(replacement, file);
  assert.equal(await trace.read(), 'replacement');
  await fs.rm(file);
  assert.equal(await trace.read(), undefined);
});

test('trace reads discard bounded-tail fragments and oversized unfinished lines', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-trace-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  const file = path.join(root, 'trace.log');
  const trace = new RunTrace(root);
  await fs.writeFile(file, `${'x'.repeat(1024 * 1024)}\nlatest\n`);
  assert.equal(await trace.read(), 'latest');
  await fs.appendFile(file, `${'y'.repeat(32 * 1024)}\ncaught up\n`);
  assert.equal(await trace.read(), 'caught up');
  await fs.appendFile(file, 'z'.repeat(16 * 1024));
  assert.equal(await trace.read(), 'caught up');
  await fs.appendFile(file, 'not a whole line\n');
  assert.equal(await trace.read(), 'caught up');
  await fs.appendFile(file, 'whole line\n');
  assert.equal(await trace.read(), 'whole line');
});

test('legacy regular traces take precedence and symlinks are never read', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-trace-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  const current = path.join(output, 'trace.log');
  const legacy = path.join(output, 'trace');
  const trace = new RunTrace(output);
  await fs.writeFile(current, 'current\n');
  await fs.writeFile(legacy, 'legacy\n');
  assert.equal(await trace.read(), 'legacy');
  await fs.rm(legacy);
  await fs.symlink(current, legacy);
  assert.equal(await trace.read(), 'current');
  await fs.rm(current);
  await fs.symlink(legacy, current);
  assert.equal(await trace.read(), undefined);
  const link = path.join(root, 'linked-output');
  await fs.symlink(output, link, 'junction');
  assert.equal(await new RunTrace(link).read(), undefined);
});
