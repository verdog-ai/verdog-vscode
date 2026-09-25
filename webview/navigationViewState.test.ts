/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/// <reference types="node" />

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {NavigationViews} from './navigationViewState';

test('route presentation restores disclosures, scroll and row focus without moving the viewport', () => {
  const views = new NavigationViews();
  const saved = views.at('profiles');
  saved.scrollTop = 240;
  saved.focus = 'profile:generator';
  saved.disclosures.set('profiles', false);
  saved.disclosures.set('references', true);
  const details = [
    {dataset: {disclosure: 'profiles'}, open: true},
    {dataset: {disclosure: 'references'}, open: false},
    {dataset: {disclosure: 'new-group'}, open: true},
  ];
  let focused: string | undefined;
  let visible = true;
  const row = {
    dataset: {navigationFocus: 'profile:generator'},
    getClientRects: () => (visible ? [{}] : []),
    focus: (options: FocusOptions) => {
      assert.equal(options.preventScroll, true);
      focused = 'row';
    },
  };
  const main = {
    scrollTop: 0,
    querySelectorAll: (selector: string) =>
      selector.startsWith('details') ? details : [row],
    focus: () => {
      focused = 'main';
    },
  } as unknown as HTMLElement;
  views.restore('profiles', main);
  assert.equal(main.scrollTop, 240);
  assert.deepEqual(
    details.map(({open}) => open),
    [false, true, true],
  );
  assert.equal(focused, 'row');
  visible = false;
  views.restore('profiles', main);
  assert.equal(
    focused,
    'main',
    'a row hidden inside a collapsed branch cannot take focus',
  );
  views.restore('new-page', main);
  assert.equal(main.scrollTop, 0);
  assert.equal(focused, 'main');
  assert.strictEqual(views.at('profiles'), saved);
});

test('presentation caches keep retained history only, including repeated routes', () => {
  const views = new NavigationViews();
  const kept = views.at('overview');
  const dropped = views.at('discarded-forward-branch');
  views.retain(['overview', 'node', 'overview']);
  assert.strictEqual(views.at('overview'), kept);
  assert.notStrictEqual(views.at('discarded-forward-branch'), dropped);
});

test('live analysis refreshes disclosures without changing focus or scroll', () => {
  const views = new NavigationViews();
  views.at('status').disclosures.set('termination/region:0', true);
  const details = {dataset: {disclosure: 'termination/region:0'}, open: false};
  const main = {
    scrollTop: 120,
    querySelectorAll: () => [details],
    focus: () => assert.fail('background updates must not move focus'),
  } as unknown as HTMLElement;
  views.restoreDisclosures('status', main);
  assert.equal(details.open, true);
  assert.equal(main.scrollTop, 120);
});
