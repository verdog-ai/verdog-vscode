/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {edgeDomId, graphvizSource, nodeDomId} from '../webview/graphviz';
import type {NodeKind} from '../model/project';
import type {SubroutineEdge, SubroutineNode} from '../webview/subroutines';

function node(
  id: string,
  label = id,
  definition = false,
  kind: NodeKind = 'python',
): SubroutineNode {
  return {
    data: {
      ...(definition ? {definition: {graph: 'child'}} : {}),
      kind,
      label,
    },
    id,
  };
}

function edge(id: string, source: string, target: string): SubroutineEdge {
  return {
    id,
    source,
    target,
  };
}

test('DOT quotes identifiers and labels in one place', () => {
  const id = 'node "one"\\tail';
  const {dot} = graphvizSource({
    edges: [edge('edge "one"\\tail', id, id)],
    nodes: [node(id, 'say "hi"\\then\t\u0001next', true)],
  });

  assert.ok(dot.includes(String.raw`"node \"one\"\\tail"`));
  assert.ok(
    dot.includes(String.raw`label="PYTHON\nsay \"hi\"\\then\t\u0001next  ↗"`),
  );
  assert.ok(dot.includes(`id="${nodeDomId(id)}"`));
  assert.ok(dot.includes(`id="${edgeDomId('edge "one"\\tail')}"`));
});

test('DOT owns node placement and spline routing', () => {
  const nodes = [node('a/b', 'First', true), node('second')];
  const edges = [edge('a-to-b', 'a/b', 'second')];
  const automatic = graphvizSource({edges, nodes});

  assert.equal(automatic.engine, 'dot');
  assert.ok(automatic.dot.startsWith('digraph {'));
  assert.ok(automatic.dot.includes(`id="${nodeDomId('a/b')}"`));
  assert.ok(
    automatic.dot.includes(
      'bgcolor="transparent", rankdir="TB", ranksep=0.888889, nodesep=1.875, splines="spline", outputorder="edgesfirst"',
    ),
  );
  assert.ok(
    automatic.dot.includes(
      'fixedsize=false, width=3, height=1.1111111111111112',
    ),
  );
  assert.ok(automatic.dot.includes('fontsize=16'));
  assert.ok(automatic.dot.includes('gradientangle=270'));
  assert.ok(automatic.dot.includes('fillcolor="#302b16:#231f10"'));
  assert.ok(automatic.dot.includes('arrowsize=0.75'));
  assert.ok(!automatic.dot.includes('notranslate'));
  assert.ok(!automatic.dot.includes('pos='));
});

test('feature nodes are compact, indigo, and keep ordinary graph identities', () => {
  const id = 'update_status';
  const {dot} = graphvizSource({
    edges: [edge('update_exit', id, 'exit')],
    nodes: [node(id, 'Update status', false, 'feature'), node('exit')],
  });
  const feature = dot
    .split('\n')
    .find(line => line.includes(`id="${nodeDomId(id)}"`))!;

  assert.ok(feature.includes(String.raw`label="FEATURE\nUpdate status"`));
  assert.ok(feature.includes('color="#88a2e8"'));
  assert.ok(feature.includes('fillcolor="#1d2842:#151d31"'));
  assert.ok(feature.includes('width=1.75, height=0.625, fontsize=14'));
  assert.ok(feature.includes(`id="${nodeDomId(id)}"`));
  assert.ok(dot.includes(`id="${edgeDomId('update_exit')}"`));
});

test('non-strict DOT retains parallel edges and self-loops without edge labels', () => {
  const {dot} = graphvizSource({
    nodes: [node('a'), node('b')],
    edges: [
      edge('first', 'a', 'b'),
      edge('second', 'a', 'b'),
      edge('loop', 'a', 'a'),
    ],
  });
  const edgeLines = dot.split('\n').filter(line => line.includes(' -> '));

  assert.ok(!dot.startsWith('strict'));
  assert.equal(edgeLines.length, 3);
  assert.ok(
    edgeLines.some(line => line.includes(`id="${edgeDomId('first')}"`)),
  );
  assert.ok(
    edgeLines.some(line => line.includes(`id="${edgeDomId('second')}"`)),
  );
  assert.ok(edgeLines.some(line => line.includes('"a" -> "a"')));
  assert.ok(edgeLines.every(line => !line.includes('label=')));
});

test('reciprocal edges are left entirely to DOT', () => {
  const nodes = [node('left'), node('right')];
  const edges = [edge('out', 'left', 'right'), edge('back', 'right', 'left')];
  const automatic = graphvizSource({edges, nodes}).dot;
  assert.ok(automatic.includes('splines="spline"'));
  assert.ok(automatic.includes('"left" -> "right"'));
  assert.ok(automatic.includes('"right" -> "left"'));
  assert.ok(!automatic.includes('"left":'));
  assert.ok(!automatic.includes('"right":'));
});
