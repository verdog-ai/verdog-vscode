/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  catalogueSyncPaths,
  decodeCatalogueSyncReceipt,
} from './catalogueSyncReceipt';

const checkout = '/cache/exact-release';
const workflow = 'main__review';

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    environment: '/cache/exact-release/.verdog/environments/main__review',
    interpreter:
      '/cache/exact-release/.verdog/environments/main__review/bin/python',
    only_binary: true,
    requirements: ['alpha==1'],
    status: 'ready',
    workflow_id: workflow,
    ...overrides,
  });
}

test('a wheel-only sync receipt is bound to the selected POSIX checkout and workflow', () => {
  assert.deepEqual(catalogueSyncPaths(checkout, workflow, 'linux'), {
    environment: '/cache/exact-release/.verdog/environments/main__review',
    interpreter:
      '/cache/exact-release/.verdog/environments/main__review/bin/python',
  });
  assert.deepEqual(
    decodeCatalogueSyncReceipt(receipt(), {
      checkout,
      platform: 'linux',
      workflow,
    }),
    {
      environment: '/cache/exact-release/.verdog/environments/main__review',
      interpreter:
        '/cache/exact-release/.verdog/environments/main__review/bin/python',
      only_binary: true,
      requirements: ['alpha==1'],
      workflow_id: workflow,
    },
  );
});

test('Windows inspection accepts only its selected Scripts interpreter', () => {
  const windowsCheckout = 'C:\\cache\\exact-release';
  const paths = catalogueSyncPaths(windowsCheckout, workflow, 'win32');
  assert.deepEqual(paths, {
    environment:
      'C:\\cache\\exact-release\\.verdog\\environments\\main__review',
    interpreter:
      'C:\\cache\\exact-release\\.verdog\\environments\\main__review\\Scripts\\python.exe',
  });
  assert.ok(
    decodeCatalogueSyncReceipt(
      JSON.stringify({
        ...paths,
        only_binary: true,
        requirements: [],
        status: 'ready',
        workflow_id: workflow,
      }),
      {checkout: windowsCheckout, platform: 'win32', workflow},
    ) !== undefined,
  );
});

test('mismatched, borrowed, non-wheel-only and partial sync receipts stay incomplete', () => {
  for (const overrides of [
    {workflow_id: 'other'},
    {only_binary: false},
    {environment: '/tmp/borrowed/.venv'},
    {interpreter: '/tmp/borrowed/.venv/bin/python'},
    {
      interpreter:
        '/cache/exact-release/.verdog/environments/main__review/Scripts/python.exe',
    },
    {interpreter: './.verdog/environments/main__review/bin/python'},
    {requirements: undefined},
  ]) {
    assert.equal(
      decodeCatalogueSyncReceipt(receipt(overrides), {
        checkout,
        platform: 'linux',
        workflow,
      }),
      undefined,
    );
  }
});
