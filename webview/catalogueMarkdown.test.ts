/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {demoteDocumentationHeadings} from './catalogueMarkdown';

test('README headings sit below the catalogue record title', () => {
  const tokens = [{tag: 'h1'}, {tag: 'p'}, {tag: 'h5'}, {tag: 'h6'}];
  demoteDocumentationHeadings(tokens);
  assert.deepEqual(tokens, [{tag: 'h2'}, {tag: 'p'}, {tag: 'h6'}, {tag: 'h6'}]);
});
