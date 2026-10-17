/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {testProject} from './fixtures';
import {
  graphHash,
  isStaleGraph,
  legacyGraphHash,
  upgradeProject,
} from './graph';

// Shared with the compiler suite; each must stay byte-identical across both implementations.
const MAIN_ONLY = JSON.parse(
  '{"schema_version": 33, "package": "sample.flow", "generated_from": "0000000000000000000000000000000000000000000000000000000000000000", "workflows": [{"subroutine": "main", "profiles": [], "sessions": [], "profile_arguments": {}, "session_arguments": {}}], "externals": [], "sources": [], "editor": {"layouts": {}}, "extensions": {}, "subroutines": [{"id": "main", "name": "main", "ports": {"enter": "enter", "exit": "exit", "failure": "failure"}, "features": [], "profiles": [], "profile_parameters": [], "sessions": [], "session_parameters": [], "nodes": [{"id": "enter", "name": "enter", "kind": "enter", "operation": {}}, {"id": "exit", "name": "exit", "kind": "exit", "operation": {}}, {"id": "failure", "name": "failure", "kind": "failure", "operation": {}}], "edges": [{"id": "enter_exit", "name": "then", "source": "enter", "target": "exit", "conditions": [], "effects": []}], "workflows": [], "subroutines": []}]}',
) as Record<string, unknown>;

const TWO_ROOTS = JSON.parse(
  '{"schema_version": 33, "package": "sample.flow", "generated_from": "0000000000000000000000000000000000000000000000000000000000000000", "workflows": [{"subroutine": "alpha", "profiles": [], "sessions": [], "profile_arguments": {}, "session_arguments": {}}, {"subroutine": "beta", "profiles": [], "sessions": [], "profile_arguments": {}, "session_arguments": {}}], "externals": [], "sources": [{"path": "src/sample/flow/impl.py", "ownership": "user", "size": 0, "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}], "editor": {"layouts": {}}, "extensions": {}, "subroutines": [{"id": "alpha", "name": "Alpha", "ports": {"enter": "enter", "exit": "exit", "failure": "failure"}, "features": [], "profiles": [], "profile_parameters": [], "sessions": [], "session_parameters": [], "nodes": [{"id": "enter", "name": "enter", "kind": "enter", "operation": {}}, {"id": "exit", "name": "exit", "kind": "exit", "operation": {}}, {"id": "failure", "name": "failure", "kind": "failure", "operation": {}}, {"id": "call_beta", "name": "Call beta", "kind": "subroutine_call", "operation": {"target": "beta", "profile_arguments": {}, "session_arguments": {}}}], "edges": [{"id": "call_beta__exit", "name": "call_beta exit", "source": "call_beta", "target": "exit", "conditions": [], "effects": []}, {"id": "enter__call_beta", "name": "enter call_beta", "source": "enter", "target": "call_beta", "conditions": [], "effects": []}], "workflows": [], "subroutines": []}, {"id": "beta", "name": "Beta", "ports": {"enter": "enter", "exit": "exit", "failure": "failure"}, "features": [], "profiles": [], "profile_parameters": [], "sessions": [], "session_parameters": [], "nodes": [{"id": "enter", "name": "enter", "kind": "enter", "operation": {}}, {"id": "exit", "name": "exit", "kind": "exit", "operation": {}}, {"id": "failure", "name": "failure", "kind": "failure", "operation": {}}], "edges": [{"id": "enter_exit", "name": "then", "source": "enter", "target": "exit", "conditions": [], "effects": []}], "workflows": [], "subroutines": []}]}',
) as Record<string, unknown>;

/** A root `main` named with a non-ASCII word, plus paths ordered differently in UTF-16. */
function unicodeVector(): Record<string, unknown> {
  return {
    package: 'demo.flow',
    workflow: {
      subroutine: 'main',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
    subroutine: {
      id: 'main',
      name: 'München',
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      features: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      nodes: [
        {id: 'enter', name: 'enter', kind: 'enter', operation: {}},
        {id: 'exit', name: 'exit', kind: 'exit', operation: {}},
        {id: 'failure', name: 'failure', kind: 'failure', operation: {}},
      ],
      edges: [
        {
          id: 'enter__exit',
          name: 'then',
          source: 'enter',
          target: 'exit',
          conditions: [],
          effects: [],
        },
      ],
      workflows: [],
      subroutines: [],
    },
    externals: [],
    sources: [
      {ownership: 'user', path: 'src/β.py', sha256: 'a'.repeat(64)},
      {ownership: 'user', path: 'src/\u{10000}.py', sha256: 'b'.repeat(64)},
      {ownership: 'user', path: 'src/\uE000.py', sha256: 'c'.repeat(64)},
    ],
  };
}

test("this hash agrees with the compiler's canonical test vectors", () => {
  assert.equal(
    graphHash(MAIN_ONLY),
    '9c7e3c7d8cfac79b1f42840612221c0d9459fe336c805c312557d2f3a266933e',
  );
  assert.equal(
    graphHash(TWO_ROOTS),
    'c5090347cde2d1700c52106b1a8721cc853540c38d13eac8f9e8840e25960417',
  );
  const legacy = unicodeVector();
  assert.equal(
    legacyGraphHash(legacy),
    '91723b6bbe2ffb699d6514b964bb1380b449f620b4ba009cd497871403ec42f8',
  );
  const {workflow, subroutine, ...rest} = legacy;
  assert.equal(
    graphHash({...rest, workflows: [workflow], subroutines: [subroutine]}),
    '1a0207ef2f5801b152b1ab223362e3b2ffab01e49f18e2c9961d461fc611d123',
  );
});

test('a fresh v32 project is read as a fresh v33 project', () => {
  const legacy: Record<string, unknown> = {
    ...unicodeVector(),
    schema_version: 32,
    generated_from: legacyGraphHash(unicodeVector()),
  };
  const upgraded = upgradeProject(legacy);
  assert.equal(upgraded.schema_version, 33);
  assert.deepEqual(upgraded.workflows, [legacy.workflow]);
  assert.deepEqual(upgraded.subroutines, [legacy.subroutine]);
  assert.equal('workflow' in upgraded || 'subroutine' in upgraded, false);
  assert.equal(
    upgraded.generated_from,
    '1a0207ef2f5801b152b1ab223362e3b2ffab01e49f18e2c9961d461fc611d123',
  );
  assert.equal(isStaleGraph(upgraded), false);

  const pinned = upgradeProject(legacy, false);
  assert.equal(pinned.generated_from, legacy.generated_from);
  assert.deepEqual(pinned.subroutines, [legacy.subroutine]);
});

test('a stale v32 project stays stale after the upgrade', () => {
  const legacy: Record<string, unknown> = {
    ...unicodeVector(),
    schema_version: 32,
    generated_from: 'f'.repeat(64),
  };
  const upgraded = upgradeProject(legacy);
  assert.equal(upgraded.generated_from, 'f'.repeat(64));
  assert.equal(isStaleGraph(upgraded), true);
  const current = testProject();
  assert.equal(upgradeProject(current), current);
});

test('an edit to the graph moves the hash, and a move of a node does not', () => {
  const project = testProject();
  const before = graphHash(project);

  const moved = structuredClone(project);
  moved.editor = {layouts: {main: {enter: {x: 400, y: -30}}}};
  assert.equal(
    graphHash(moved),
    before,
    'layout must never change a generated byte',
  );

  const edited = structuredClone(project);
  (edited.workflows as Array<Record<string, unknown>>)[0].subroutine = 'other';
  assert.notEqual(graphHash(edited), before);
  edited.generated_from = before;
  assert.equal(isStaleGraph(edited), true);

  const retyped = structuredClone(project);
  const owned = (retyped.sources as Array<Record<string, unknown>>).find(
    entry => entry.ownership === 'user',
  )!;
  owned.sha256 = 'f'.repeat(64);
  assert.notEqual(graphHash(retyped), before);

  const regenerated = structuredClone(project);
  const produced = (regenerated.sources as Array<Record<string, unknown>>).find(
    entry => entry.ownership === 'generated',
  )!;
  produced.sha256 = 'e'.repeat(64);
  assert.equal(graphHash(regenerated), before);
});

test('key order in the file does not change the hash', () => {
  const project = testProject();
  const reordered = Object.fromEntries(Object.entries(project).reverse());
  assert.equal(graphHash(reordered), graphHash(project));
});

test('ID-keyed collection order matches the native maps', () => {
  const project = testProject();
  const root = (project.subroutines as Array<Record<string, unknown>>)[0];
  const child = structuredClone(
    (root.subroutines as Array<Record<string, unknown>>)[0],
  );
  child.id = 'audit';
  child.name = 'Audit';
  (root.subroutines as Array<Record<string, unknown>>).push(child);
  root.workflows = [
    {external: {alias: 'pin.z', workflow: 'main'}, id: 'z_remote', name: 'Z'},
    {external: {alias: 'pin.a', workflow: 'main'}, id: 'a_remote', name: 'A'},
  ];
  project.externals = [
    {
      alias: 'pin.z',
      commit: 'a'.repeat(40),
      name: 'z',
      owner: 'example',
      package: 'example.z',
      provider: 'github',
      repository_id: 2,
    },
    {
      alias: 'pin.a',
      commit: 'b'.repeat(40),
      name: 'a',
      owner: 'example',
      package: 'example.a',
      provider: 'github',
      repository_id: 1,
    },
  ];

  const reordered = structuredClone(project);
  (reordered.externals as unknown[]).reverse();
  const reverse = (raw: Record<string, unknown>): void => {
    for (const key of ['nodes', 'edges', 'workflows', 'subroutines'] as const) {
      (raw[key] as unknown[]).reverse();
    }
    for (const nested of raw.subroutines as Array<Record<string, unknown>>) {
      reverse(nested);
    }
  };
  reverse((reordered.subroutines as Array<Record<string, unknown>>)[0]);
  assert.equal(graphHash(reordered), graphHash(project));
});

test('ordered semantic collections remain ordered', () => {
  const project = testProject();
  const root = (project.subroutines as Array<Record<string, unknown>>)[0];
  (root.features as Array<Record<string, unknown>>).push({
    description: 'A second counter.',
    id: 'other',
    kind: 'integer',
    label: 'Other',
  });
  const edge = (root.edges as Array<Record<string, unknown>>)[1];
  edge.conditions = [
    {feature_id: 'remaining_iterations', observation: 'greater_zero'},
    {feature_id: 'other', observation: 'equal_zero'},
  ];
  edge.effects = [
    {feature_id: 'remaining_iterations', observation: 'decreases'},
    {feature_id: 'other', observation: 'increases'},
  ];

  for (const [owner, key] of [
    [root, 'features'],
    [edge, 'conditions'],
    [edge, 'effects'],
  ] as const) {
    const reordered = structuredClone(project);
    const clonedRoot = (
      reordered.subroutines as Array<Record<string, unknown>>
    )[0];
    const clonedEdge = (clonedRoot.edges as Array<Record<string, unknown>>)[1];
    const clonedOwner = owner === root ? clonedRoot : clonedEdge;
    (clonedOwner[key] as unknown[]).reverse();
    assert.notEqual(graphHash(reordered), graphHash(project), key);
  }
});
