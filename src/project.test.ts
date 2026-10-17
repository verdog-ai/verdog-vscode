/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  defaultWorkflow,
  definitionIn,
  subroutinesIn,
  definitionIndex,
  definitionPath,
  resolveCall,
  SCHEMA_VERSION,
  visibleDefinitions,
  type CanonicalProject,
  type SubroutineDefinition,
} from '../model/project';

function graph(id: string): SubroutineDefinition {
  return {
    edges: [
      {
        conditions: [],
        effects: [],
        id: 'enter__exit',
        name: 'Pass through',
        source: 'enter',
        target: 'exit',
      },
    ],
    features: [],
    profile_parameters: [],
    profiles: [],
    session_parameters: [],
    sessions: [],
    id,
    name: id,
    nodes: [
      {id: 'enter', kind: 'enter', name: 'Enter', operation: {}},
      {id: 'exit', kind: 'exit', name: 'Exit', operation: {}},
      {id: 'failure', kind: 'failure', name: 'Failure', operation: {}},
    ],
    ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
    subroutines: [],
    workflows: [],
  };
}

function project(): CanonicalProject {
  const root = graph('main');
  const worker = graph('worker');
  const nested = graph('nested');
  worker.subroutines.push(nested, graph('normalize'));
  root.subroutines.push(worker, graph('normalize'));
  root.workflows.push(
    {
      subroutine: 'main__worker',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
    {
      external: {alias: 'reviewer.pin', workflow: 'review'},
      id: 'reviewer',
      name: 'Reviewer',
    },
  );
  return {
    editor: {layouts: {}},
    externals: [],
    generated_from: '0'.repeat(64),
    package: 'demo.project',
    schema_version: SCHEMA_VERSION,
    sources: [],
    subroutines: [root],
    workflows: [rootWorkflow('main')],
  };
}

function rootWorkflow(subroutine: string) {
  return {
    subroutine,
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  };
}

test('the central index separates workflow envelopes from subroutine graphs', () => {
  const index = definitionIndex(project());
  assert.deepEqual(
    [...index.subroutines.keys()],
    [
      'main',
      'main__worker',
      'main__worker__nested',
      'main__worker__normalize',
      'main__normalize',
    ],
  );
  assert.equal(
    definitionIn(project(), 'workflow', 'main__worker')?.target,
    'main__worker',
  );
  assert.equal(
    definitionIn(project(), 'subroutine', 'main__worker')?.target,
    'main__worker',
  );
  assert.equal(
    definitionIn(project(), 'workflow', 'main__reviewer')?.external?.alias,
    'reviewer.pin',
  );
  assert.deepEqual([...index.duplicates], []);
  assert.deepEqual(
    subroutinesIn(project()).map(({id}) => id),
    [
      'main',
      'main__worker',
      'main__worker__nested',
      'main__worker__normalize',
      'main__normalize',
    ],
  );
});

test('the index records ambiguity without replacing the first declaration', () => {
  const value = project();
  const root = value.subroutines[0];
  const first = root.subroutines.find(({id}) => id === 'normalize')!;
  root.subroutines.push(graph('normalize'));
  const index = definitionIndex(value);
  assert.deepEqual([...index.duplicates], ['subroutine:main__normalize']);
  assert.equal(index.subroutines.get('main__normalize'), first);
  assert.equal(
    index.definitions.get('subroutine:main__normalize')?.subroutine,
    first,
  );
});

test('lexical visibility includes both kind-specific namespaces', () => {
  const visible = visibleDefinitions(project(), 'main__worker__nested').map(
    ({id, kind}) => `${kind}:${id}`,
  );
  assert.deepEqual(visible, [
    'subroutine:main__worker__nested',
    'subroutine:main__worker__normalize',
    'workflow:main__worker',
    'workflow:main__reviewer',
    'subroutine:main__worker',
    'subroutine:main__normalize',
    'workflow:main',
    'subroutine:main',
  ]);
  assert.equal(
    resolveCall(project(), 'main', {
      kind: 'workflow_call',
      operation: {target: 'main__worker'},
    })?.target,
    'main__worker',
  );
  assert.equal(
    resolveCall(project(), 'main__worker', {
      kind: 'subroutine_call',
      operation: {
        profile_arguments: {},
        session_arguments: {},
        target: 'main__worker',
      },
    })?.id,
    'main__worker',
    'a self-call resolves so recursion, rather than lookup, diagnoses it',
  );
});

test('source paths follow the lexical graph tree', () => {
  const value = project();
  assert.deepEqual(definitionPath(value, 'workflow', 'main'), [
    'workflows',
    'main',
  ]);
  assert.deepEqual(definitionPath(value, 'subroutine', 'main'), [
    'subroutines',
    'main',
  ]);
  assert.deepEqual(definitionPath(value, 'workflow', 'main__worker'), [
    'subroutines',
    'main',
    'workflows',
    'worker',
  ]);
  assert.deepEqual(
    definitionPath(value, 'subroutine', 'main__worker__nested'),
    ['subroutines', 'main', 'subroutines', 'worker', 'subroutines', 'nested'],
  );
});

test('root siblings see each other, but not what the other nests', () => {
  const value = project();
  const helper = graph('helper');
  helper.subroutines.push(graph('inner'));
  value.subroutines.push(helper);
  value.workflows.push(rootWorkflow('helper'));
  const fromMain = visibleDefinitions(value, 'main').map(
    ({id, kind}) => `${kind}:${id}`,
  );
  assert.ok(fromMain.includes('subroutine:helper'));
  assert.ok(fromMain.includes('workflow:helper'));
  assert.ok(!fromMain.includes('subroutine:helper__inner'));
  const fromInner = visibleDefinitions(value, 'helper__inner').map(
    ({id, kind}) => `${kind}:${id}`,
  );
  assert.ok(fromInner.includes('subroutine:main'));
  assert.ok(!fromInner.includes('subroutine:main__worker'));
  assert.deepEqual(definitionPath(value, 'workflow', 'helper'), [
    'workflows',
    'helper',
  ]);
  assert.deepEqual(
    visibleDefinitions(value, '', 'subroutine').map(({id}) => id),
    ['main', 'helper'],
  );
});

test('the default workflow is the only root one, else main, else none', () => {
  const value = project();
  assert.equal(defaultWorkflow(definitionIndex(value)), 'main');
  value.subroutines.push(graph('alpha'), graph('beta'));
  value.workflows.push(rootWorkflow('alpha'));
  assert.equal(defaultWorkflow(definitionIndex(value)), 'main');
  value.workflows = [rootWorkflow('alpha')];
  assert.equal(defaultWorkflow(definitionIndex(value)), 'alpha');
  value.workflows.push(rootWorkflow('beta'));
  assert.equal(defaultWorkflow(definitionIndex(value)), undefined);
  value.workflows = [];
  assert.equal(defaultWorkflow(definitionIndex(value)), undefined);
  value.subroutines = [];
  assert.equal(definitionIndex(value).definitions.size, 0);
});
