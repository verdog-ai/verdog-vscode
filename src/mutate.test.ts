/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview The graph edits a canvas gesture makes, against the project we ship.
 *
 * These are the edits, not the validation: `verdog check` is the authority, and the last test
 * here is the one that matters most -- every mutation is run against a real project and the
 * result is re-read by the same model layer the canvas renders from, so an edit that would put
 * the graph in a state the canvas cannot draw fails here rather than on screen.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import Ajv2020 from 'ajv/dist/2020';

import projectSchema from '../schemas/project.schema.json';

import {testProfile, testProject} from './fixtures';

import {
  agentProfiles,
  agentSessions,
  defaultAgentInvokerOptions,
} from '../model/agents';
import {entityLabel} from '../model/names';
import {
  SCHEMA_VERSION,
  subroutineInProject,
  type CanonicalProject,
} from '../model/project';
import type {ResourceSelection} from '../model/resources';
import {
  snapshotCanvasGraphs,
  snapshotDefinitions,
  snapshotSubroutines,
  visibleDefinitionKeys,
} from '../webview/subroutineGraphs';
import {
  addCall,
  addAgentProfile,
  addAgentSession,
  addWorkflowProfile,
  addWorkflowSession,
  addFeature,
  addNode,
  addSubroutineDefinition,
  addWorkflowDefinition,
  connect,
  constrain,
  identifier,
  moved,
  orphanedPins,
  relink,
  remove,
  serialize,
  unconstrain,
  type Project,
  setNodeResources,
  setName,
  setProfileConfiguration,
  setSessionPersistence,
  setWorkflowResources,
} from '../model/editing';

const SUBROUTINE = 'main';
const NO_ARGUMENTS = {profile_arguments: {}, session_arguments: {}} as const;
function load(): Project {
  return testProject();
}
function withNodeResources(
  project: Project,
  subroutine: string,
  node: string,
  submitted: ResourceSelection[],
) {
  return setNodeResources(
    {
      project: project as CanonicalProject,
      pinned: {},
      entity_documents: {
        edges: {},
        features: {},
        nodes: {},
        profile_parameters: {},
        profiles: {},
        session_parameters: {},
        sessions: {},
      },
    },
    subroutine,
    node,
    submitted,
  );
}
const ajv = new Ajv2020({allErrors: true, strict: true});
const validateProject = ajv.compile(projectSchema);
function validateDefinition(name: string) {
  return ajv.compile({
    $defs: projectSchema.$defs,
    $ref: `#/$defs/${name}`,
  });
}

function subroutineOf(project: Project, id = SUBROUTINE) {
  return subroutineInProject(project, id) as unknown as Record<string, unknown>;
}

function ids(value: unknown) {
  return (value as Array<Record<string, unknown>>).map(item => String(item.id));
}

test('an identifier is derived from the name, and never collides', () => {
  assert.equal(identifier('Measure the baseline', []), 'measure_the_baseline');
  assert.equal(identifier('  Profile!! ', []), 'profile');
  assert.equal(identifier('2nd attempt', []), 'n2nd_attempt');
  assert.equal(identifier('class', []), 'class_step');
  assert.equal(identifier('plan', ['plan']), 'plan_2');
  // Only live ids are avoided. A name that is no longer in the graph is free again.
  assert.equal(identifier('pla', []), 'pla');
});

test('entity collection names are readable', () => {
  assert.equal(entityLabel('profile_parameters'), 'profile parameter');
  assert.equal(entityLabel('sessions'), 'session');
});

test('the schema applies the identifier grammar to canonical names', () => {
  const validateDefinition = ajv.compile(
    projectSchema.$defs.canonical_identifier,
  );
  for (const value of ['main', 'main__worker', 'main__worker_2']) {
    assert.equal(validateDefinition(value), true, value);
  }
  for (const value of [
    'main__class',
    'class__worker',
    'maïn',
    'main___worker',
  ]) {
    assert.equal(validateDefinition(value), false, value);
  }

  const validatePackage = ajv.compile(projectSchema.$defs.package_key);
  for (const value of ['class.tools', 'space.class']) {
    assert.equal(validatePackage(value), false, value);
  }

  const validateQualified = ajv.compile(
    projectSchema.$defs.qualified_subroutine,
  );
  for (const value of [
    'class.tools/main',
    'space.class/main',
    'space.tools/class__worker',
    'space.tools/main__class',
  ]) {
    assert.equal(validateQualified(value), false, value);
  }
  assert.equal(validateQualified('space.tools/main__worker'), true);
});

test('edge identifiers reserve double underscores for endpoints and parallel ordinals', () => {
  const validateEdge = ajv.compile(projectSchema.$defs.edge_identifier);
  for (const value of ['retry', 'a_b__c', 'a__b_c', 'a__b__2', 'a__b__10']) {
    assert.equal(validateEdge(value), true, value);
  }
  for (const value of ['a___b', 'a__b__1', 'a__b__02', 'a__class']) {
    assert.equal(validateEdge(value), false, value);
  }
});

test('only in-process calls carry explicit resource arguments', () => {
  const valid = load();
  const call = (
    subroutineOf(valid).nodes as Array<Record<string, unknown>>
  ).find(node => node.id === 'call_implement')!;
  call.operation = {
    profile_arguments: {agent: 'default'},
    session_arguments: {conversation: 'plan'},
    target: 'main__implement',
  };
  assert.equal(
    validateProject(valid),
    true,
    ajv.errorsText(validateProject.errors),
  );
  const missing = structuredClone(valid);
  (subroutineOf(missing).nodes as Array<Record<string, unknown>>).find(
    node => node.id === 'call_implement',
  )!.operation = {target: 'main__implement'};
  assert.equal(validateProject(missing), false);
  const workflow = structuredClone(valid);
  (subroutineOf(workflow).nodes as Array<Record<string, unknown>>).find(
    node => node.id === 'call_implement',
  )!.kind = 'workflow_call';
  assert.equal(validateProject(workflow), false);
});

test('the schema enforces enum domains and observation values', () => {
  const feature = validateDefinition('feature');
  const condition = validateDefinition('condition');
  const effect = validateDefinition('effect');
  const validFeature = {
    description: 'Current status',
    id: 'status',
    kind: 'enum',
    label: 'Status',
    values: ['retry', 'done'],
  };
  assert.equal(feature(validFeature), true, ajv.errorsText(feature.errors));
  assert.equal(feature({...validFeature, values: []}), false);
  assert.equal(feature({...validFeature, values: ['retry', 'retry']}), false);
  assert.equal(feature({...validFeature, kind: 'boolean'}), false);
  assert.equal(
    condition({feature_id: 'status', observation: 'equal', value: 'retry'}),
    true,
  );
  assert.equal(condition({feature_id: 'status', observation: 'equal'}), false);
  assert.equal(
    effect({feature_id: 'status', observation: 'unconstrained'}),
    true,
  );
  assert.equal(
    effect({
      feature_id: 'status',
      observation: 'unconstrained',
      value: 'retry',
    }),
    false,
  );
});

test('the schema makes agent resource shapes explicit', () => {
  const node = validateDefinition('node');
  const profile = validateDefinition('agent_profile');
  const session = validateDefinition('agent_session');
  const sessionParameter = validateDefinition('agent_session_parameter');
  const agent = {
    id: 'decide',
    kind: 'agent',
    name: 'Decide',
    operation: {profile: 'default', session: 'decide'},
  };
  assert.equal(node(agent), true, ajv.errorsText(node.errors));
  assert.equal(
    node({...agent, operation: {model: 'default', session: 'decide'}}),
    false,
  );
  const validProfile = testProfile('default', 'Default');
  assert.equal(profile(validProfile), true, ajv.errorsText(profile.errors));
  assert.equal(profile({id: 'default', name: 'Default'}), false);
  assert.equal(profile({...validProfile, provider: 'other'}), false);
  assert.equal(
    profile({...validProfile, options: {...validProfile.options, model: 1}}),
    false,
  );
  assert.equal(
    profile({...validProfile, options: {...validProfile.options, model: ''}}),
    false,
  );
  assert.equal(session({id: 'decide', name: 'Decide', persistent: true}), true);
  assert.equal(session({id: 'decide', name: 'Decide'}), false);
  assert.equal(sessionParameter({id: 'decide', name: 'Decide'}), true);
  assert.equal(
    sessionParameter({id: 'decide', name: 'Decide', persistent: true}),
    false,
  );
});

test('the schema validates source manifests with Ajv', () => {
  const source = validateDefinition('source_manifest');
  const valid = {
    ownership: 'user',
    path: 'src/example/impl.py',
    sha256: '0'.repeat(64),
    size: 12,
  };
  assert.equal(source(valid), true, ajv.errorsText(source.errors));
  assert.equal(source({...valid, sha256: 'not-a-digest'}), false);
  assert.equal(source({...valid, invented: true}), false);
});

test('the schema distinguishes pins, workflow definitions and qualified calls', () => {
  const node = validateDefinition('node');
  const external = validateDefinition('external');
  const workflow = validateDefinition('workflow_definition');
  const call = {
    id: 'call_helper',
    kind: 'subroutine_call',
    name: 'Call helper',
    operation: {
      profile_arguments: {},
      session_arguments: {},
      target: 'alice.helper_stable/implement',
    },
  };
  assert.equal(node(call), true, ajv.errorsText(node.errors));
  assert.equal(
    node({...call, operation: {...call.operation, target: 'helper_stable/'}}),
    false,
  );

  const pin = {
    alias: 'alice.helper_stable',
    commit: 'a'.repeat(40),
    name: 'helper',
    owner: 'alice',
    package: 'alice.helper',
    provider: 'github',
    repository_id: 17,
  };
  assert.equal(external(pin), true, ajv.errorsText(external.errors));
  const {alias: _alias, ...withoutAlias} = pin;
  assert.equal(external({...withoutAlias, required_by: null}), false);

  const reference = {
    external: {alias: 'alice.helper_stable', workflow: 'main'},
    id: 'helper',
    name: 'Helper',
  };
  assert.equal(workflow(reference), true, ajv.errorsText(workflow.errors));
  assert.equal(
    workflow({
      ...reference,
      external: {package: 'alice.helper', workflow: 'main'},
    }),
    false,
  );
  assert.equal(workflow({...reference, subroutine: 'main'}), false);
  assert.equal(
    workflow({
      subroutine: 'main',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    }),
    true,
  );
  assert.equal(workflow({id: 'main', name: 'Main', subroutine: 'main'}), false);
});

test('adding a python node writes an operation with nothing in it', () => {
  // The module path used to be written here, and had to match the one the compiler
  // derived. A graph does not carry it any more, so there is nothing to keep in step.
  const {id, project} = addNode(
    load(),
    SUBROUTINE,
    'python',
    'Measure the baseline',
  );
  assert.equal(id, 'measure_the_baseline');
  const node = (
    subroutineOf(project).nodes as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.deepEqual(node.operation, {});
  // Untouched original: every mutation returns a new document.
  assert.equal(ids(subroutineOf(load()).nodes).includes(id), false);
});

test('adding a feature node writes the same empty operation', () => {
  const {id, project} = addNode(
    load(),
    SUBROUTINE,
    'feature',
    'Update progress',
  );
  assert.equal(id, 'update_progress');
  const node = (
    subroutineOf(project).nodes as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.equal(node.kind, 'feature');
  assert.deepEqual(node.operation, {});
  assert.ok(validateProject(project), ajv.errorsText(validateProject.errors));
});

test('unknown dispatch values are refused', () => {
  assert.throws(
    () => addNode(load(), SUBROUTINE, 'unknown' as never, 'Broken'),
    /unknown node kind unknown/,
  );
});

test('agent nodes select their resources', () => {
  const agent = addNode(load(), SUBROUTINE, 'agent', 'Decide', undefined, {
    profile: 'default',
    session: 'optimize',
  }).project;
  const node = (subroutineOf(agent).nodes as Array<Record<string, unknown>>).at(
    -1,
  )!;
  const operation = node.operation as Record<string, unknown>;
  assert.deepEqual(operation, {profile: 'default', session: 'optimize'});
});

test('a call node names the visible definition it calls', () => {
  const body = addSubroutineDefinition(load(), 'Validate changes', SUBROUTINE);
  const defined = addWorkflowDefinition(body.project, SUBROUTINE, body.id);
  const {project} = addCall(
    defined.project,
    SUBROUTINE,
    'workflow_call',
    'Run the validator',
    defined.id,
  );
  const node = (
    subroutineOf(project).nodes as Array<Record<string, unknown>>
  ).at(-1)!;
  const operation = node.operation as Record<string, unknown>;
  assert.deepEqual(operation, {target: 'main__validate_changes'});
});

test('connecting two nodes adds an edge with no constraints yet', () => {
  const {files, id, project} = connect(
    load(),
    SUBROUTINE,
    'profile',
    'approve',
  );
  assert.equal(id, 'profile__approve');
  const edge = (
    subroutineOf(project).edges as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.equal(edge.source, 'profile');
  assert.equal(edge.target, 'approve');
  assert.deepEqual(edge.conditions, []);
  assert.deepEqual(edge.effects, []);
  assert.deepEqual(files, [
    {
      kind: 'require_absent',
      path: 'src/demo/project/subroutines/main/nodes/approve/visit/profile__approve/impl.py',
    },
  ]);

  const python = connect(load(), SUBROUTINE, 'profile', 'prepare_optimization');
  assert.deepEqual(python.files, [
    {
      kind: 'require_absent',
      path: 'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/profile__prepare_optimization/impl.py',
    },
  ]);

  const parallel = connect(
    python.project,
    SUBROUTINE,
    'profile',
    'prepare_optimization',
  );
  assert.deepEqual(parallel.files, [
    {
      kind: 'require_absent',
      path: `src/demo/project/subroutines/main/nodes/prepare_optimization/visit/${parallel.id}/impl.py`,
    },
  ]);
});

test('derived edge ids preserve endpoint boundaries', () => {
  let project = load();
  const nodes = ['A b', 'C', 'A', 'B c'].map(name => {
    const added = addNode(project, SUBROUTINE, 'python', name);
    project = added.project;
    return added.id;
  });
  const first = connect(project, SUBROUTINE, nodes[0], nodes[1]);
  const second = connect(first.project, SUBROUTINE, nodes[2], nodes[3]);
  const parallel = connect(second.project, SUBROUTINE, nodes[0], nodes[1]);

  assert.equal(first.id, 'a_b__c');
  assert.equal(second.id, 'a__b_c');
  assert.equal(parallel.id, 'a_b__c__2');
});

test('ports enforce direction while ordinary node self-loops remain valid', () => {
  assert.throws(
    () => connect(load(), SUBROUTINE, 'profile', 'enter'),
    /enter port cannot have incoming edges/,
  );
  assert.throws(
    () => connect(load(), SUBROUTINE, 'exit', 'profile'),
    /exit port cannot have outgoing edges/,
  );
  assert.throws(
    () => connect(load(), SUBROUTINE, 'failure', 'profile'),
    /failure port cannot have outgoing edges/,
  );
  const loop = connect(load(), SUBROUTINE, 'profile', 'profile');
  const edge = (
    subroutineOf(loop.project).edges as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.equal(edge.source, 'profile');
  assert.equal(edge.target, 'profile');
});

test("relinking preserves an edge's identity, name, and constraints", () => {
  const before = load();
  const original = (
    subroutineOf(before).edges as Array<Record<string, unknown>>
  ).find(edge => edge.id === 'iteration_consumed')!;
  const changed = relink(
    before,
    SUBROUTINE,
    'iteration_consumed',
    'consume_iteration',
    'approve',
  );
  const edge = (
    subroutineOf(changed.project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'iteration_consumed')!;

  assert.deepEqual(edge, {...original, target: 'approve'});
  assert.deepEqual(changed.files, [
    {
      from: 'src/demo/project/subroutines/main/nodes/profile/visit/iteration_consumed/impl.py',
      kind: 'rename',
      to: 'src/demo/project/subroutines/main/nodes/approve/visit/iteration_consumed/impl.py',
    },
  ]);
  assert.equal(original.target, 'profile', 'the input document is untouched');
});

test('relinking rejects a derived-looking edge id that lies about its endpoints', () => {
  const project = load();
  const edge = (
    subroutineOf(project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'enter__profile')!;
  edge.id = 'other__profile';

  assert.throws(
    () =>
      relink(
        project,
        SUBROUTINE,
        'other__profile',
        'enter',
        'prepare_optimization',
      ),
    /does not match its endpoints/,
  );
});

test('relinking moves a target-owned visit with either endpoint', () => {
  const moved = relink(
    load(),
    SUBROUTINE,
    'enter__profile',
    'enter',
    'prepare_optimization',
  );
  assert.deepEqual(moved.files, [
    {
      from: 'src/demo/project/subroutines/main/nodes/profile/visit/enter__profile/impl.py',
      kind: 'rename',
      to: 'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/enter__prepare_optimization/impl.py',
    },
  ]);
  const movedEdge = (
    subroutineOf(moved.project).edges as Array<Record<string, unknown>>
  ).find(edge => edge.id === 'enter__prepare_optimization');
  assert.equal(movedEdge?.name, 'Enter profile', 'a custom name is preserved');
  const [file] = moved.files;
  assert.equal(file?.kind, 'rename');
  assert.ok(
    (moved.project.sources as Array<Record<string, unknown>>).some(
      ({path}) => path === (file?.kind === 'rename' ? file.to : undefined),
    ),
  );

  const sourceOnly = relink(
    load(),
    SUBROUTINE,
    'enter__profile',
    'prepare_optimization',
    'profile',
  );
  assert.deepEqual(sourceOnly.files, [
    {
      from: 'src/demo/project/subroutines/main/nodes/profile/visit/enter__profile/impl.py',
      kind: 'rename',
      to: 'src/demo/project/subroutines/main/nodes/profile/visit/prepare_optimization__profile/impl.py',
    },
  ]);
});

test('relinking a generated parallel edge follows its endpoints without colliding', () => {
  const first = connect(load(), SUBROUTINE, 'profile', 'prepare_optimization');
  const parallel = connect(
    first.project,
    SUBROUTINE,
    'profile',
    'prepare_optimization',
  );
  const changed = relink(
    parallel.project,
    SUBROUTINE,
    parallel.id,
    'optimize',
    'plan',
  );
  const edges = subroutineOf(changed.project).edges as Array<
    Record<string, unknown>
  >;
  const edge = edges.find(item => item.id === 'optimize__plan__2');

  assert.equal(edge?.name, 'optimize plan');
  assert.equal(edge?.source, 'optimize');
  assert.equal(edge?.target, 'plan');
  assert.ok(
    edges.some(item => item.id === first.id),
    'the other parallel edge is untouched',
  );
  assert.ok(
    edges.some(item => item.id === 'optimize__plan'),
    'the existing edge is untouched',
  );
  assert.deepEqual(changed.files, [
    {
      from: 'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/profile__prepare_optimization__2/impl.py',
      kind: 'rename',
      to: 'src/demo/project/subroutines/main/nodes/plan/visit/optimize__plan__2/impl.py',
    },
  ]);
});

test('relinking preserves a custom id while updating a generated name', () => {
  const connected = connect(load(), SUBROUTINE, 'profile', 'approve');
  const edge = (
    subroutineOf(connected.project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === connected.id)!;
  edge.id = 'approval';

  const changed = relink(
    connected.project,
    SUBROUTINE,
    'approval',
    'profile',
    'exit',
  );
  const relinked = (
    subroutineOf(changed.project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'approval');
  assert.equal(relinked?.name, 'profile exit');
});

test('target relinking can explicitly discard the old implementation', () => {
  const changed = relink(
    load(),
    SUBROUTINE,
    'enter__profile',
    'enter',
    'prepare_optimization',
    'fresh',
  );
  const oldPath =
    'src/demo/project/subroutines/main/nodes/profile/visit/enter__profile/impl.py';
  const newPath =
    'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/enter__prepare_optimization/impl.py';
  assert.deepEqual(changed.files, [
    {kind: 'delete', path: oldPath},
    {kind: 'require_absent', path: newPath},
  ]);
  assert.equal(sourcePaths(changed.project).includes(oldPath), false);
  assert.equal(sourcePaths(changed.project).includes(newPath), false);
});

test('relinking refuses missing, directionally invalid, and effect-invalid endpoints', () => {
  assert.throws(
    () => relink(load(), SUBROUTINE, 'missing', 'profile', 'approve'),
    /no edge missing/,
  );
  assert.throws(
    () => relink(load(), SUBROUTINE, 'profile_analyze', 'missing', 'approve'),
    /no node missing/,
  );
  assert.throws(
    () => relink(load(), SUBROUTINE, 'profile_analyze', 'profile', 'missing'),
    /no node missing/,
  );
  assert.throws(
    () => relink(load(), SUBROUTINE, 'profile_analyze', 'profile', 'enter'),
    /enter port cannot have incoming edges/,
  );
  assert.throws(
    () => relink(load(), SUBROUTINE, 'profile_analyze', 'exit', 'approve'),
    /exit port cannot have outgoing edges/,
  );
  assert.throws(
    () =>
      relink(load(), SUBROUTINE, 'iteration_consumed', 'profile', 'approve'),
    /only an edge from a feature node can declare effects/,
  );
});

test('deleting a node takes its edges and its position with it', () => {
  const before = load();
  const attached = (
    subroutineOf(before).edges as Array<Record<string, unknown>>
  ).filter(edge => edge.source === 'profile' || edge.target === 'profile');
  assert.ok(attached.length > 0, 'the fixture must have edges on this node');

  const {code, impacts, project} = remove(
    before,
    SUBROUTINE,
    'nodes',
    'profile',
  );
  assert.ok(code.includes('src/demo/project/subroutines/main/nodes/profile'));
  assert.ok(
    code.includes(
      'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/profile_analyze/impl.py',
    ),
  );
  assert.equal(ids(subroutineOf(project).nodes).includes('profile'), false);
  for (const edge of ids(subroutineOf(project).edges)) {
    const found = (
      subroutineOf(project).edges as Array<Record<string, unknown>>
    ).find(item => item.id === edge)!;
    assert.notEqual(found.source, 'profile');
    assert.notEqual(found.target, 'profile');
  }
  // Reported, because a deletion that quietly takes four other things with it is a surprise.
  assert.equal(impacts.length, 1 + attached.length);
  assert.deepEqual(impacts[0], {
    effect: 'delete',
    entity: 'nodes',
    id: 'profile',
    reasons: ['selected'],
    scope: ['main'],
  });
  assert.ok(
    impacts
      .slice(1)
      .every(
        impact =>
          impact.effect === 'delete' &&
          impact.entity === 'edges' &&
          impact.reasons.includes('attached'),
      ),
  );
  const layouts = (
    (project.editor as Record<string, unknown>).layouts as Record<
      string,
      unknown
    >
  )[SUBROUTINE] as Record<string, unknown>;
  assert.equal('profile' in layouts, false);
});

test('a deleted name becomes available again', () => {
  // Nothing is recorded, and nothing needs to be: a dependency is a repository at a commit,
  // so whoever pinned the release that had this node still has it, and a later commit that
  // gives the name to something else cannot reach them.
  const {project} = remove(load(), SUBROUTINE, 'nodes', 'profile');
  assert.equal('tombstones' in project, false);
  const readded = addNode(project, SUBROUTINE, 'python', 'Profile');
  assert.equal(readded.id, 'profile');
});

test('a port node is refused rather than quietly breaking the workflow', () => {
  assert.throws(
    () => remove(load(), SUBROUTINE, 'nodes', 'enter'),
    /enter port/,
  );
});

test('deletion refuses phantom nodes and features', () => {
  assert.throws(
    () => remove(load(), SUBROUTINE, 'nodes', 'missing'),
    /no node missing in main/,
  );
  assert.throws(
    () => remove(load(), SUBROUTINE, 'features', 'missing'),
    /no feature missing in main/,
  );
});

test('deleting a feature takes the observations that named it', () => {
  const before = load();
  const named = (
    subroutineOf(before).edges as Array<Record<string, unknown>>
  ).filter(edge =>
    [
      ...(edge.conditions as Array<Record<string, unknown>>),
      ...(edge.effects as Array<Record<string, unknown>>),
    ].some(item => item.feature_id === 'remaining_iterations'),
  );
  assert.ok(
    named.length > 0,
    'the fixture must constrain this feature somewhere',
  );

  const {impacts, project} = remove(
    before,
    SUBROUTINE,
    'features',
    'remaining_iterations',
  );
  assert.equal(
    ids(subroutineOf(project).features).includes('remaining_iterations'),
    false,
  );
  for (const edge of subroutineOf(project).edges as Array<
    Record<string, unknown>
  >) {
    for (const collection of ['conditions', 'effects'] as const) {
      for (const item of edge[collection] as Array<Record<string, unknown>>) {
        assert.notEqual(item.feature_id, 'remaining_iterations');
      }
    }
  }
  assert.ok(
    impacts.some(
      impact =>
        impact.effect === 'update' &&
        impact.entity === 'edges' &&
        impact.reasons.includes('reference_removed'),
    ),
    'the observations are reported too',
  );
});

test('constraining an edge replaces rather than duplicates', () => {
  const once = constrain(
    load(),
    SUBROUTINE,
    'profile_analyze',
    'conditions',
    'remaining_iterations',
    'equal_zero',
  );
  const twice = constrain(
    once,
    SUBROUTINE,
    'profile_analyze',
    'conditions',
    'remaining_iterations',
    'greater_zero',
  );
  const edge = (
    subroutineOf(twice).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'profile_analyze')!;
  // One entry per feature per collection: the compiler refuses a second.
  assert.deepEqual(edge.conditions, [
    {feature_id: 'remaining_iterations', observation: 'greater_zero'},
  ]);

  const cleared = unconstrain(
    twice,
    SUBROUTINE,
    'profile_analyze',
    'conditions',
    'remaining_iterations',
  );
  const after = (
    subroutineOf(cleared).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'profile_analyze')!;
  assert.deepEqual(after.conditions, []);
  assert.throws(
    () =>
      unconstrain(
        twice,
        SUBROUTINE,
        'profile_analyze',
        'name' as 'conditions',
        'remaining_iterations',
      ),
    /name is not a constraint collection/,
  );

  assert.throws(
    () =>
      constrain(
        load(),
        SUBROUTINE,
        'profile_analyze',
        'conditions',
        'remaining_iterations',
        'positive',
      ),
    /not a conditions observation for integer/,
  );
  assert.throws(
    () =>
      constrain(
        load(),
        SUBROUTINE,
        'profile_analyze',
        'conditions',
        'missing',
        'greater_zero',
      ),
    /no feature missing/,
  );
  assert.throws(
    () =>
      constrain(
        load(),
        SUBROUTINE,
        'profile_analyze',
        'conditions',
        'remaining_iterations',
        'greater_zero',
        '1',
      ),
    /does not accept a value/,
  );
});

test('only an edge from a feature node can author effects', () => {
  assert.throws(
    () =>
      constrain(
        load(),
        SUBROUTINE,
        'profile_analyze',
        'effects',
        'remaining_iterations',
        'decreases',
      ),
    /only an edge from a feature node can declare effects/,
  );

  const added = addNode(load(), SUBROUTINE, 'feature', 'Update progress');
  const connected = connect(
    added.project,
    SUBROUTINE,
    added.id,
    'prepare_optimization',
  );
  const changed = constrain(
    connected.project,
    SUBROUTINE,
    connected.id,
    'effects',
    'remaining_iterations',
    'decreases',
  );
  const edge = (
    subroutineOf(changed).edges as Array<Record<string, unknown>>
  ).find(item => item.id === connected.id)!;
  assert.deepEqual(edge.effects, [
    {feature_id: 'remaining_iterations', observation: 'decreases'},
  ]);

  const repaired = unconstrain(
    load(),
    SUBROUTINE,
    'iteration_consumed',
    'effects',
    'remaining_iterations',
  );
  const featureEdge = (
    subroutineOf(repaired).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'iteration_consumed')!;
  assert.deepEqual(featureEdge.effects, []);
});

test('an enum feature constrains an edge with one declared value', () => {
  let project = addFeature(
    load(),
    SUBROUTINE,
    'enum',
    'Status',
    'Where the attempt is in its lifecycle.',
    ['pending', 'done'],
  ).project;
  project = constrain(
    project,
    SUBROUTINE,
    'profile_analyze',
    'conditions',
    'status',
    'equal',
    'pending',
  );
  const update = addNode(project, SUBROUTINE, 'feature', 'Update status');
  const outgoing = connect(
    update.project,
    SUBROUTINE,
    update.id,
    'prepare_optimization',
  );
  project = outgoing.project;
  project = constrain(
    project,
    SUBROUTINE,
    outgoing.id,
    'effects',
    'status',
    'equal',
    'done',
  );

  const feature = (
    subroutineOf(project).features as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.deepEqual(feature.values, ['pending', 'done']);
  const edge = (
    subroutineOf(project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'profile_analyze')!;
  assert.deepEqual(
    (edge.conditions as Array<Record<string, unknown>>).filter(
      item => item.feature_id === 'status',
    ),
    [{feature_id: 'status', observation: 'equal', value: 'pending'}],
  );
  const effectEdge = (
    subroutineOf(project).edges as Array<Record<string, unknown>>
  ).find(item => item.id === outgoing.id)!;
  assert.deepEqual(
    (effectEdge.effects as Array<Record<string, unknown>>).filter(
      item => item.feature_id === 'status',
    ),
    [{feature_id: 'status', observation: 'equal', value: 'done'}],
  );
  assert.ok(validateProject(project), ajv.errorsText(validateProject.errors));

  const unconstrained = constrain(
    project,
    SUBROUTINE,
    outgoing.id,
    'effects',
    'status',
    'unconstrained',
  );
  const changed = (
    subroutineOf(unconstrained).edges as Array<Record<string, unknown>>
  ).find(item => item.id === outgoing.id)!;
  assert.deepEqual(
    (changed.effects as Array<Record<string, unknown>>).filter(
      item => item.feature_id === 'status',
    ),
    [{feature_id: 'status', observation: 'unconstrained'}],
  );
  assert.throws(
    () =>
      constrain(project, SUBROUTINE, outgoing.id, 'effects', 'status', 'equal'),
    /not a value of enum feature status/,
  );
  assert.throws(
    () =>
      constrain(
        project,
        SUBROUTINE,
        outgoing.id,
        'effects',
        'status',
        'equal',
        'unknown',
      ),
    /not a value of enum feature status/,
  );
  assert.throws(
    () =>
      addFeature(load(), SUBROUTINE, 'enum', 'Status', 'Lifecycle.', ['class']),
    /Python keyword/,
  );
});

test('a drag lands in editor.layouts, rounded', () => {
  const project = moved(load(), SUBROUTINE, {profile: {x: 12.4, y: -7.6}});
  const layouts = (
    (project.editor as Record<string, unknown>).layouts as Record<
      string,
      unknown
    >
  )[SUBROUTINE] as Record<string, Record<string, number>>;
  assert.deepEqual(layouts.profile, {x: 12, y: -8});
});

test('every edit satisfies the project schema', () => {
  let project = load();
  project = addNode(project, SUBROUTINE, 'feature', 'Measure', {
    x: 40,
    y: 80,
  }).project;
  project = addFeature(
    project,
    SUBROUTINE,
    'integer',
    'Attempts left',
    'How many remain.',
  ).project;
  project = addAgentProfile(project, SUBROUTINE, 'Reviewer', true).project;
  project = addAgentSession(project, SUBROUTINE, 'Scratch', true).project;
  project = connect(project, SUBROUTINE, 'profile', 'measure').project;
  project = constrain(
    project,
    SUBROUTINE,
    'profile__measure',
    'conditions',
    'attempts_left',
    'greater_zero',
  );
  project = withNodeResources(project, SUBROUTINE, 'plan', [
    {resource: 'profile', value: 'default'},
    {resource: 'session', value: 'optimize'},
  ]);

  assert.ok(
    validateProject(project),
    ajv.errorsText(validateProject.errors, {separator: '\n'}),
  );

  const oldDependencies = structuredClone(project) as Project;
  (oldDependencies.workflow as Record<string, unknown>).dependencies = [];
  assert.equal(
    validateProject(oldDependencies),
    false,
    'dependencies live in requirements.txt',
  );

  // Prove the nested schema is reached using the key that previously broke every feature
  // created from the canvas.
  const invalid = structuredClone(project) as Project;
  const feature = (
    subroutineOf(invalid).features as Array<Record<string, unknown>>
  ).find(item => item.id === 'attempts_left')!;
  feature.implementation = 'features/attempts_left/impl';
  assert.equal(validateProject(invalid), false);
  assert.ok(
    validateProject.errors?.some(
      error =>
        error.keyword === 'additionalProperties' &&
        error.params.additionalProperty === 'implementation',
    ),
  );

  const wrongOperation = structuredClone(project) as Project;
  const measure = (
    subroutineOf(wrongOperation).nodes as Array<Record<string, unknown>>
  ).find(item => item.id === 'measure')!;
  measure.operation = {target: 'somewhere'};
  assert.equal(
    validateProject(wrongOperation),
    false,
    'feature operations must stay empty',
  );

  const body = addSubroutineDefinition(project, 'Worker', SUBROUTINE);
  const qualifiedWorkflow = addWorkflowDefinition(
    body.project,
    SUBROUTINE,
    body.id,
  );
  assert.ok(
    validateProject(qualifiedWorkflow.project),
    ajv.errorsText(validateProject.errors),
  );
  const canonicalDeclaration = structuredClone(body.project);
  (
    subroutineOf(canonicalDeclaration).subroutines as Array<
      Record<string, unknown>
    >
  )[0].id = 'main__worker';
  assert.equal(
    validateProject(canonicalDeclaration),
    false,
    'declaration ids stay local leaves',
  );
  const externalCall = addCall(
    project,
    SUBROUTINE,
    'subroutine_call',
    'External child',
    'publisher.tools/main__child',
    undefined,
    NO_ARGUMENTS,
  ).project;
  assert.ok(
    validateProject(externalCall),
    ajv.errorsText(validateProject.errors),
  );
  const invalidCall = addCall(
    qualifiedWorkflow.project,
    SUBROUTINE,
    'workflow_call',
    'Worker call',
    qualifiedWorkflow.id,
  ).project;
  const call = (
    subroutineOf(invalidCall).nodes as Array<Record<string, unknown>>
  ).at(-1)!;
  call.operation = {target: 'pin/main_body'};
  assert.equal(
    validateProject(invalidCall),
    false,
    'only subroutine calls accept alias/id',
  );
});

test('every edit leaves a graph the canvas can still draw', () => {
  // The gestures in sequence, on one document, then read back through the model layer the
  // webview renders from. A mutation that produced an unrenderable graph would fail here
  // rather than as a blank panel.
  let project = load();
  project = addNode(project, SUBROUTINE, 'feature', 'Measure', {
    x: 40,
    y: 80,
  }).project;
  project = addFeature(
    project,
    SUBROUTINE,
    'integer',
    'Attempts left',
    'How many remain.',
  ).project;
  project = connect(project, SUBROUTINE, 'profile', 'measure').project;
  project = connect(project, SUBROUTINE, 'measure', 'approve').project;
  project = constrain(
    project,
    SUBROUTINE,
    'profile__measure',
    'conditions',
    'attempts_left',
    'greater_zero',
  );
  project = constrain(
    project,
    SUBROUTINE,
    'measure__approve',
    'effects',
    'attempts_left',
    'decreases',
  );
  project = remove(
    project,
    SUBROUTINE,
    'nodes',
    'prepare_optimization',
  ).project;

  const workflows = snapshotSubroutines({
    entity_documents: {
      edges: {},
      features: {},
      nodes: {},
      profile_parameters: {},
      profiles: {},
      session_parameters: {},
      sessions: {},
    },
    pinned: {},
    project,
    // The rest of the snapshot shape the canvas does not consult for layout.
  } as unknown as Parameters<typeof snapshotSubroutines>[0]);

  const graph = workflows[SUBROUTINE];
  assert.ok(graph, 'the workflow still renders');
  assert.equal(project.workflow !== undefined, true);
  const drawn = graph.nodes.map(node => node.id);
  assert.ok(drawn.includes('measure'), 'the new node is on the canvas');
  assert.equal(
    drawn.includes('prepare_optimization'),
    false,
    'the deleted one is gone',
  );
  // No edge may point at a node that is no longer there.
  for (const edge of graph.edges) {
    assert.ok(drawn.includes(edge.source), `${edge.id} source`);
    assert.ok(drawn.includes(edge.target), `${edge.id} target`);
  }
  // Serialized the way the service writes it, so saving is not a whitespace diff.
  assert.ok(
    serialize(project).startsWith(
      `{\n  "schema_version": ${SCHEMA_VERSION},\n`,
    ),
  );
  assert.ok(serialize(project).endsWith('}\n'));
});

test('definitions and calls are separate edits', () => {
  const before = load();
  const {id, project} = addSubroutineDefinition(
    before,
    'Validate changes',
    SUBROUTINE,
  );
  assert.equal(id, 'main__validate_changes');

  const child = (
    subroutineOf(project).subroutines as Array<Record<string, unknown>>
  ).find(item => item.id === 'validate_changes')!;
  assert.deepEqual(child.ports, {
    enter: 'enter',
    exit: 'exit',
    failure: 'failure',
  });
  assert.deepEqual(ids(child.nodes), ['enter', 'exit', 'failure']);
  assert.deepEqual(ids(child.edges), ['enter__exit']);
  assert.deepEqual(child.features, []);

  assert.equal(ids(subroutineOf(project).nodes).includes(id), false);

  const called = addCall(
    project,
    SUBROUTINE,
    'subroutine_call',
    'Validate',
    id,
    undefined,
    NO_ARGUMENTS,
  ).project;
  const caller = subroutineOf(project);
  const calling = (
    subroutineOf(called).nodes as Array<Record<string, unknown>>
  ).at(-1)!;
  assert.equal(calling.kind, 'subroutine_call');
  assert.deepEqual(calling.operation, {...NO_ARGUMENTS, target: id});

  // Untouched original.
  assert.equal(
    (subroutineOf(load()).subroutines as unknown[]).length,
    (subroutineOf(before).subroutines as unknown[]).length,
  );
  assert.equal(
    (caller.nodes as unknown[]).length,
    (subroutineOf(before).nodes as unknown[]).length,
  );
});

test('definition names are unique only among siblings', () => {
  const left = addSubroutineDefinition(load(), 'Left', SUBROUTINE);
  const right = addSubroutineDefinition(left.project, 'Right', SUBROUTINE);
  const leftRetry = addSubroutineDefinition(right.project, 'Retry', left.id);
  const rightRetry = addSubroutineDefinition(
    leftRetry.project,
    'Retry',
    right.id,
  );

  assert.equal(leftRetry.id, 'main__left__retry');
  assert.equal(rightRetry.id, 'main__right__retry');
  assert.equal(
    addSubroutineDefinition(rightRetry.project, 'Retry', left.id).id,
    'main__left__retry_2',
  );
});

test('a workflow definition wraps one existing visible subroutine', () => {
  const body = addSubroutineDefinition(load(), 'Validate changes', SUBROUTINE);
  const before = subroutineOf(body.project).subroutines as unknown[];
  const {id, project} = addWorkflowDefinition(
    body.project,
    SUBROUTINE,
    body.id,
  );
  const envelope = (
    subroutineOf(project).workflows as Array<Record<string, unknown>>
  ).find(item => item.subroutine === id)!;
  assert.deepEqual(envelope, {
    subroutine: 'main__validate_changes',
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  });
  assert.equal(
    (subroutineOf(project).subroutines as unknown[]).length,
    before.length,
  );
  assert.throws(
    () => addWorkflowDefinition(project, SUBROUTINE, body.id),
    /already has a workflow definition/,
  );
  assert.throws(
    () => setName(project, SUBROUTINE, 'workflows', body.id, 'Separate label'),
    /derives its id and name from its subroutine/,
  );
});

test('workflow and subroutine ids have separate namespaces', () => {
  const first = addSubroutineDefinition(load(), 'Check', SUBROUTINE);
  const second = addWorkflowDefinition(first.project, SUBROUTINE, first.id);
  const invoked = addCall(
    second.project,
    SUBROUTINE,
    'workflow_call',
    'Run check',
    second.id,
  );
  assert.equal(first.id, 'main__check');
  assert.equal(second.id, 'main__check');
  assert.equal(
    addSubroutineDefinition(load(), 'Profile', SUBROUTINE).id,
    'main__profile',
  );

  const sourcePaths = [
    'src/demo/project/subroutines/main/subroutines/check/__init__.py',
    'src/demo/project/subroutines/main/subroutines/check/impl.py',
    'src/demo/project/subroutines/main/workflows/check/__init__.py',
    'src/demo/project/subroutines/main/workflows/check/impl.py',
    'src/demo/project/subroutines/main/workflows/check/bindings/__init__.py',
    'src/demo/project/subroutines/main/workflows/check/requirements.txt',
  ];
  invoked.project.sources = [
    ...((invoked.project.sources as unknown[]) ?? []),
    ...sourcePaths.map(path => ({path})),
  ];

  const snapshot = {
    entity_documents: {
      edges: {},
      features: {},
      nodes: {},
      profile_parameters: {},
      profiles: {},
      session_parameters: {},
      sessions: {},
    },
    pinned: {},
    project: invoked.project,
  } as unknown as Parameters<typeof snapshotSubroutines>[0];
  assert.deepEqual(
    snapshotDefinitions(snapshot)
      .filter(definition => definition.id === 'main__check')
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    [
      {
        declaredIn: 'main',
        documents: [
          {
            label: 'subroutine declaration',
            path: 'src/demo/project/subroutines/main/subroutines/check/__init__.py',
          },
          {
            label: 'subroutine implementation',
            path: 'src/demo/project/subroutines/main/subroutines/check/impl.py',
          },
        ],
        id: 'main__check',
        key: 'subroutine:main__check',
        kind: 'subroutine',
        ownerGraph: 'main',
        scope: 'main__check',
        target: 'main__check',
      },
      {
        declaredIn: 'main',
        documents: [
          {
            label: 'workflow declaration',
            path: 'src/demo/project/subroutines/main/workflows/check/__init__.py',
          },
          {
            label: 'workflow implementation',
            path: 'src/demo/project/subroutines/main/workflows/check/impl.py',
          },
          {
            label: 'requirements',
            path: 'src/demo/project/subroutines/main/workflows/check/requirements.txt',
          },
        ],
        id: 'main__check',
        key: 'workflow:main__check',
        kind: 'workflow',
        ownerGraph: 'main',
        scope: 'workflow:main__check',
        target: 'main__check',
        workflow: {
          profiles: [],
          sessions: [],
          profile_arguments: {},
          session_arguments: {},
          subroutine: 'main__check',
        },
      },
    ],
  );
  const graphs = snapshotCanvasGraphs(snapshot);
  assert.equal(
    graphs[SUBROUTINE].nodes.some(
      node => node.id === 'subroutine:check' || node.id === 'workflow:check',
    ),
    false,
  );
  assert.deepEqual(graphs['workflow:main__check'].edges, []);
  assert.deepEqual(
    graphs['workflow:main__check'].nodes.map(({id, data}) => ({
      id,
      kind: data.kind,
    })),
    [{id: 'subroutine', kind: 'subroutine_call'}],
  );
  assert.equal(graphs['workflow:main__check'].scope.kind, 'workflow');
  assert.deepEqual(
    graphs[SUBROUTINE].nodes.find(({id}) => id === invoked.id)?.data.definition,
    {graph: 'main__check', scope: 'workflow:main__check'},
  );
});

test('deleting a definition cascades through its callers and attached edges', () => {
  const defined = addSubroutineDefinition(
    load(),
    'Validate changes',
    SUBROUTINE,
  );
  const called = addCall(
    defined.project,
    SUBROUTINE,
    'subroutine_call',
    'Validate',
    defined.id,
    undefined,
    NO_ARGUMENTS,
  );
  const connected = connect(called.project, SUBROUTINE, called.id, 'approve');

  const removal = remove(
    connected.project,
    SUBROUTINE,
    'subroutines',
    defined.id,
  );
  assert.equal(subroutineInProject(removal.project, defined.id), undefined);
  assert.equal(
    ids(subroutineOf(removal.project).nodes).includes(called.id),
    false,
  );
  assert.equal(
    ids(subroutineOf(removal.project).edges).includes(connected.id),
    false,
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.effect === 'delete' &&
        impact.entity === 'nodes' &&
        impact.id === called.id &&
        impact.reasons.includes('calls_deleted_target'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.effect === 'delete' &&
        impact.entity === 'edges' &&
        impact.id === connected.id &&
        impact.reasons.includes('attached'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'nodes' &&
        impact.id === 'enter' &&
        impact.scope.join('/') === 'main/main__validate_changes' &&
        impact.reasons.includes('contained'),
    ),
  );
  assert.ok(
    removal.code.includes('src/demo/project/subroutines/main/nodes/validate'),
  );
  assert.ok(
    removal.code.includes(
      'src/demo/project/subroutines/main/nodes/approve/visit/validate__approve/impl.py',
    ),
  );
  assert.ok(
    removal.code.includes(
      'src/demo/project/subroutines/main/subroutines/validate_changes',
    ),
  );
});

test('deleting a workflow removes its calls but preserves its wrapped subroutine', () => {
  const body = addSubroutineDefinition(load(), 'Check', SUBROUTINE);
  const workflow = addWorkflowDefinition(body.project, SUBROUTINE, body.id);
  const profile = addWorkflowProfile(workflow.project, workflow.id, 'Runner');
  const session = addWorkflowSession(
    profile.project,
    workflow.id,
    'Conversation',
    true,
  );
  const call = addCall(
    session.project,
    SUBROUTINE,
    'workflow_call',
    'Run check',
    workflow.id,
  );

  const removal = remove(call.project, SUBROUTINE, 'workflows', workflow.id);
  assert.notEqual(subroutineInProject(removal.project, body.id), undefined);
  assert.equal(
    ids(subroutineOf(removal.project).nodes).includes(call.id),
    false,
  );
  assert.equal(
    (
      subroutineOf(removal.project).workflows as Array<Record<string, unknown>>
    ).some(item => item.subroutine === body.id),
    false,
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'nodes' &&
        impact.id === call.id &&
        impact.reasons.includes('calls_deleted_target'),
    ),
  );
  assert.equal(
    removal.impacts.some(
      impact => impact.entity === 'subroutines' && impact.id === body.id,
    ),
    false,
  );
  assert.deepEqual(
    removal.impacts
      .filter(impact => impact.workflow === workflow.id)
      .map(
        impact =>
          `${impact.scope.join('/')}|${impact.entity}:${impact.id}|${impact.reasons.join(',')}`,
      ),
    [
      `${SUBROUTINE}/${workflow.id}|profiles:${profile.id}|contained`,
      `${SUBROUTINE}/${workflow.id}|sessions:${session.id}|contained`,
    ],
  );
});

test('same-id external workflows do not depend on local subroutines', () => {
  const body = addSubroutineDefinition(load(), 'Same', SUBROUTINE);
  const root = subroutineOf(body.project);
  (root.workflows as unknown[]).push({
    external: {alias: 'dependency.pin', workflow: 'main'},
    id: 'same',
    name: 'External same',
  });
  const call = addCall(
    body.project,
    SUBROUTINE,
    'workflow_call',
    'Run external',
    body.id,
  );

  const removal = remove(call.project, SUBROUTINE, 'subroutines', body.id);
  assert.ok(
    (
      subroutineOf(removal.project).workflows as Array<Record<string, unknown>>
    ).some(item => item.id === 'same'),
  );
  assert.ok(ids(subroutineOf(removal.project).nodes).includes(call.id));
});

test('ambiguous same-kind definitions block deletion', () => {
  const child = addSubroutineDefinition(load(), 'Duplicate', SUBROUTINE);
  const root = subroutineOf(child.project);
  const definition = (root.subroutines as Array<Record<string, unknown>>).find(
    item => item.id === 'duplicate',
  )!;
  (root.subroutines as unknown[]).push(structuredClone(definition));

  assert.throws(
    () => remove(child.project, SUBROUTINE, 'nodes', 'profile'),
    /duplicate subroutine definition main__duplicate/,
  );
});

test('deleting a subroutine subtree deletes its saved layouts', () => {
  const parent = addSubroutineDefinition(
    load(),
    'Validate changes',
    SUBROUTINE,
  );
  const child = addSubroutineDefinition(parent.project, 'Retry', parent.id);
  let positioned = moved(child.project, parent.id, {enter: {x: 10, y: 20}});
  positioned = moved(positioned, child.id, {enter: {x: 30, y: 40}});

  const removed = remove(
    positioned,
    SUBROUTINE,
    'subroutines',
    parent.id,
  ).project;
  const layouts = (removed.editor as Record<string, unknown>).layouts as Record<
    string,
    unknown
  >;
  assert.equal(parent.id in layouts, false);
  assert.equal(child.id in layouts, false);
});

test('subroutine deletion includes nested definitions, outside wrappers, and their calls', () => {
  const parent = addSubroutineDefinition(load(), 'Parent', SUBROUTINE);
  const selected = addSubroutineDefinition(
    parent.project,
    'Validate changes',
    parent.id,
  );
  const child = addSubroutineDefinition(selected.project, 'Retry', selected.id);
  const inside = addWorkflowDefinition(child.project, selected.id, child.id);
  const insideProfile = addWorkflowProfile(
    inside.project,
    inside.id,
    'Runtime',
  );
  const outside = addWorkflowDefinition(
    insideProfile.project,
    parent.id,
    selected.id,
  );
  const outsideProfile = addWorkflowProfile(
    outside.project,
    outside.id,
    'Runtime',
  );
  const call = addCall(
    outsideProfile.project,
    parent.id,
    'workflow_call',
    'Run validation',
    outside.id,
  );
  const connected = connect(call.project, parent.id, 'enter', call.id).project;
  const unrelated = addAgentProfile(connected, parent.id, 'Keep', false);

  const removal = remove(
    unrelated.project,
    parent.id,
    'subroutines',
    selected.id,
  );
  const survivingParent = subroutineOf(removal.project, parent.id);
  assert.notEqual(subroutineInProject(removal.project, parent.id), undefined);
  assert.equal(subroutineInProject(removal.project, selected.id), undefined);
  assert.equal(subroutineInProject(removal.project, child.id), undefined);
  assert.equal(ids(survivingParent.nodes).includes(call.id), false);
  assert.equal(
    (survivingParent.workflows as Array<Record<string, unknown>>).some(
      workflow => workflow.subroutine === selected.id,
    ),
    false,
  );
  assert.ok(ids(survivingParent.profiles).includes(unrelated.id));
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'subroutines' &&
        impact.id === child.id &&
        impact.scope.join('/') === `main/${parent.id}/${selected.id}` &&
        impact.reasons.includes('contained'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'workflows' &&
        impact.id === inside.id &&
        impact.scope.join('/') === `main/${parent.id}/${selected.id}` &&
        impact.reasons.includes('contained'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'workflows' &&
        impact.id === outside.id &&
        impact.scope.join('/') === `main/${parent.id}` &&
        impact.reasons.includes('wraps_deleted_subroutine'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'nodes' &&
        impact.id === call.id &&
        impact.scope.join('/') === `main/${parent.id}` &&
        impact.reasons.includes('calls_deleted_target'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'edges' &&
        impact.id === 'enter__run_validation' &&
        impact.reasons.includes('attached'),
    ),
  );
  assert.deepEqual(
    removal.impacts
      .filter(impact => impact.entity === 'profiles' && impact.id === 'runtime')
      .map(impact => impact.workflow)
      .sort(),
    [inside.id, outside.id].sort(),
  );
  assert.deepEqual(
    removal.impacts.find(
      impact => impact.entity === 'profiles' && impact.workflow === outside.id,
    )?.reasons,
    ['wraps_deleted_subroutine'],
  );
  const selectedCode =
    'src/demo/project/subroutines/main/subroutines/parent/subroutines/validate_changes';
  assert.ok(removal.code.includes(selectedCode));
  assert.equal(
    removal.code.some(path => path.startsWith(`${selectedCode}/`)),
    false,
  );
  assert.ok(
    removal.code.includes(
      'src/demo/project/subroutines/main/subroutines/parent/workflows/validate_changes',
    ),
  );
});

test('a populated subtree reports every contained identity exactly once', () => {
  const selected = addSubroutineDefinition(load(), 'Full', SUBROUTINE);
  const nested = addSubroutineDefinition(
    selected.project,
    'Nested',
    selected.id,
  );
  const node = addNode(nested.project, selected.id, 'python', 'Work');
  const feature = addFeature(
    node.project,
    selected.id,
    'boolean',
    'Signal',
    'A signal.',
  );
  const profileParameter = addAgentProfile(
    feature.project,
    selected.id,
    'Input profile',
    true,
  );
  const profile = addAgentProfile(
    profileParameter.project,
    selected.id,
    'Reviewer',
    false,
  );
  const sessionParameter = addAgentSession(
    profile.project,
    selected.id,
    'Input session',
    true,
  );
  const session = addAgentSession(
    sessionParameter.project,
    selected.id,
    'Scratch',
    false,
    false,
  );
  const workflow = addWorkflowDefinition(
    session.project,
    selected.id,
    nested.id,
  );
  const workflowProfile = addWorkflowProfile(
    workflow.project,
    workflow.id,
    'Runner',
  );
  const workflowSession = addWorkflowSession(
    workflowProfile.project,
    workflow.id,
    'Conversation',
    true,
  );

  const removal = remove(
    workflowSession.project,
    SUBROUTINE,
    'subroutines',
    selected.id,
  );
  const row = (
    scope: string,
    entity: string,
    id: string,
    reason: string,
    workflow = '',
  ): string => `${scope}|${workflow}|${entity}|${id}|${reason}`;
  const selectedScope = `${SUBROUTINE}/${selected.id}`;
  const nestedScope = `${selectedScope}/${nested.id}`;
  const actual = removal.impacts
    .map(impact =>
      row(
        impact.scope.join('/'),
        impact.entity,
        impact.id,
        impact.reasons.join(','),
        impact.workflow,
      ),
    )
    .sort();
  const expected = [
    row(SUBROUTINE, 'subroutines', selected.id, 'selected'),
    row(selectedScope, 'subroutines', nested.id, 'contained'),
    row(selectedScope, 'workflows', workflow.id, 'contained'),
    ...['enter', 'exit', 'failure', node.id].map(id =>
      row(selectedScope, 'nodes', id, 'contained'),
    ),
    row(selectedScope, 'edges', 'enter__exit', 'contained'),
    row(selectedScope, 'features', feature.id, 'contained'),
    row(selectedScope, 'profile_parameters', profileParameter.id, 'contained'),
    row(selectedScope, 'profiles', profile.id, 'contained'),
    row(selectedScope, 'session_parameters', sessionParameter.id, 'contained'),
    row(selectedScope, 'sessions', session.id, 'contained'),
    row(
      `${selectedScope}/${workflow.id}`,
      'profiles',
      workflowProfile.id,
      'contained',
      workflow.id,
    ),
    row(
      `${selectedScope}/${workflow.id}`,
      'sessions',
      workflowSession.id,
      'contained',
      workflow.id,
    ),
    ...['enter', 'exit', 'failure'].map(id =>
      row(nestedScope, 'nodes', id, 'contained'),
    ),
    row(nestedScope, 'edges', 'enter__exit', 'contained'),
  ].sort();
  assert.deepEqual(actual, expected);
});

test('definition navigation marks lexical call visibility without hiding the project tree', () => {
  const parent = addSubroutineDefinition(load(), 'Parent', SUBROUTINE);
  const child = addSubroutineDefinition(parent.project, 'Child', parent.id);
  const sibling = addSubroutineDefinition(child.project, 'Sibling', SUBROUTINE);
  const snapshot = {
    entity_documents: {
      edges: {},
      features: {},
      nodes: {},
      profile_parameters: {},
      profiles: {},
      session_parameters: {},
      sessions: {},
    },
    pinned: {},
    project: sibling.project,
  } as unknown as Parameters<typeof visibleDefinitionKeys>[0];

  const fromSibling = visibleDefinitionKeys(snapshot, sibling.id);
  assert.equal(fromSibling.has(`subroutine:${parent.id}`), true);
  assert.equal(fromSibling.has(`subroutine:${child.id}`), false);
  assert.equal(fromSibling.has(`subroutine:${sibling.id}`), true);
  assert.equal(
    snapshotDefinitions(snapshot).some(({id}) => id === child.id),
    true,
  );
});

test('deleting an external definition reports the pin it orphaned', () => {
  const project = load();
  const graph = subroutineOf(project);
  project.externals = [
    {
      alias: 'borrowed.stable',
      commit: 'a'.repeat(40),
      name: 'tools',
      owner: 'ada',
      package: 'publisher.tools',
    },
  ];
  (graph.workflows as unknown[]).push({
    id: 'borrowed',
    name: 'Borrowed',
    external: {alias: 'borrowed.stable', workflow: 'main'},
  });

  // The external binding, rather than an individual call, owns use of the pin.
  assert.deepEqual(orphanedPins(project), []);

  const {orphaned} = remove(project, SUBROUTINE, 'workflows', 'main__borrowed');
  assert.deepEqual(orphaned, ['borrowed.stable']);
});

test('deleting an unrelated node orphans nothing', () => {
  // A pin whose caller is untouched: reporting it here would send the author into a
  // confirmation dialog about a dependency they did not mention.
  const project = load();
  const graph = subroutineOf(project);
  project.externals = [
    {
      alias: 'borrowed.stable',
      commit: 'a'.repeat(40),
      name: 'tools',
      owner: 'ada',
      package: 'publisher.tools',
    },
  ];
  (graph.workflows as unknown[]).push({
    id: 'borrowed',
    name: 'Borrowed',
    external: {alias: 'borrowed.stable', workflow: 'main'},
  });
  assert.deepEqual(
    remove(project, SUBROUTINE, 'nodes', 'profile').orphaned,
    [],
  );
});

/** Every `sources` path in a project, for the manifest assertions below. */
function sourcePaths(project: Project): string[] {
  return ((project.sources ?? []) as Array<Record<string, unknown>>).map(
    source => String(source.path),
  );
}

test('deleting the root subroutine replaces it with an empty main', () => {
  const workflowProfile = addWorkflowProfile(load(), SUBROUTINE, 'Runner');
  const workflowSession = addWorkflowSession(
    workflowProfile.project,
    SUBROUTINE,
    'Conversation',
    true,
  );
  const before = workflowSession.project;
  const workflowImplementation = 'src/demo/project/workflows/main/impl.py';
  (before.sources as Array<Record<string, unknown>>).push({
    ownership: 'user',
    path: workflowImplementation,
    sha256: '2'.repeat(64),
    size: 0,
  });
  const originalWorkflow = structuredClone(before.workflow);
  const removal = remove(before, SUBROUTINE, 'subroutines', SUBROUTINE);
  const root = subroutineOf(removal.project);

  assert.equal(root.id, SUBROUTINE);
  assert.equal(root.name, subroutineOf(before).name);
  assert.deepEqual(ids(root.nodes), ['enter', 'exit', 'failure']);
  assert.deepEqual(root.edges, [
    {
      conditions: [],
      effects: [],
      id: 'enter__exit',
      name: 'Pass through',
      source: 'enter',
      target: 'exit',
    },
  ]);
  for (const collection of [
    'features',
    'profile_parameters',
    'profiles',
    'session_parameters',
    'sessions',
    'subroutines',
    'workflows',
  ]) {
    assert.deepEqual(root[collection], []);
  }
  assert.deepEqual(removal.project.workflow, {
    ...(originalWorkflow as Record<string, unknown>),
    profile_arguments: {},
    profiles: [],
    session_arguments: {},
    sessions: [],
  });
  assert.equal(removal.reset, true);
  assert.deepEqual(removal.code, [
    'src/demo/project/subroutines/main',
    workflowImplementation,
  ]);
  assert.equal(
    sourcePaths(removal.project).some(path =>
      path.startsWith('src/demo/project/subroutines/main/'),
    ),
    false,
  );
  assert.equal(
    sourcePaths(removal.project).includes(workflowImplementation),
    false,
  );
  assert.deepEqual(
    (removal.project.editor as Record<string, unknown>).layouts,
    {},
  );
  assert.equal(
    validateProject(removal.project),
    true,
    JSON.stringify(validateProject.errors),
  );

  const keys = removal.impacts.map(
    impact => `${impact.scope.join('/')}|${impact.entity}|${impact.id}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.effect === 'update' &&
        impact.entity === 'subroutines' &&
        impact.id === SUBROUTINE &&
        impact.reasons.includes('selected') &&
        impact.reasons.includes('reset'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'subroutines' &&
        impact.id === 'main__implement' &&
        impact.reasons.includes('contained'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.effect === 'update' &&
        impact.entity === 'nodes' &&
        impact.id === 'enter' &&
        impact.scope.join('/') === SUBROUTINE &&
        impact.reasons.includes('reset'),
    ),
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.effect === 'update' &&
        impact.entity === 'workflows' &&
        impact.id === SUBROUTINE &&
        impact.reasons.includes('reset'),
    ),
  );
  assert.deepEqual(
    removal.impacts
      .filter(impact => impact.workflow === SUBROUTINE)
      .map(
        impact => `${impact.entity}:${impact.id}|${impact.reasons.join(',')}`,
      ),
    [
      `profiles:${workflowProfile.id}|contained`,
      `sessions:${workflowSession.id}|contained`,
    ],
  );
  assert.ok(
    removal.impacts.some(
      impact =>
        impact.entity === 'nodes' &&
        impact.id === 'enter' &&
        impact.scope.join('/') === 'main/main__implement' &&
        impact.reasons.includes('contained'),
    ),
  );
  assert.throws(
    () => remove(before, SUBROUTINE, 'workflows', SUBROUTINE),
    /no workflow main in main/,
  );
});

test('deleting a node takes its manifest entries and names its directory', () => {
  // Both halves are needed and neither is sufficient. The manifest prune is what keeps
  // `verdog check` alive -- `Clone.files()` reads every listed path and raises on a missing
  // one -- and the returned directory is what the caller moves to the OS trash, which is what
  // keeps `ty` quiet, because `ty` walks the working tree rather than the manifest.
  const before = load();
  const prefix = `src/demo/project/subroutines/${SUBROUTINE}/nodes/profile/`;
  assert.ok(
    sourcePaths(before).some(p => p.startsWith(prefix)),
    'the fixture must have them',
  );

  const {code, project} = remove(before, SUBROUTINE, 'nodes', 'profile');
  assert.deepEqual(code, [
    prefix.slice(0, -1),
    'src/demo/project/subroutines/main/nodes/prepare_optimization/visit/profile_analyze/impl.py',
    'src/demo/project/subroutines/main/nodes/approve/visit/profile_budget_exhausted/impl.py',
  ]);
  // Generated entries too, not only the author's, share the directory the caller is about
  // to delete. Outgoing visits live beside their target nodes, so those exact authored
  // files are named separately.
  assert.deepEqual(
    sourcePaths(project).filter(p => p.startsWith(prefix)),
    [],
  );
  // Nothing else moved: the input is cloned, not edited.
  assert.ok(sourcePaths(load()).some(p => p.startsWith(prefix)));
});

test('a sibling whose id starts with the deleted one survives', () => {
  // The trailing slash on the prefix is the whole of this. Without it, removing `profile`
  // takes `profile_2` with it -- silently, and the author finds out when their code is gone.
  const before = load();
  const root = `src/demo/project/subroutines/${SUBROUTINE}/nodes`;
  (before.sources as Array<Record<string, unknown>>).push({
    path: `${root}/profile_2/visit/other/impl.py`,
    ownership: 'user',
  });

  const {project} = remove(before, SUBROUTINE, 'nodes', 'profile');
  assert.ok(
    sourcePaths(project).includes(`${root}/profile_2/visit/other/impl.py`),
  );
});

test('deleting a feature takes its implementation, not the shared registry', () => {
  const {code, project} = remove(
    load(),
    SUBROUTINE,
    'features',
    'remaining_iterations',
  );
  assert.match(code[0] ?? '', /features\/remaining_iterations$/);
  assert.deepEqual(
    sourcePaths(project).filter(p =>
      p.includes('/features/remaining_iterations/'),
    ),
    [],
  );
  // `features/__init__.py` sits one level up, so a directory-terminated prefix cannot
  // reach it -- and it must not, because the other features still need it.
  assert.ok(
    sourcePaths(project).some(p => p.endsWith('/features/__init__.py')),
  );
});

test('deleting an edge claims its target-side visit implementation', () => {
  const edge = String(
    (subroutineOf(load()).edges as Array<Record<string, unknown>>)[0]?.id ?? '',
  );
  assert.deepEqual(remove(load(), SUBROUTINE, 'edges', edge).code, [
    'src/demo/project/subroutines/main/nodes/profile/visit/enter__profile/impl.py',
  ]);
});

test('agent resources distinguish parameters from local definitions', () => {
  const withProfile = addAgentProfile(load(), SUBROUTINE, 'Reviewer', true);
  const withSession = addAgentSession(
    withProfile.project,
    SUBROUTINE,
    'Scratch',
    true,
  );
  const graph = subroutineOf(withSession.project);
  assert.deepEqual(
    agentProfiles(graph).map(({id, origin}) => [id, origin]),
    [
      ['reviewer', 'parameter'],
      ['default', 'local'],
    ],
  );
  assert.deepEqual(
    agentSessions(graph).map(session => [
      session.id,
      session.origin,
      'persistent' in session ? session.persistent : undefined,
    ]),
    [
      ['scratch', 'parameter', undefined],
      ['optimize', 'local', true],
      ['plan', 'local', true],
    ],
  );
});

test('profiles and sessions have separate identifier namespaces', () => {
  const profile = addAgentProfile(load(), SUBROUTINE, 'Shared resource', true);
  const session = addAgentSession(
    profile.project,
    SUBROUTINE,
    'Shared resource',
    false,
    true,
  );
  const duplicateProfile = addAgentProfile(
    session.project,
    SUBROUTINE,
    'Shared resource',
    false,
  );
  const duplicateSession = addAgentSession(
    duplicateProfile.project,
    SUBROUTINE,
    'Shared resource',
    true,
  );
  assert.equal(profile.id, 'shared_resource');
  assert.equal(session.id, 'shared_resource');
  assert.equal(duplicateProfile.id, 'shared_resource_2');
  assert.equal(duplicateSession.id, 'shared_resource_2');
  assert.throws(
    () => addAgentSession(load(), SUBROUTINE, 'Incomplete', false),
    /needs persistence/,
  );
});

test('workflow boundaries own concrete profiles and sessions without binding them', () => {
  const profile = addWorkflowProfile(load(), 'main', 'Runtime');
  const duplicate = addWorkflowProfile(profile.project, 'main', 'Runtime');
  const session = addWorkflowSession(
    duplicate.project,
    'main',
    'Runtime',
    false,
  );
  const workflow = session.project.workflow as Record<string, unknown>;

  assert.equal(profile.id, 'runtime');
  assert.equal(duplicate.id, 'runtime_2');
  assert.equal(
    session.id,
    'runtime',
    'profile and session ids have separate namespaces',
  );
  assert.deepEqual(workflow.profiles, [
    testProfile('runtime', 'Runtime'),
    testProfile('runtime_2', 'Runtime'),
  ]);
  assert.deepEqual(workflow.sessions, [
    {id: 'runtime', name: 'Runtime', persistent: false},
  ]);
  assert.deepEqual(workflow.profile_arguments, {});
  assert.deepEqual(workflow.session_arguments, {});
  assert.ok(
    validateProject(session.project),
    ajv.errorsText(validateProject.errors),
  );
  assert.throws(
    () => addWorkflowProfile(load(), 'missing', 'Runtime'),
    /no local workflow/,
  );
});

test('unbound workflow resources delete in their workflow scope and namespace', () => {
  const profile = addWorkflowProfile(load(), 'main', 'Shared');
  const session = addWorkflowSession(profile.project, 'main', 'Shared', false);
  const root = remove(session.project, 'main', 'profiles', profile.id, 'main');
  const rootWorkflow = root.project.workflow as Record<string, unknown>;

  assert.deepEqual(root.code, [
    'src/demo/project/workflows/main/profiles/shared',
  ]);
  assert.deepEqual(root.impacts, [
    {
      effect: 'delete',
      entity: 'profiles',
      id: 'shared',
      reasons: ['selected'],
      scope: ['main'],
      workflow: 'main',
    },
  ]);
  assert.deepEqual(rootWorkflow.profiles, []);
  assert.deepEqual(
    rootWorkflow.sessions,
    [{id: 'shared', name: 'Shared', persistent: false}],
    'profile and session ids have separate namespaces',
  );

  const wrapped = addWorkflowDefinition(load(), 'main', 'main__implement');
  const nested = addWorkflowSession(
    wrapped.project,
    wrapped.id,
    'Temporary',
    false,
  );
  const removed = remove(
    nested.project,
    'main',
    'sessions',
    nested.id,
    wrapped.id,
  );
  assert.deepEqual(removed.code, [
    'src/demo/project/subroutines/main/workflows/implement/sessions/temporary',
  ]);
  assert.deepEqual(removed.impacts[0]?.scope, ['main', 'main__implement']);
  assert.equal(removed.impacts[0]?.workflow, wrapped.id);
  const nestedWorkflow = (
    subroutineOf(removed.project).workflows as Array<Record<string, unknown>>
  ).find(({subroutine}) => subroutine === 'main__implement')!;
  assert.deepEqual(nestedWorkflow.sessions, []);
});

test('bound workflow resources must be rebound before deletion', () => {
  const profile = addWorkflowProfile(load(), 'main', 'Runtime');
  const session = addWorkflowSession(profile.project, 'main', 'Runtime', false);
  const graph = subroutineOf(session.project);
  graph.profile_parameters = [{id: 'agent', name: 'Agent'}];
  graph.session_parameters = [{id: 'conversation', name: 'Conversation'}];
  const workflow = session.project.workflow as Record<string, unknown>;
  workflow.profile_arguments = {agent: profile.id};
  workflow.session_arguments = {conversation: session.id};

  assert.throws(
    () => remove(session.project, 'main', 'profiles', profile.id, 'main'),
    /workflow profile runtime is bound; rebind it before deleting it/,
  );
  assert.throws(
    () => remove(session.project, 'main', 'sessions', session.id, 'main'),
    /workflow session runtime is bound; rebind it before deleting it/,
  );
  assert.equal((workflow.profiles as unknown[]).length, 1);
  assert.equal((workflow.sessions as unknown[]).length, 1);
});

test('formal resources keep every targeting workflow envelope complete', () => {
  const wrapped = addWorkflowDefinition(load(), SUBROUTINE, 'main__implement');
  const profile = addAgentProfile(
    wrapped.project,
    'main__implement',
    'Generator',
    true,
  );
  const session = addAgentSession(
    profile.project,
    'main__implement',
    'Conversation',
    true,
  );
  const workflow = (
    subroutineOf(session.project).workflows as Array<Record<string, unknown>>
  ).find(candidate => candidate.subroutine === 'main__implement')!;
  assert.deepEqual(workflow.profile_arguments, {generator: 'generator'});
  assert.deepEqual(workflow.session_arguments, {conversation: 'conversation'});

  const rebound = setWorkflowResources(session.project, 'main__implement', [
    {parameter: 'generator', resource: 'profile', value: 'generator'},
    {parameter: 'conversation', resource: 'session', value: 'conversation'},
  ]);
  assert.throws(
    () => setWorkflowResources(session.project, 'main__implement', []),
    /not every required resource/,
  );
  const withoutProfile = remove(
    rebound,
    'main__implement',
    'profile_parameters',
    'generator',
  );
  const withoutSession = remove(
    withoutProfile.project,
    'main__implement',
    'session_parameters',
    'conversation',
  );
  const remaining = (
    subroutineOf(withoutSession.project).workflows as Array<
      Record<string, unknown>
    >
  ).find(candidate => candidate.subroutine === 'main__implement')!;
  assert.deepEqual(remaining.profile_arguments, {});
  assert.deepEqual(remaining.session_arguments, {});
  for (const removal of [withoutProfile, withoutSession]) {
    assert.ok(
      removal.impacts.some(
        impact =>
          impact.effect === 'update' &&
          impact.entity === 'workflows' &&
          impact.id === 'main__implement' &&
          impact.reasons.includes('reference_removed'),
      ),
    );
  }

  const rootProfile = addAgentProfile(load(), SUBROUTINE, 'Generator', true);
  const rootSession = addAgentSession(
    rootProfile.project,
    SUBROUTINE,
    'Conversation',
    true,
  );
  assert.deepEqual(rootSession.project.workflow, {
    profiles: [testProfile('generator', 'Generator')],
    sessions: [{id: 'conversation', name: 'Conversation', persistent: true}],
    profile_arguments: {generator: 'generator'},
    session_arguments: {conversation: 'conversation'},
    subroutine: 'main',
  });
  assert.ok(
    validateProject(rootSession.project),
    ajv.errorsText(validateProject.errors),
  );
  const rootWithoutProfile = remove(
    rootSession.project,
    SUBROUTINE,
    'profile_parameters',
    'generator',
  );
  const rootWithoutSession = remove(
    rootWithoutProfile.project,
    SUBROUTINE,
    'session_parameters',
    'conversation',
  );
  assert.deepEqual(rootWithoutSession.project.workflow, {
    profiles: [testProfile('generator', 'Generator')],
    sessions: [{id: 'conversation', name: 'Conversation', persistent: true}],
    profile_arguments: {},
    session_arguments: {},
    subroutine: 'main',
  });
  for (const removal of [rootWithoutProfile, rootWithoutSession]) {
    assert.ok(
      removal.impacts.some(
        impact =>
          impact.effect === 'update' &&
          impact.entity === 'workflows' &&
          impact.id === 'main' &&
          impact.reasons.includes('reference_removed'),
      ),
    );
  }
});

test('a new session parameter can reuse any existing boundary session', () => {
  const project = load();
  const graph = subroutineOf(project);
  graph.session_parameters = [{id: 'temporary', name: 'Temporary'}];
  (project.workflow as Record<string, unknown>).session_arguments = {
    temporary: 'conversation',
  };
  (project.workflow as Record<string, unknown>).sessions = [
    {id: 'conversation', name: 'Temporary', persistent: false},
  ];

  const added = addAgentSession(project, SUBROUTINE, 'Conversation', true);
  assert.equal(added.id, 'conversation');
  assert.deepEqual(
    (added.project.workflow as Record<string, unknown>).session_arguments,
    {
      temporary: 'conversation',
      conversation: 'conversation',
    },
  );
  assert.deepEqual(
    (added.project.workflow as Record<string, unknown>).sessions,
    [{id: 'conversation', name: 'Temporary', persistent: false}],
  );
});

test('an agent selects a profile and session from its own subroutine', () => {
  const selected: ResourceSelection[] = [
    {resource: 'profile', value: 'default'},
    {resource: 'session', value: 'optimize'},
  ];
  const changed = withNodeResources(load(), SUBROUTINE, 'plan', selected);
  const operation = (
    subroutineOf(changed).nodes as Array<Record<string, unknown>>
  ).find(node => node.id === 'plan')?.operation;
  assert.deepEqual(operation, {profile: 'default', session: 'optimize'});
  assert.throws(
    () =>
      withNodeResources(load(), SUBROUTINE, 'plan', [
        {resource: 'profile', value: 'missing'},
        {resource: 'session', value: 'optimize'},
      ]),
    /missing is not valid/,
  );
  assert.throws(
    () => withNodeResources(load(), SUBROUTINE, 'profile', selected),
    /does not have resource bindings/,
  );

  const child = addSubroutineDefinition(load(), 'Child', SUBROUTINE);
  const withAgent = addNode(
    child.project,
    child.id,
    'agent',
    'Nested',
    undefined,
    {profile: 'default', session: 'optimize'},
  );
  assert.throws(
    () =>
      withNodeResources(withAgent.project, child.id, withAgent.id, selected),
    /default is not valid/,
    'ancestor resources are not inherited',
  );
});

test('profile options and session persistence update subroutine and workflow owners', () => {
  assert.deepEqual(defaultAgentInvokerOptions(), {
    model: null,
    reasoning_effort: null,
    extra_args: [],
  });
  const options = {
    model: 'opus',
    reasoning_effort: 'high',
    extra_args: ['--allowed-tools', 'Read,Edit'],
  };
  const localProfile = setProfileConfiguration(
    load(),
    SUBROUTINE,
    'default',
    'claude',
    options,
  );
  assert.deepEqual(
    (subroutineOf(localProfile).profiles as Array<Record<string, unknown>>)[0],
    {
      ...testProfile('default', 'Default', 'claude'),
      options,
    },
  );

  const boundary = load();
  boundary.workflow = {
    subroutine: 'main',
    profiles: [testProfile('runtime', 'Runtime')],
    sessions: [{id: 'runtime', name: 'Runtime', persistent: false}],
    profile_arguments: {},
    session_arguments: {},
  };
  const workflowProfile = setProfileConfiguration(
    boundary,
    SUBROUTINE,
    'runtime',
    'claude',
    options,
    'main',
  );
  const workflowSession = setSessionPersistence(
    workflowProfile,
    SUBROUTINE,
    'runtime',
    true,
    'main',
  );
  assert.deepEqual(
    (workflowSession.workflow as Record<string, unknown>).profiles,
    [
      {
        ...testProfile('runtime', 'Runtime', 'claude'),
        options,
      },
    ],
  );
  assert.deepEqual(
    (workflowSession.workflow as Record<string, unknown>).sessions,
    [{id: 'runtime', name: 'Runtime', persistent: true}],
  );

  const bound = load();
  subroutineOf(bound).session_parameters = [
    {id: 'conversation', name: 'Conversation'},
  ];
  bound.workflow = {
    subroutine: 'main',
    profiles: [],
    sessions: [{id: 'runtime', name: 'Runtime', persistent: false}],
    profile_arguments: {},
    session_arguments: {conversation: 'runtime'},
  };
  const rebound = setSessionPersistence(
    bound,
    SUBROUTINE,
    'runtime',
    true,
    'main',
  );
  assert.equal(
    (
      (rebound.workflow as Record<string, unknown>).sessions as Array<
        Record<string, unknown>
      >
    )[0]?.persistent,
    true,
  );
});

test('deleting a resource cascades through its dependent nodes', () => {
  const added = addAgentProfile(load(), SUBROUTINE, 'Unused', false);
  assert.deepEqual(
    remove(added.project, SUBROUTINE, 'profiles', added.id).code,
    ['src/demo/project/subroutines/main/profiles/unused'],
  );
  const project = load();
  subroutineOf(project, 'main__implement').profile_parameters = [
    {id: 'agent', name: 'Agent'},
  ];
  const bound = withNodeResources(project, SUBROUTINE, 'call_implement', [
    {parameter: 'agent', resource: 'profile', value: 'default'},
  ]);
  const removed = remove(bound, SUBROUTINE, 'profiles', 'default');
  assert.deepEqual(ids(subroutineOf(removed.project).nodes), [
    'enter',
    'profile',
    'prepare_optimization',
    'consume_iteration',
    'approve',
    'exit',
    'failure',
  ]);
  for (const id of ['call_implement', 'optimize', 'plan']) {
    assert.ok(
      removed.impacts.some(
        impact =>
          impact.effect === 'delete' &&
          impact.entity === 'nodes' &&
          impact.id === id &&
          impact.reasons.includes('uses_deleted_resource'),
      ),
    );
  }
  assert.ok(
    removed.impacts.some(
      impact =>
        impact.effect === 'delete' &&
        impact.entity === 'edges' &&
        impact.id === 'plan_implement' &&
        impact.reasons.includes('attached'),
    ),
  );
  assert.ok(
    removed.code.includes(
      'src/demo/project/subroutines/main/nodes/call_implement',
    ),
  );
});

test('a call can be rebound before deleting its old resource', () => {
  const replacement = addAgentProfile(load(), SUBROUTINE, 'Replacement', false);
  let project = withNodeResources(replacement.project, SUBROUTINE, 'optimize', [
    {resource: 'profile', value: replacement.id},
    {resource: 'session', value: 'optimize'},
  ]);
  project = withNodeResources(project, SUBROUTINE, 'plan', [
    {resource: 'profile', value: replacement.id},
    {resource: 'session', value: 'plan'},
  ]);
  subroutineOf(project, 'main__implement').profile_parameters = [
    {id: 'agent', name: 'Agent'},
  ];
  project = withNodeResources(project, SUBROUTINE, 'call_implement', [
    {parameter: 'agent', resource: 'profile', value: replacement.id},
  ]);
  const removed = remove(project, SUBROUTINE, 'profiles', 'default');
  assert.ok(
    ids(subroutineOf(removed.project).nodes).includes('call_implement'),
  );
  assert.deepEqual(removed.impacts, [
    {
      effect: 'delete',
      entity: 'profiles',
      id: 'default',
      reasons: ['selected'],
      scope: ['main'],
    },
  ]);
  assert.throws(
    () =>
      withNodeResources(project, SUBROUTINE, 'call_implement', [
        {parameter: 'agent', resource: 'profile', value: 'missing'},
      ]),
    /missing is not valid/,
  );
  assert.throws(
    () => withNodeResources(project, SUBROUTINE, 'call_implement', []),
    /not every required resource/,
  );
});

test("removing a formal resource drops its local callers' obsolete keys", () => {
  const project = load();
  const child = subroutineOf(project, 'main__implement');
  child.profile_parameters = [{id: 'agent', name: 'Agent'}];
  const bound = withNodeResources(project, SUBROUTINE, 'call_implement', [
    {parameter: 'agent', resource: 'profile', value: 'default'},
  ]);
  const removal = remove(
    bound,
    'main__implement',
    'profile_parameters',
    'agent',
  );
  assert.deepEqual(removal.code, [
    'src/demo/project/subroutines/main/subroutines/implement/profiles/agent',
  ]);
  const removed = removal.project;
  const call = (
    subroutineOf(removed).nodes as Array<Record<string, unknown>>
  ).find(node => node.id === 'call_implement')!;
  assert.deepEqual(call.operation, {
    profile_arguments: {},
    session_arguments: {},
    target: 'main__implement',
  });
});

test('a dependent deletion supersedes an update to the same identity', () => {
  const project = load();
  const childId = 'main__implement';
  const child = subroutineOf(project, childId);
  child.profile_parameters = [
    {id: 'agent', name: 'Agent'},
    {id: 'reviewer', name: 'Reviewer'},
  ];
  const recursive = addCall(
    project,
    childId,
    'subroutine_call',
    'Again',
    childId,
    undefined,
    {
      profile_arguments: {agent: 'agent', reviewer: 'agent'},
      session_arguments: {},
    },
  );

  const removal = remove(
    recursive.project,
    childId,
    'profile_parameters',
    'agent',
  );
  const impact = removal.impacts.find(
    candidate => candidate.entity === 'nodes' && candidate.id === recursive.id,
  );
  assert.deepEqual(impact, {
    effect: 'delete',
    entity: 'nodes',
    id: recursive.id,
    reasons: ['reference_removed', 'uses_deleted_resource'],
    scope: ['main', childId],
  });
});

test('a name is prose, and changing it touches nothing else', () => {
  // The distinction the properties panel rests on: `name` is a label nothing refers to, so it
  // is a plain edit; `id` is what module paths and edge endpoints are built from, so that is
  // `verdog rename`. A panel that treated them alike would either be slow or be wrong.
  const before = load();
  const after = setName(
    before,
    SUBROUTINE,
    'nodes',
    'profile',
    '  Profile it properly  ',
  );
  const node = (project: Project) =>
    (subroutineOf(project).nodes as Array<Record<string, unknown>>).find(
      n => n.id === 'profile',
    )!;
  assert.equal(node(after).name, 'Profile it properly');
  assert.equal(node(after).id, 'profile', 'the identifier is untouched');
  // Nothing else moved: same ids, same edges, same everything but that one string.
  assert.deepEqual(
    ids(subroutineOf(after).nodes),
    ids(subroutineOf(before).nodes),
  );
  assert.deepEqual(subroutineOf(after).edges, subroutineOf(before).edges);

  // A feature's prose is `label`, not `name`.
  const labelled = setName(
    before,
    SUBROUTINE,
    'features',
    'remaining_iterations',
    'Left to go',
  );
  const feature = (
    subroutineOf(labelled).features as Array<Record<string, unknown>>
  )[0];
  assert.equal(feature.label, 'Left to go');
  assert.equal(feature.id, 'remaining_iterations');

  const rootNamed = setName(
    before,
    SUBROUTINE,
    'subroutines',
    SUBROUTINE,
    'Primary process',
  );
  assert.equal(subroutineOf(rootNamed).name, 'Primary process');
  assert.equal(subroutineOf(rootNamed).id, SUBROUTINE);

  const withBoundaryResources = structuredClone(before);
  const boundary = withBoundaryResources.workflow as Record<string, unknown>;
  boundary.profiles = [testProfile('builder', 'Builder')];
  boundary.sessions = [{id: 'history', name: 'History', persistent: true}];
  boundary.profile_arguments = {agent: 'builder'};
  boundary.session_arguments = {conversation: 'history'};
  const profileNamed = setName(
    withBoundaryResources,
    SUBROUTINE,
    'profiles',
    'builder',
    'Build changes',
    SUBROUTINE,
  );
  const sessionNamed = setName(
    profileNamed,
    SUBROUTINE,
    'sessions',
    'history',
    'Conversation history',
    SUBROUTINE,
  );
  const renamedBoundary = sessionNamed.workflow as Record<string, unknown>;
  assert.deepEqual(renamedBoundary.profiles, [
    {...testProfile('builder', 'Build changes')},
  ]);
  assert.deepEqual(renamedBoundary.sessions, [
    {id: 'history', name: 'Conversation history', persistent: true},
  ]);
  assert.deepEqual(renamedBoundary.profile_arguments, {agent: 'builder'});
  assert.deepEqual(renamedBoundary.session_arguments, {
    conversation: 'history',
  });

  assert.throws(
    () => setName(before, SUBROUTINE, 'nodes', 'profile', '   '),
    /must not be empty/,
  );
  assert.throws(
    () => setName(before, SUBROUTINE, 'nodes', 'nope', 'x'),
    /no node nope/,
  );
});

test('aliases orphan independently when two pins name the same package', () => {
  const project = {
    externals: [
      {alias: 'channel.stable', package: 'publisher.tools'},
      {alias: 'channel.canary', package: 'publisher.tools'},
    ],
    subroutine: {
      edges: [],
      features: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      id: 'main_body',
      name: 'Main body',
      nodes: [],
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      subroutines: [],
      workflows: [
        {
          id: 'stable_tools',
          name: 'Stable',
          external: {alias: 'channel.stable', workflow: 'main'},
        },
        {
          id: 'canary_tools',
          name: 'Canary',
          external: {alias: 'channel.canary', workflow: 'main'},
        },
      ],
    },
    workflow: {
      subroutine: 'main_body',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
  } as unknown as Project;

  assert.deepEqual(orphanedPins(project), []);

  const withoutStable = remove(
    project,
    'main_body',
    'workflows',
    'main_body__stable_tools',
  );
  assert.deepEqual(withoutStable.orphaned, ['channel.stable']);
  assert.deepEqual(
    remove(
      withoutStable.project,
      'main_body',
      'workflows',
      'main_body__canary_tools',
    ).orphaned.sort(),
    ['channel.canary'],
  );
});

test('deletion does not clean up a pin that was already unused', () => {
  const project = load();
  project.externals = [{alias: 'unused.pin', package: 'publisher.unused'}];
  assert.deepEqual(orphanedPins(project), ['unused.pin']);
  assert.deepEqual(
    remove(project, SUBROUTINE, 'nodes', 'profile').orphaned,
    [],
  );
});

test('a qualified subroutine call keeps its direct pin in use', () => {
  const project = load();
  project.externals = [{alias: 'publisher.tools', package: 'publisher.tools'}];
  const called = addCall(
    project,
    SUBROUTINE,
    'subroutine_call',
    'Use tools',
    'publisher.tools/main_body',
    undefined,
    NO_ARGUMENTS,
  ).project;
  assert.deepEqual(orphanedPins(called), []);
  assert.deepEqual(remove(called, SUBROUTINE, 'nodes', 'use_tools').orphaned, [
    'publisher.tools',
  ]);
});
