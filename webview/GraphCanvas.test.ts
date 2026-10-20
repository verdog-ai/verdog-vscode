/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/// <reference types="node" />

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {JSDOM} from 'jsdom';

import type {NodeKind} from '../model/project';
import {graphvizSource} from './graphviz';
import type {SubroutineGraph} from './subroutines';

const dom = new JSDOM('<!doctype html><div id="canvas"></div>');
Object.assign(globalThis, {
  document: dom.window.document,
  DOMParser: dom.window.DOMParser,
  window: dom.window,
});
// jsdom has no SVG geometry; the decorations only need plausible numbers.
Object.assign(dom.window.SVGElement.prototype, {
  getBBox: () => ({x: 0, y: 0, width: 10, height: 10}),
  getPointAtLength: () => ({x: 0, y: 0}),
  getTotalLength: () => 10,
});

function graph(id: string, chain: string[]): SubroutineGraph {
  const node = (nodeId: string, kind: NodeKind = 'python') => ({
    data: {kind, label: nodeId},
    id: nodeId,
  });
  return {
    edges: chain.slice(1).map((target, index) => ({
      id: `${chain[index]}__${target}`,
      source: chain[index],
      target,
    })),
    id,
    nodes: [
      node('enter', 'enter'),
      node('exit', 'exit'),
      ...chain.slice(1, -1).map(nodeId => node(nodeId)),
    ],
    scope: {kind: 'subroutine', ownerGraph: id},
  };
}

test('switching graphs that share node and edge ids draws the whole new graph', async () => {
  // GraphCanvas reads `document` when it is evaluated, so it loads after the DOM exists.
  const {graphviz} = await import('d3-graphviz');
  const {decorate, undecorate} = await import('./GraphCanvas');
  const container = dom.window.document.getElementById('canvas')!;
  const renderer = graphviz(container, {useWorker: false, zoom: false})
    .keyMode('id')
    .fade(false)
    .tweenPaths(false)
    .tweenShapes(false)
    .growEnteringEdges(false);
  const draw = (shown: SubroutineGraph) =>
    new Promise<void>((resolve, reject) => {
      undecorate(container);
      renderer.onerror(error => reject(new Error(String(error))));
      renderer.dot(graphvizSource(shown).dot, function layoutReady() {
        this.render(() => {
          decorate(
            container,
            shown,
            undefined,
            undefined,
            true,
            undefined,
            undefined,
          );
          resolve();
        });
      });
    });
  const ids = () =>
    [...container.querySelectorAll('g.node, g.edge')].map(({id}) => id).sort();

  await draw(
    graph('main', ['enter', 'prepare', 'implementer', 'finish', 'exit']),
  );
  const scout = graph('scout', [
    'enter',
    'prepare',
    'generate',
    'select',
    'finish',
    'exit',
  ]);
  await draw(scout);

  assert.deepEqual(
    ids(),
    [
      ...scout.edges.map(({id}) => `verdog-edge-${id}`),
      ...scout.nodes.map(({id}) => `verdog-node-${id}`),
    ].sort(),
  );
  renderer.destroy();
});
