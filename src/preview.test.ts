/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview A preview is a clone you may not write to.
 *
 * These tests cover the decisions that are invisible until they are wrong: where a checkout
 * goes, and what settings make it read-only. The graph itself is deliberately untested here --
 * a preview draws through `readClone` like any project, so `clone.test.ts` covers it. That is
 * the point of the change: there is no second representation left to have its own tests.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import {test} from 'node:test';

import {
  MARKER,
  type Preview,
  checkoutRoot,
  interpreterIn,
  settings,
} from './preview';

const entry: Preview = {
  commit: 'e671824c56a697375aea59922b3cae83529eefc5',
  origin: '/home/dev/my-project',
  repository: 'verdog-ai/demo1',
  workflow: 'main',
};

test('two releases of one workflow check out to different places', () => {
  // Two windows must be able to preview two commits at once. Keying on the repository alone
  // meant a second checkout would rip the tree out from under the first window.
  const first = checkoutRoot(
    '/storage',
    entry.repository,
    entry.commit,
    entry.workflow,
  );
  const second = checkoutRoot(
    '/storage',
    entry.repository,
    'b'.repeat(40),
    entry.workflow,
  );
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join('/storage', 'preview'));
  assert.match(path.basename(first), /^[0-9a-f]{64}$/);
  // The same commit twice is the same directory, which is what makes reuse safe: a commit is
  // immutable, so there is no invalidation rule to get wrong.
  assert.equal(
    checkoutRoot('/storage', entry.repository, entry.commit, entry.workflow),
    first,
  );
  assert.notEqual(
    checkoutRoot('/storage', entry.repository, entry.commit, 'secondary'),
    first,
  );
  const hostile = checkoutRoot(
    '/storage',
    '../outside',
    entry.commit,
    '../../workflow',
  );
  assert.equal(path.dirname(hostile), path.join('/storage', 'preview'));
});

test('the marker lives inside .git, so it is neither committed nor locked', () => {
  // `.git` is where the CLI already keeps per-clone state (`local.py` writes `.git/verdog.json`):
  // no `.gitignore` entry needed, invisible in the Explorer, and the chmod skips it so a
  // preview window can still read its own mode after the tree is locked.
  assert.match(MARKER, /^\.git[\\/]/);
});

test('the settings make the checkout read-only and silent, and never speak for it', () => {
  const value = JSON.parse(
    settings(entry, '/home/dev/my-project/.venv/bin/python'),
  ) as Record<string, unknown>;
  // Said before the keystroke, not at save time.
  assert.deepEqual(value['files.readonlyInclude'], {'**': true});
  // Defaults to false, so chmod alone would mark nothing in the editor.
  assert.equal(value['files.readonlyFromPermissions'], true);
  // The checkout has `origin` on the author's repository at a detached HEAD. For a repository
  // the reader can write to, the SCM view is one click from pushing to it.
  assert.equal(value['git.enabled'], false);
  // Their manifest is strict with ~19 rules as errors, checked against their environment;
  // reporting that as the reader's own would read as "this author publishes broken code".
  // `off` and not `ignore`, because `off` still reports unresolved imports -- which is the one
  // diagnostic a reader needs when a declared dependency has not been installed.
  assert.equal(value['python.analysis.typeCheckingMode'], 'off');
  assert.equal('python.analysis.ignore' in value, false);
  assert.equal(
    value['python.defaultInterpreterPath'],
    '/home/dev/my-project/.venv/bin/python',
  );
  assert.match(String(value['window.title']), /verdog-ai\/demo1@e671824c56a6/);
});

test('with no interpreter to borrow, the key is absent rather than empty', () => {
  // An empty string would point Pylance at nothing and be harder to diagnose than silence.
  // The previewed package still resolves: its own pyproject carries extraPaths.
  const value = JSON.parse(settings(entry, undefined)) as Record<
    string,
    unknown
  >;
  assert.equal('python.defaultInterpreterPath' in value, false);
  assert.deepEqual(value['files.readonlyInclude'], {'**': true});
});

test('only the selected preview workflow environment is considered, on either platform', () => {
  assert.deepEqual(interpreterIn('/home/dev/my-project', 'main'), [
    '/home/dev/my-project/.verdog/environments/main/bin/python',
    '/home/dev/my-project/.verdog/environments/main/Scripts/python.exe',
  ]);
  // Metadata browsing has no selected checkout or interpreter.
  assert.deepEqual(interpreterIn(undefined), []);
});

test('the extension remains available for safe inspection in Restricted Mode', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    capabilities?: {
      untrustedWorkspaces?: {
        description?: string;
        restrictedConfigurations?: string[];
        supported?: boolean | 'limited';
      };
    };
  };
  const capability = manifest.capabilities?.untrustedWorkspaces;

  assert.equal(capability?.supported, 'limited');
  assert.deepEqual(capability?.restrictedConfigurations, ['verdog.command']);
  assert.match(
    capability?.description ?? '',
    /read-only catalogue inspection/i,
  );
});
