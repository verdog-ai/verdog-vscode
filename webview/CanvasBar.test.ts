/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

import {additionsFor, CanvasBar} from './CanvasBar';
import {edgeId, nodeId} from '../model/identifiers';

test('a workflow boundary offers only concrete resource additions', () => {
  assert.deepEqual(
    additionsFor('workflow').map(([kind]) => kind),
    ['add-profile', 'add-session'],
  );
});

test('edge constraints are not graph toolbar actions', () => {
  const html = renderToStaticMarkup(
    createElement(CanvasBar, {
      canGoBack: false,
      canGoForward: false,
      onAction: () => undefined,
      onBack: () => undefined,
      onForward: () => undefined,
      onPanel: () => undefined,
      onTidy: () => undefined,
      panel: undefined,
      scope: 'subroutine',
      selected: undefined,
      writable: true,
    }),
  );
  assert.doesNotMatch(html, />constrain<\/button>/);
});

test('selected entities expose connection actions only when writable', () => {
  const base = {
    canGoBack: false,
    canGoForward: false,
    onAction: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onPanel: () => undefined,
    onTidy: () => undefined,
    panel: undefined,
    scope: 'subroutine' as const,
    writable: true,
  };
  const node = renderToStaticMarkup(
    createElement(CanvasBar, {
      ...base,
      selected: {entity: 'nodes', id: nodeId('enter')},
      canConnect: true,
    }),
  );
  assert.match(node, />Connect to…<\/button>/);
  const terminal = renderToStaticMarkup(
    createElement(CanvasBar, {
      ...base,
      selected: {entity: 'nodes', id: nodeId('exit')},
      canConnect: false,
    }),
  );
  assert.match(terminal, /<button disabled=""[^>]*>Connect to…<\/button>/);
  const edge = renderToStaticMarkup(
    createElement(CanvasBar, {
      ...base,
      selected: {entity: 'edges', id: edgeId('enter__exit')},
    }),
  );
  assert.match(edge, />Change source…<\/button>/);
  assert.match(edge, />Change target…<\/button>/);
  const readonly = renderToStaticMarkup(
    createElement(CanvasBar, {
      ...base,
      writable: false,
      selected: {entity: 'edges', id: edgeId('enter__exit')},
    }),
  );
  assert.doesNotMatch(readonly, /Change source|Change target|Connect to/);
});

test('termination uses the existing status slot without an extra toolbar block or legend', () => {
  const html = renderToStaticMarkup(
    createElement(CanvasBar, {
      canGoBack: false,
      canGoForward: false,
      onAction() {},
      onBack() {},
      onForward() {},
      onPanel() {},
      onTidy() {},
      panel: 'status',
      selected: undefined,
      writable: true,
      scope: 'subroutine',
      termination: {status: 'checking'},
    }),
  );
  assert.match(
    html,
    /<button aria-label="Structural termination: Checking. Show analysis." aria-pressed="true"/,
  );
  assert.match(html, /<\/button><\/span><\/fieldset><\/header>$/);
  assert.doesNotMatch(
    html,
    />status<\/button>|>Structural termination |edge-termination-legend/,
  );
});
