/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  isCanvasToHost,
  isCatalogueToHost,
  isNavigationBrowserToHost,
  isRemovalReviewToHost,
} from './protocolMessages';

test('webview boundaries reject malformed transport fields before host actions', () => {
  const session = {
    kind: 'set-session-persistence',
    subroutine: 'main',
    session: 'history',
    persistent: false,
  };
  const configuration = {
    kind: 'set-profile-configuration',
    subroutine: 'main',
    profile: 'agent',
    provider: 'codex',
    options: {model: null, reasoning_effort: null, extra_args: []},
  };
  assert.equal(isCanvasToHost(session), true);
  assert.equal(isCanvasToHost(configuration), true);
  for (const value of [
    null,
    [],
    {},
    {...session, persistent: 'false'},
    {...configuration, provider: 'unknown'},
    {...configuration, options: {extra_args: 'arguments'}},
    {kind: 'cancel-navigation', navigationVersion: NaN},
    {kind: 'browse', page: null, target: {scope: 'main'}},
    {kind: 'shown', subroutine: 'main', workflow: {id: 'run'}},
  ]) {
    assert.equal(isCanvasToHost(value), false);
  }
  assert.equal(
    isCanvasToHost({
      kind: 'browse',
      page: {category: 'profiles'},
      target: {scope: 'main'},
    }),
    true,
  );
  assert.equal(
    isCatalogueToHost({kind: 'search', query: '', visibility: 'all'}),
    true,
  );
  assert.equal(
    isCatalogueToHost({kind: 'search', query: 1, visibility: 'all'}),
    false,
  );
  assert.equal(
    isCatalogueToHost({kind: 'search', query: '', visibility: 'secret'}),
    false,
  );
  const property = {
    kind: 'property',
    requestId: 1,
    route: 'entity',
    edit: {kind: 'session-persistence', persistent: false},
  };
  assert.equal(isNavigationBrowserToHost(property), true);
  assert.equal(
    isNavigationBrowserToHost({
      ...property,
      edit: {kind: 'session-persistence', persistent: 'false'},
    }),
    false,
  );
  assert.equal(isRemovalReviewToHost({kind: 'open', index: 0}), true);
  assert.equal(isRemovalReviewToHost({kind: 'open', index: -1}), false);
});
