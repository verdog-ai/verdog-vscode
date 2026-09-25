/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  highlightedTerminationRegion,
  edgeTerminationStatus,
  terminationFor,
  terminationRevision,
  type DefinitionTermination,
  type TerminationReport,
} from './termination';

const definition: DefinitionTermination = {
  status: 'not_certified',
  local_status: 'not_certified',
  reason: 'Residual cycles remain.',
  memory_states: 4,
  rules: 5,
  dependencies: [],
  edges: {
    forward: 'remaining',
    back: 'remaining',
    parallel: 'cleared',
    detached: 'unreachable',
  },
  regions: [
    {
      id: '0',
      nodes: ['first', 'second'],
      edges: ['forward', 'back', 'parallel'],
      witnesses: [],
      cycle: [
        {node: 'first', values: ['n>0'], edge: 'forward'},
        {node: 'second', values: ['n>0'], edge: 'back'},
      ],
    },
  ],
};
const report: TerminationReport = {
  projects: {'': 'root', child: 'pin'},
  definitions: {main: definition},
};

test('scope status never substitutes another definition or a stale result', () => {
  assert.deepEqual(terminationFor({status: 'checking'}, 'main'), {
    status: 'checking',
  });
  assert.equal(terminationFor(undefined, 'main').status, 'unavailable');
  assert.equal(
    terminationFor({status: 'ready', report}, 'absent').status,
    'unavailable',
  );
  const state = terminationFor({status: 'ready', report}, 'main');
  assert.equal(state.status, 'ready');
  if (state.status === 'ready') {
    assert.equal(state.definition, definition);
  }
});

test('highlights retain complete regions including parallel edges and expire on any owner revision', () => {
  const highlight = {
    scope: 'main',
    region: '0',
    revision: terminationRevision(report),
  };
  assert.deepEqual(
    highlightedTerminationRegion({status: 'ready', report}, 'main', highlight),
    definition.regions[0],
  );
  assert.equal(
    highlightedTerminationRegion({status: 'checking'}, 'main', highlight),
    undefined,
  );
  assert.equal(
    highlightedTerminationRegion({status: 'ready', report}, 'other', highlight),
    undefined,
  );
  assert.equal(
    highlightedTerminationRegion({status: 'ready', report}, 'main', {
      ...highlight,
      region: null,
    }),
    undefined,
  );
  const modified = {
    ...report,
    projects: {...report.projects, child: 'edited-without-repinning'},
  };
  assert.equal(
    highlightedTerminationRegion(
      {status: 'ready', report: modified},
      'main',
      highlight,
    ),
    undefined,
  );
  const reordered = {...report, projects: {child: 'pin', '': 'root'}};
  assert.equal(terminationRevision(report), terminationRevision(reordered));
});

test('edge badges use local analysis and never infer cleared edges from missing or unavailable results', () => {
  const ready = terminationFor({status: 'ready', report}, 'main');
  assert.equal(edgeTerminationStatus(ready, 'forward'), 'remaining');
  assert.equal(edgeTerminationStatus(ready, 'parallel'), 'cleared');
  assert.equal(edgeTerminationStatus(ready, 'detached'), 'unreachable');
  assert.equal(edgeTerminationStatus(ready, 'missing'), 'unavailable');
  assert.equal(
    edgeTerminationStatus({status: 'checking'}, 'parallel'),
    'checking',
  );
  assert.equal(
    edgeTerminationStatus(
      {status: 'unavailable', reason: 'deadline'},
      'parallel',
    ),
    'unavailable',
  );
  assert.equal(edgeTerminationStatus(undefined, 'parallel'), 'unavailable');
  assert.ok(ready.status === 'ready');
  assert.equal(
    edgeTerminationStatus(
      {...ready, definition: {...definition, local_status: 'unavailable'}},
      'parallel',
    ),
    'unavailable',
  );
  assert.equal(
    edgeTerminationStatus(
      {...ready, definition: {...definition, status: 'unavailable'}},
      'parallel',
    ),
    'cleared',
    'an unavailable child does not discard completed local edge analysis',
  );
});
