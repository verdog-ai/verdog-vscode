/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  SUBMODULE_SYNC_ARGUMENTS,
  SUBMODULE_UPDATE_ARGUMENTS,
} from './checkoutCommands';

test('inspection synchronizes exact nested submodule URLs before fetching pinned revisions', () => {
  assert.deepEqual(SUBMODULE_SYNC_ARGUMENTS, [
    'submodule',
    'sync',
    '--recursive',
  ]);
  assert.deepEqual(SUBMODULE_UPDATE_ARGUMENTS, [
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--depth',
    '1',
  ]);
});
