/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  catalogueImportReceiptMatches,
  decodeCatalogueImportReceipt,
  type ReviewedCatalogueImport,
} from './catalogueReceipt';

const reviewed: ReviewedCatalogueImport = {
  alias: 'local.tools',
  commit: 'a'.repeat(40),
  into: 'main__review',
  package: 'ada.tools',
  repository: 'ada/tools',
  workflow_id: 'tools__main',
};

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    alias: reviewed.alias,
    binding: 'main__review__main',
    commit: reviewed.commit,
    generated_status: 0,
    package: reviewed.package,
    repository: reviewed.repository,
    status: 'imported',
    target: 'external/local/tools',
    workflow_id: reviewed.workflow_id,
    ...overrides,
  });
}

test('an import receipt agrees with the exact reviewed release and its derived paths', () => {
  const receipt = decodeCatalogueImportReceipt(envelope());
  assert.ok(receipt !== undefined);
  assert.equal(catalogueImportReceiptMatches(receipt, reviewed), true);
  const collision = decodeCatalogueImportReceipt(
    envelope({binding: 'main__review__main_27'}),
  );
  assert.ok(collision !== undefined);
  assert.equal(catalogueImportReceiptMatches(collision, reviewed), true);
});

test('partial or non-matching import receipts never authorize a success claim', () => {
  assert.equal(
    decodeCatalogueImportReceipt(envelope({binding: undefined})),
    undefined,
  );
  assert.equal(
    decodeCatalogueImportReceipt(envelope({generated_status: -1})),
    undefined,
  );
  for (const overrides of [
    {alias: 'other.tools'},
    {binding: 'other__main'},
    {binding: 'main__review__other'},
    {commit: 'b'.repeat(40)},
    {package: 'other.tools'},
    {repository: 'ada/other'},
    {target: 'external/elsewhere'},
    {workflow_id: 'other'},
  ]) {
    const receipt = decodeCatalogueImportReceipt(envelope(overrides));
    assert.ok(receipt !== undefined);
    assert.equal(catalogueImportReceiptMatches(receipt, reviewed), false);
  }
});
