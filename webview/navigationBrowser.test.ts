/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/// <reference types="node" />

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

import type {NavigationEntry, NavigationPage} from '../model/protocol';
import {Browser} from './navigationBrowser';
import {EntityTree} from './EntityTree';

const entry: NavigationEntry = {
  children: [
    {
      children: [],
      entity: 'nodes',
      id: 'propose',
      key: 'node:propose',
      meta: [],
      scope: [],
    },
  ],
  entity: 'profiles',
  id: 'generator',
  key: 'profile:generator',
  meta: [],
  scope: ['main'],
};
function render(page: NavigationPage): string {
  return renderToStaticMarkup(
    createElement(Browser, {
      canGoBack: true,
      canGoForward: false,
      edit() {},
      host: {postMessage() {}},
      overview: {scope: 'main'},
      page,
      pending: false,
      retainedRoutes: ['current'],
      route: 'current',
    }),
  );
}

test('navigation exposes a scope breadcrumb and tree controls while references start collapsed', () => {
  const html = render({
    category: 'profiles',
    context: 'Subroutine main',
    entries: [entry],
    title: 'Profiles',
  });
  assert.match(html, /class="breadcrumb-link"[^>]*>Subroutine main<\/a>/);
  assert.match(html, />Expand all<\/button>/);
  assert.match(html, />Collapse all<\/button>/);
  assert.match(html, /<details class="references"[^>]*>/);
  assert.doesNotMatch(html, /<details class="references"[^>]*open/);
  assert.match(html, /data-navigation-focus="profile:generator"/);
  assert.match(html, /<details data-disclosure="[^"]*" open=""/);
});

test('entity IDs lead property-page headings, with the semantic kind kept separate', () => {
  const html = render({
    category: 'entity',
    title: 'Profile',
    kind: 'profile',
    id: 'generator',
    name: 'Generator',
    context: 'Workflow main',
    entity: 'profiles',
    entries: [],
    fields: [],
    documents: [],
    resources: [],
    idWritable: true,
    nameWritable: true,
    constraintsWritable: false,
    resourcesWritable: false,
    settingsWritable: true,
  });
  assert.match(html, /<p class="page-kind">Profile<\/p>/);
  assert.match(html, /<h1 class="page-title-id">generator<\/h1>/);
  assert.match(html, /aria-label="generator navigation"/);
});

test('shared entity grouping remains expanded for deletion reviews', () => {
  const html = renderToStaticMarkup(
    createElement(EntityTree<NavigationEntry>, {
      items: [entry],
      renderItem: (item: NavigationEntry) =>
        createElement('li', {key: item.key}, item.id),
    }),
  );
  assert.equal(html.match(/<details /g)?.length, 2);
  assert.equal(html.match(/open=""/g)?.length, 2);
});
