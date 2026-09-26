/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {testProfile, testProject} from './fixtures';
import {
  agentProfileId,
  agentSessionId,
  edgeId,
  featureId,
  graphId,
  nodeId,
} from '../model/identifiers';
import {
  subroutineInProject,
  type CanonicalProject,
  type LocalWorkflowDefinition,
} from '../model/project';
import {
  nodeResourceFields,
  normalizeNodeResources,
  normalizeWorkflowResources,
  workflowResourceFields,
} from '../model/resources';
import type {ProjectGraphs, ProjectSnapshot} from '../model/snapshot';

import {bindingSummary, resolveParameter} from '../model/bindings';
import {
  constraintNotation,
  entityDetails,
  entityPropertyPage,
  workflowResourceDetails,
} from '../webview/propertyData';
import {snapshotCanvasGraphs} from '../webview/subroutineGraphs';

const project = testProject();

function emptyDocuments(): ProjectSnapshot['entity_documents'] {
  return {
    edges: {},
    features: {},
    nodes: {},
    profile_parameters: {},
    profiles: {},
    session_parameters: {},
    sessions: {},
  };
}

function snapshotOf(
  project: CanonicalProject,
  pinned: Record<string, CanonicalProject> = {},
): ProjectSnapshot {
  return {
    checked: false,
    diagnostic_count: 0,
    editable: true,
    entity_documents: emptyDocuments(),
    graph_hash: 'graph',
    initial_scope: 'workflow:main',
    pinned,
    project,
  };
}

test('external workflow aliases keep local identity without exposing target bindings', () => {
  const root = testProject() as unknown as CanonicalProject;
  root.externals = [{alias: 'publisher.tool'}];
  root.subroutine.workflows.push({
    external: {alias: 'publisher.tool', workflow: graphId('main')},
    id: graphId('borrowed'),
    name: 'Borrowed',
  });
  const pinned = testProject() as unknown as CanonicalProject;
  pinned.package = 'publisher.tool';
  pinned.subroutine.profile_parameters = [
    {id: agentProfileId('agent'), name: 'Agent'},
  ];
  pinned.workflow.profile_arguments = {
    [agentProfileId('agent')]: agentProfileId('builder'),
  };
  pinned.workflow.profiles = [testProfile('builder', 'Builder')];
  const snapshot = snapshotOf(root, {'publisher.tool': pinned});
  const page = entityPropertyPage(
    snapshot,
    snapshotCanvasGraphs(snapshot)['publisher.tool/workflow:main'],
    {entity: 'workflows', id: graphId('main__borrowed'), subroutine: 'main'},
    'Workflow borrowed',
  );

  assert.equal(page?.name, 'Borrowed');
  assert.deepEqual(page?.fields, [
    {label: 'external', value: 'publisher.tool / main'},
  ]);
  assert.deepEqual(page?.resources, []);
  assert.equal(page?.resourcesWritable, false);
  assert.deepEqual(page?.entries, []);
});

test('entity property pages use semantic titles', () => {
  const value = testProject() as unknown as CanonicalProject;
  const graph = subroutineInProject(value, graphId('main'))!;
  graph.nodes.push({
    id: nodeId('call_workflow'),
    kind: 'workflow_call',
    name: 'Call workflow',
    operation: {target: graphId('main')},
  });
  const snapshot = snapshotOf(value);
  const scopes = snapshotCanvasGraphs(snapshot);
  const subroutine = scopes.main;
  const workflow = scopes['workflow:main'];

  const pages = [
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'subroutines',
        id: graphId('main'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      workflow,
      {
        entity: 'workflows',
        id: graphId('main'),
        subroutine: 'main',
      },
      'Workflow main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'edges',
        id: edgeId('profile_analyze'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'nodes',
        id: nodeId('optimize'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'features',
        id: featureId('remaining_iterations'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'profiles',
        id: agentProfileId('default'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'sessions',
        id: agentSessionId('optimize'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'nodes',
        id: nodeId('call_implement'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
    entityPropertyPage(
      snapshot,
      subroutine,
      {
        entity: 'nodes',
        id: nodeId('call_workflow'),
        subroutine: 'main',
      },
      'Subroutine main',
    ),
  ];

  assert.deepEqual(
    pages.map(page => page?.title),
    [
      'Subroutine Definition',
      'Workflow Definition',
      'Edge',
      'Node',
      'Feature',
      'Profile',
      'Session',
      'Subroutine Call',
      'Workflow Call',
    ],
  );
  assert.equal(
    pages[0]?.entries.some(({entity}) => entity === 'nodes'),
    true,
  );
  assert.deepEqual(
    pages[1]?.entries.map(({entity, id}) => ({entity, id})),
    [{entity: 'nodes', id: 'subroutine'}],
  );
  assert.deepEqual(
    pages.slice(0, 4).map(page => ({
      idWritable: page?.idWritable,
      nameWritable: page?.nameWritable,
    })),
    [
      {idWritable: false, nameWritable: true},
      {idWritable: false, nameWritable: false},
      {idWritable: false, nameWritable: true},
      {idWritable: true, nameWritable: true},
    ],
  );
  assert.equal(pages[2]?.constraintsWritable, true);
  snapshot.editable = false;
  const readOnly = entityPropertyPage(
    snapshot,
    subroutine,
    {
      entity: 'nodes',
      id: nodeId('optimize'),
      subroutine: 'main',
    },
    'Subroutine main',
  );
  assert.deepEqual(
    {idWritable: readOnly?.idWritable, nameWritable: readOnly?.nameWritable},
    {idWritable: false, nameWritable: false},
  );
  const readOnlyEdge = entityPropertyPage(
    snapshot,
    subroutine,
    {
      entity: 'edges',
      id: edgeId('profile_analyze'),
      subroutine: 'main',
    },
    'Subroutine main',
  );
  assert.equal(readOnlyEdge?.constraintsWritable, false);
  assert.equal(
    pages.slice(2, 7).every(page => page?.entries.length === 0),
    true,
  );
  assert.deepEqual(
    pages.slice(7).map(page =>
      page?.entries.map(({children, entity, id, meta, removal, target}) => ({
        children,
        entity,
        id,
        meta,
        removal,
        target,
      })),
    ),
    [
      [
        {
          children: [],
          entity: 'subroutines',
          id: 'main__implement',
          meta: ['target', 'visible here'],
          removal: undefined,
          target: {
            inspection: {
              entity: 'subroutines',
              id: 'main__implement',
              subroutine: 'main',
            },
            scope: 'main__implement',
          },
        },
      ],
      [
        {
          children: [],
          entity: 'workflows',
          id: 'main',
          meta: ['target', 'visible here'],
          removal: undefined,
          target: {
            inspection: {
              entity: 'workflows',
              id: 'main',
              subroutine: 'main',
              workflow: 'main',
            },
            scope: 'workflow:main',
          },
        },
      ],
    ],
  );
});

test('entity property pages preserve node documents and workflow-owned settings', () => {
  const value = testProject() as unknown as CanonicalProject;
  const target = subroutineInProject(value, graphId('main'))!;
  target.profile_parameters = [{id: agentProfileId('agent'), name: 'Agent'}];
  target.session_parameters = [
    {
      id: agentSessionId('conversation'),
      name: 'Conversation',
    },
  ];
  const workflow = value.workflow;
  workflow.profile_arguments = {
    [agentProfileId('agent')]: agentProfileId('builder'),
  };
  workflow.session_arguments = {
    [agentSessionId('conversation')]: agentSessionId('history'),
  };
  workflow.profiles = [testProfile('builder', 'Workflow builder')];
  workflow.sessions = [
    {id: agentSessionId('history'), name: 'History', persistent: false},
  ];

  const snapshot = snapshotOf(value);
  snapshot.entity_documents.nodes.main = {
    call_implement: {
      declaration: 'nodes/call_implement/__init__.py',
      implementation: 'nodes/call_implement/impl.py',
    },
  };
  snapshot.entity_documents.edges.main = {
    plan_implement: {
      declaration: 'edges/plan_implement/__init__.py',
      visit: {
        declaration: 'nodes/call_implement/visit/plan_implement/__init__.py',
        implementation: 'nodes/call_implement/visit/plan_implement/impl.py',
      },
    },
  };
  snapshot.entity_documents.profiles['workflow:main'] = {
    builder: {
      declaration: 'workflows/main/profiles/builder/__init__.py',
      implementation: 'workflows/main/profiles/builder/impl.py',
    },
  };
  const scopes = snapshotCanvasGraphs(snapshot);
  const node = entityPropertyPage(
    snapshot,
    scopes.main,
    {
      entity: 'nodes',
      id: nodeId('call_implement'),
      subroutine: 'main',
    },
    'Subroutine main',
  )!;
  assert.deepEqual(node.documents, [
    {
      label: 'called implementation',
      path: 'src/demo/project/subroutines/main/subroutines/implement/impl.py',
    },
    {label: 'node declaration', path: 'nodes/call_implement/__init__.py'},
    {label: 'node implementation', path: 'nodes/call_implement/impl.py'},
    {
      label: 'visit_plan_implement visit declaration',
      path: 'nodes/call_implement/visit/plan_implement/__init__.py',
    },
    {
      label: 'visit_plan_implement visit implementation',
      path: 'nodes/call_implement/visit/plan_implement/impl.py',
    },
  ]);

  const wrapper = entityPropertyPage(
    snapshot,
    scopes['workflow:main'],
    {
      entity: 'workflows',
      id: graphId('main'),
      subroutine: 'main',
      workflow: graphId('main'),
    },
    'Workflow main',
  )!;
  assert.deepEqual(
    wrapper.resources.map(({label, value}) => ({label, value})),
    [
      {label: 'profile agent', value: 'builder'},
      {label: 'session conversation', value: 'history'},
    ],
  );
  assert.equal(wrapper.resourcesWritable, true);
  const wrapperCall = entityPropertyPage(
    snapshot,
    scopes['workflow:main'],
    {
      entity: 'workflows',
      id: graphId('main'),
      subroutine: 'main',
      workflow: graphId('main'),
    },
    'Workflow main',
    {entity: 'nodes', id: nodeId('subroutine')},
  )!;
  assert.equal(wrapperCall.title, 'Subroutine Call');
  assert.equal(wrapperCall.kind, 'subroutine_call');
  assert.equal(wrapperCall.id, 'subroutine');
  assert.equal(wrapperCall.idWritable, false);
  assert.equal(wrapperCall.nameWritable, false);
  assert.deepEqual(wrapperCall.fields, [{label: 'calls', value: 'main'}]);
  assert.deepEqual(
    wrapperCall.entries.map(({entity, id, meta, removal, target}) => ({
      entity,
      id,
      meta,
      removal,
      target,
    })),
    [
      {
        entity: 'subroutines',
        id: 'main',
        meta: ['target', 'visible here'],
        removal: undefined,
        target: {
          inspection: {entity: 'subroutines', id: 'main', subroutine: 'main'},
          scope: 'main',
        },
      },
    ],
  );

  const profile = entityPropertyPage(
    snapshot,
    scopes['workflow:main'],
    {
      entity: 'profiles',
      id: agentProfileId('builder'),
      subroutine: 'main',
      workflow: graphId('main'),
    },
    'Workflow main',
  )!;
  assert.equal(profile.name, 'Workflow builder');
  assert.equal(profile.idWritable, false);
  assert.equal(profile.nameWritable, true);
  assert.equal(profile.settingsWritable, true);
  assert.deepEqual(profile.documents, [
    {
      label: 'profile declaration',
      path: 'workflows/main/profiles/builder/__init__.py',
    },
    {
      label: 'profile implementation',
      path: 'workflows/main/profiles/builder/impl.py',
    },
  ]);
  const session = entityPropertyPage(
    snapshot,
    scopes['workflow:main'],
    {
      entity: 'sessions',
      id: agentSessionId('history'),
      subroutine: 'main',
      workflow: graphId('main'),
    },
    'Workflow main',
  )!;
  assert.equal(session.idWritable, false);
  assert.equal(session.nameWritable, true);
});

test('enum properties show the selected value', () => {
  const enumProject = structuredClone(project);
  const graph = subroutineInProject(enumProject, 'main') as unknown as Record<
    string,
    unknown
  >;
  graph.features = [
    {
      description: 'Where the attempt is in its lifecycle.',
      id: 'status',
      kind: 'enum',
      label: 'Status',
      values: ['pending', 'done'],
    },
  ];
  graph.edges = [
    {
      conditions: [
        {feature_id: 'status', observation: 'equal', value: 'pending'},
      ],
      effects: [{feature_id: 'status', observation: 'equal', value: 'done'}],
      id: 'profile_analyze',
      name: 'Finish',
      source: 'profile',
      target: 'prepare_optimization',
    },
  ];

  assert.deepEqual(
    entityDetails(enumProject, 'main', 'edges', 'profile_analyze')?.constraints,
    [
      {
        collection: 'conditions',
        expression: 'status=pending',
        feature: 'status',
      },
      {collection: 'effects', expression: 'status:=done', feature: 'status'},
    ],
  );
});

test("edge constraints use the language's feature-id notation", () => {
  assert.deepEqual(
    [
      constraintNotation('conditions', 'ready', 'boolean', 'positive'),
      constraintNotation('conditions', 'ready', 'boolean', 'negative'),
      constraintNotation(
        'conditions',
        'num_iterations',
        'integer',
        'equal_zero',
      ),
      constraintNotation(
        'conditions',
        'num_iterations',
        'integer',
        'greater_zero',
      ),
      constraintNotation('conditions', 'status', 'enum', 'equal', 'pending'),
      constraintNotation('effects', 'ready', 'boolean', 'positive'),
      constraintNotation('effects', 'ready', 'boolean', 'negative'),
      constraintNotation('effects', 'ready', 'boolean', 'unchanged'),
      constraintNotation('effects', 'ready', 'boolean', 'unconstrained'),
      constraintNotation('effects', 'num_iterations', 'integer', 'increases'),
      constraintNotation('effects', 'num_iterations', 'integer', 'decreases'),
      constraintNotation('effects', 'num_iterations', 'integer', 'unchanged'),
      constraintNotation(
        'effects',
        'num_iterations',
        'integer',
        'unconstrained',
      ),
      constraintNotation('effects', 'status', 'enum', 'equal', 'done'),
      constraintNotation('effects', 'status', 'enum', 'unconstrained'),
    ],
    [
      'ready',
      '¬ready',
      'num_iterations=0',
      'num_iterations>0',
      'status=pending',
      'ready:=⊤',
      'ready:=⊥',
      'ready=',
      'ready:?',
      'num_iterations↑',
      'num_iterations↓',
      'num_iterations=',
      'num_iterations?',
      'status:=done',
      'status?',
    ],
  );
});

test('agent and call resources become compatible property choices', () => {
  const bound = structuredClone(project);
  const caller = subroutineInProject(bound, 'main')!;
  const child = subroutineInProject(bound, 'main__implement')!;
  caller.sessions.push({id: 'scratch', name: 'Scratch', persistent: false});
  child.profile_parameters = [{id: 'worker', name: 'Worker'}];
  child.session_parameters = [
    {
      id: 'conversation',
      name: 'Conversation',
    },
  ];
  const call = caller.nodes.find(node => node.id === 'call_implement');
  assert.equal(call?.kind, 'subroutine_call');
  if (call?.kind !== 'subroutine_call') {
    return;
  }
  call.operation.profile_arguments = {worker: 'default'};
  call.operation.session_arguments = {conversation: 'plan'};
  caller.nodes.push({
    id: 'call_workflow',
    kind: 'workflow_call',
    name: 'Run workflow',
    operation: {target: 'main'},
  });
  const snapshot = {pinned: {}, project: bound} as unknown as ProjectGraphs;

  assert.deepEqual(nodeResourceFields(snapshot, 'main', 'optimize'), [
    {
      label: 'profile',
      options: ['default'],
      resource: 'profile',
      value: 'default',
    },
    {
      label: 'session',
      options: ['optimize', 'plan', 'scratch'],
      resource: 'session',
      value: 'optimize',
    },
  ]);
  assert.deepEqual(nodeResourceFields(snapshot, 'main', 'call_implement'), [
    {
      label: 'profile worker',
      options: ['default'],
      parameter: 'worker',
      resource: 'profile',
      value: 'default',
    },
    {
      label: 'session conversation',
      options: ['optimize', 'plan', 'scratch'],
      parameter: 'conversation',
      resource: 'session',
      value: 'plan',
    },
  ]);
  call.operation.target = 'missing';
  assert.deepEqual(nodeResourceFields(snapshot, 'main', 'call_implement'), [
    {
      label: 'profile worker',
      options: [],
      parameter: 'worker',
      resource: 'profile',
      value: 'default',
    },
    {
      label: 'session conversation',
      options: [],
      parameter: 'conversation',
      resource: 'session',
      value: 'plan',
    },
  ]);
  assert.deepEqual(nodeResourceFields(snapshot, 'main', 'call_workflow'), []);
});

test('resource updates are normalized against the same complete contract', () => {
  const bound = structuredClone(project);
  const caller = subroutineInProject(bound, 'main')!;
  const child = subroutineInProject(bound, 'main__implement')!;
  caller.sessions.push({id: 'scratch', name: 'Scratch', persistent: false});
  child.profile_parameters = [{id: 'worker', name: 'Worker'}];
  child.session_parameters = [{id: 'conversation', name: 'Conversation'}];
  const snapshot = {pinned: {}, project: bound} as unknown as ProjectGraphs;

  assert.deepEqual(
    normalizeNodeResources(snapshot, 'main', 'optimize', [
      {resource: 'profile', value: 'default'},
      {resource: 'session', value: 'plan'},
    ]),
    {kind: 'agent', profile: 'default', session: 'plan'},
  );

  assert.deepEqual(
    normalizeNodeResources(snapshot, 'main', 'call_implement', [
      {parameter: 'worker', resource: 'profile', value: 'default'},
      {parameter: 'conversation', resource: 'session', value: 'plan'},
    ]),
    {
      arguments: {
        profile_arguments: {worker: 'default'},
        session_arguments: {conversation: 'plan'},
      },
      kind: 'subroutine_call',
    },
  );

  assert.throws(
    () =>
      normalizeNodeResources(snapshot, 'main', 'optimize', [
        {resource: 'profile', value: 'default'},
        {resource: 'profile', value: 'default'},
        {resource: 'session', value: 'plan'},
      ]),
    /more than once/,
  );
  assert.deepEqual(
    normalizeNodeResources(snapshot, 'main', 'call_implement', [
      {parameter: 'worker', resource: 'profile', value: 'default'},
      {parameter: 'conversation', resource: 'session', value: 'scratch'},
    ]),
    {
      arguments: {
        profile_arguments: {worker: 'default'},
        session_arguments: {conversation: 'scratch'},
      },
      kind: 'subroutine_call',
    },
  );
  assert.throws(
    () =>
      normalizeNodeResources(snapshot, 'main', 'call_implement', [
        {parameter: 'worker', resource: 'profile', value: 'default'},
      ]),
    /not every required resource/,
  );
});

test('workflow boundaries use the same call fields with explicit resources', () => {
  const bound = structuredClone(project);
  const target = subroutineInProject(bound, 'main')!;
  const workflow = bound.workflow as LocalWorkflowDefinition;
  target.profile_parameters = [
    {id: 'generator', name: 'Generator'},
    {id: 'reviewer', name: 'Reviewer'},
  ];
  target.session_parameters = [
    {id: 'draft', name: 'Draft'},
    {id: 'review', name: 'Review'},
    {id: 'scratch', name: 'Scratch'},
  ];
  workflow.profile_arguments = {generator: 'builder', reviewer: 'critic'};
  workflow.session_arguments = {
    draft: 'history',
    review: 'archive',
    scratch: 'temporary',
  };
  workflow.profiles = [
    testProfile('builder', 'Builder'),
    testProfile('critic', 'Critic', 'claude'),
  ];
  workflow.sessions = [
    {id: 'history', name: 'History', persistent: true},
    {id: 'archive', name: 'Archive', persistent: true},
    {id: 'temporary', name: 'Temporary', persistent: false},
  ];

  assert.deepEqual(workflowResourceFields(target, workflow), [
    {
      label: 'profile generator',
      options: ['builder', 'critic'],
      parameter: 'generator',
      resource: 'profile',
      value: 'builder',
    },
    {
      label: 'profile reviewer',
      options: ['builder', 'critic'],
      parameter: 'reviewer',
      resource: 'profile',
      value: 'critic',
    },
    {
      label: 'session draft',
      options: ['history', 'archive', 'temporary'],
      parameter: 'draft',
      resource: 'session',
      value: 'history',
    },
    {
      label: 'session review',
      options: ['history', 'archive', 'temporary'],
      parameter: 'review',
      resource: 'session',
      value: 'archive',
    },
    {
      label: 'session scratch',
      options: ['history', 'archive', 'temporary'],
      parameter: 'scratch',
      resource: 'session',
      value: 'temporary',
    },
  ]);
  assert.deepEqual(
    normalizeWorkflowResources(target, workflow, [
      {parameter: 'generator', resource: 'profile', value: 'critic'},
      {parameter: 'reviewer', resource: 'profile', value: 'builder'},
      {parameter: 'draft', resource: 'session', value: 'archive'},
      {parameter: 'review', resource: 'session', value: 'history'},
      {parameter: 'scratch', resource: 'session', value: 'temporary'},
    ]),
    {
      profile_arguments: {generator: 'critic', reviewer: 'builder'},
      session_arguments: {
        draft: 'archive',
        review: 'history',
        scratch: 'temporary',
      },
    },
  );
  assert.throws(
    () =>
      normalizeWorkflowResources(target, workflow, [
        {parameter: 'generator', resource: 'profile', value: 'builder'},
        {parameter: 'reviewer', resource: 'profile', value: 'critic'},
        {parameter: 'draft', resource: 'session', value: 'history'},
        {parameter: 'review', resource: 'session', value: 'archive'},
        {parameter: 'scratch', resource: 'session', value: 'missing'},
      ]),
    /not valid/,
  );
  assert.deepEqual(workflowResourceDetails(workflow, 'profiles', 'critic'), {
    fields: [],
    idEditable: false,
    kind: 'profile',
    name: 'Critic',
    nameEditable: true,
    profile: {
      options: {model: null, reasoning_effort: null, extra_args: []},
      provider: 'claude',
    },
  });
  assert.deepEqual(workflowResourceDetails(workflow, 'sessions', 'history'), {
    fields: [],
    idEditable: false,
    kind: 'session',
    name: 'History',
    nameEditable: true,
    persistent: true,
  });
});

test("an entity's properties come from the graph, and name is not id", () => {
  assert.deepEqual(
    entityDetails(project, 'main', 'features', 'remaining_iterations'),
    {
      fields: [
        {label: 'kind', value: 'integer'},
        {label: 'description', value: 'How many attempts remain.'},
      ],
      idEditable: true,
      kind: 'feature',
      name: 'Remaining iterations',
      nameEditable: true,
    },
  );
  assert.deepEqual(entityDetails(project, 'main', 'profiles', 'default'), {
    fields: [],
    idEditable: true,
    kind: 'profile',
    name: 'Default',
    nameEditable: true,
    profile: {
      options: {model: null, reasoning_effort: null, extra_args: []},
      provider: 'codex',
    },
  });
  assert.deepEqual(entityDetails(project, 'main', 'sessions', 'optimize'), {
    fields: [],
    idEditable: true,
    kind: 'session',
    name: 'Optimize',
    nameEditable: true,
    persistent: true,
  });

  const parameters = structuredClone(project);
  const parameterGraph = subroutineInProject(parameters, 'main')!;
  parameterGraph.profile_parameters = [{id: 'reviewer', name: 'Reviewer'}];
  parameterGraph.session_parameters = [
    {
      id: 'conversation',
      name: 'Conversation',
    },
  ];
  assert.equal(
    entityDetails(parameters, 'main', 'profile_parameters', 'reviewer')?.kind,
    'profile parameter',
  );
  assert.equal(
    entityDetails(parameters, 'main', 'session_parameters', 'conversation')
      ?.persistent,
    undefined,
  );

  const rootSubroutine = entityDetails(project, 'main', 'subroutines', 'main')!;
  assert.equal(rootSubroutine.name, 'Main');
  assert.equal(rootSubroutine.idEditable, false);
  assert.equal(rootSubroutine.nameEditable, true);
  const rootWorkflow = entityDetails(project, 'main', 'workflows', 'main')!;
  assert.equal(rootWorkflow.idEditable, false);
  assert.equal(rootWorkflow.nameEditable, false);
  assert.deepEqual(rootWorkflow.fields, [{label: 'subroutine', value: 'main'}]);

  const edge = entityDetails(project, 'main', 'edges', 'profile_analyze')!;
  assert.equal(edge.kind, 'edge');
  assert.equal(edge.idEditable, false);
  assert.equal(edge.nameEditable, true);
  assert.notEqual(
    edge.name,
    'profile_analyze',
    'the label is prose, not the identifier',
  );
  assert.deepEqual(edge.fields.slice(0, 2), [
    {label: 'source', value: 'profile'},
    {label: 'target', value: 'prepare_optimization'},
  ]);
  // The edge properties show authored constraints, not semantic defaults.
  assert.deepEqual(edge.constraints, [
    {
      collection: 'conditions',
      expression: 'remaining_iterations>0',
      feature: 'remaining_iterations',
    },
  ]);
  assert.deepEqual(
    entityDetails(project, 'main', 'edges', 'enter__profile')?.constraints,
    [],
  );

  const explicitUnchanged = structuredClone(project);
  const unchangedGraph = subroutineInProject(
    explicitUnchanged,
    'main',
  ) as unknown as Record<string, unknown>;
  const unchangedEdge = (
    unchangedGraph.edges as Array<Record<string, unknown>>
  ).find(item => item.id === 'profile_analyze')!;
  unchangedEdge.effects = [
    {feature_id: 'remaining_iterations', observation: 'unchanged'},
  ];
  assert.deepEqual(
    entityDetails(explicitUnchanged, 'main', 'edges', 'profile_analyze')
      ?.constraints,
    [
      {
        collection: 'conditions',
        expression: 'remaining_iterations>0',
        feature: 'remaining_iterations',
      },
      {
        collection: 'effects',
        expression: 'remaining_iterations=',
        feature: 'remaining_iterations',
      },
    ],
  );

  // Resource bindings are editable controls, not duplicate read-only rows.
  const agent = entityDetails(project, 'main', 'nodes', 'optimize')!;
  assert.equal(agent.kind, 'agent');
  assert.deepEqual(agent.fields, []);

  // A call node says what it calls, which is how the panel explains an enterable node.
  // This one is a subroutine: its child is defined in this project, so it runs in the
  // same process. A `workflow` node reads identically here and differs only in that.
  const nested = entityDetails(project, 'main', 'nodes', 'call_implement')!;
  assert.equal(nested.kind, 'subroutine_call');
  assert.deepEqual(nested.fields, [{label: 'calls', value: 'main__implement'}]);
  const bound = structuredClone(project);
  const boundGraph = subroutineInProject(bound, 'main')!;
  const boundCall = boundGraph.nodes.find(
    node => node.id === 'call_implement',
  )!;
  boundCall.operation = {
    profile_arguments: {agent: 'default'},
    session_arguments: {conversation: 'plan'},
    target: 'main__implement',
  };
  assert.deepEqual(
    entityDetails(bound, 'main', 'nodes', 'call_implement')?.fields,
    [{label: 'calls', value: 'main__implement'}],
  );

  const external = {
    subroutine: {
      edges: [],
      features: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      id: 'main_body',
      name: 'Main body',
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      workflows: [
        {
          id: 'helper',
          name: 'Helper',
          external: {alias: 'helper_canary', workflow: 'main'},
        },
      ],
      subroutines: [],
      nodes: [
        {
          id: 'call_helper',
          kind: 'workflow_call',
          name: 'Call helper',
          operation: {target: 'main_body__helper'},
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
  };
  const pinned = entityDetails(external, 'main_body', 'nodes', 'call_helper')!;
  assert.deepEqual(pinned.fields, [
    {label: 'calls', value: 'main_body__helper'},
    {label: 'external', value: 'helper_canary / main'},
  ]);
  assert.equal(
    entityDetails(external, 'main_body', 'workflows', 'main_body__helper')
      ?.idEditable,
    true,
  );
  assert.equal(
    entityDetails(external, 'main_body', 'workflows', 'main_body__helper')
      ?.nameEditable,
    true,
  );

  const local = {
    subroutine: {
      edges: [],
      features: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      id: 'main',
      name: 'Main',
      nodes: [],
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      subroutines: [
        {
          edges: [],
          features: [],
          profile_parameters: [],
          profiles: [],
          session_parameters: [],
          sessions: [],
          id: 'worker',
          name: 'Worker prose',
          nodes: [],
          ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
          subroutines: [],
          workflows: [],
        },
      ],
      workflows: [
        {
          subroutine: 'main__worker',
          profiles: [],
          sessions: [],
          profile_arguments: {},
          session_arguments: {},
        },
      ],
    },
    workflow: {
      subroutine: 'main',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
  };
  const wrapper = entityDetails(local, 'main', 'workflows', 'main__worker')!;
  assert.equal(wrapper.name, 'Worker prose');
  assert.equal(wrapper.idEditable, false);
  assert.equal(wrapper.nameEditable, false);
  assert.deepEqual(wrapper.fields, [
    {label: 'subroutine', value: 'main__worker'},
  ]);
  assert.equal(
    entityDetails(local, 'main', 'subroutines', 'main__worker')?.idEditable,
    true,
  );

  assert.equal(entityDetails(project, 'main', 'nodes', 'nope'), undefined);
});

test('parameter pages resolve to the concrete resources bound through the call paths', () => {
  const value = testProject() as unknown as CanonicalProject;
  const main = subroutineInProject(value, graphId('main'))!;
  main.profile_parameters = [{id: agentProfileId('agent'), name: 'Agent'}];
  main.session_parameters = [
    {id: agentSessionId('conversation'), name: 'Conversation'},
  ];
  // The nested subroutine declares its own parameter, which main passes its parameter on to.
  const implement = subroutineInProject(value, graphId('main__implement'))!;
  implement.profile_parameters = [
    {id: agentProfileId('worker'), name: 'Worker'},
  ];
  const call = main.nodes.find(node => node.id === 'call_implement')!;
  call.operation = {
    profile_arguments: {[agentProfileId('worker')]: agentProfileId('agent')},
    session_arguments: {},
    target: graphId('main__implement'),
  };
  const workflow = value.workflow;
  workflow.profile_arguments = {
    [agentProfileId('agent')]: agentProfileId('builder'),
  };
  workflow.session_arguments = {
    [agentSessionId('conversation')]: agentSessionId('history'),
  };
  workflow.profiles = [
    {
      ...testProfile('builder', 'Builder', 'claude'),
      options: {
        model: 'claude-fable-5-1',
        reasoning_effort: 'high',
        extra_args: ['--tools', 'Read,Grep,Glob,WebSearch,WebFetch'],
      },
    },
  ];
  workflow.sessions = [
    {id: agentSessionId('history'), name: 'History', persistent: true},
  ];

  // Direct: main's parameter is bound by the workflow entry.
  const direct = resolveParameter(value, graphId('main'), 'profile', 'agent');
  assert.deepEqual(direct.map(bindingSummary), [
    'workflow main → builder (claude · claude-fable-5-1 · high)',
  ]);
  assert.deepEqual(direct[0].profile?.options.extra_args, [
    '--tools',
    'Read,Grep,Glob,WebSearch,WebFetch',
  ]);
  // Chained: implement's parameter is bound to main's parameter, which resolves further up.
  const chained = resolveParameter(
    value,
    graphId('main__implement'),
    'profile',
    'worker',
  );
  assert.deepEqual(
    chained.map(({owner, id}) => [owner.kind, owner.id, id]),
    [['workflow', 'main', 'builder']],
  );
  assert.deepEqual(
    resolveParameter(value, graphId('main'), 'session', 'conversation').map(
      bindingSummary,
    ),
    ['workflow main → history (persistent)'],
  );
  // Bound by nobody inside the project.
  implement.session_parameters = [
    {id: agentSessionId('unbound'), name: 'Unbound'},
  ];
  assert.deepEqual(
    resolveParameter(value, graphId('main__implement'), 'session', 'unbound'),
    [],
  );

  const snapshot = snapshotOf(value);
  snapshot.entity_documents.profiles['workflow:main'] = {
    builder: {declaration: 'workflows/main/profiles/builder/__init__.py'},
  };
  const scopes = snapshotCanvasGraphs(snapshot);
  const page = entityPropertyPage(
    snapshot,
    scopes['main/implement'] ?? scopes.main,
    {
      entity: 'profile_parameters',
      id: agentProfileId('worker'),
      subroutine: 'main__implement',
    },
    'Subroutine implement',
  )!;
  assert.deepEqual(page.fields, [
    {
      label: 'resolves to',
      value: 'workflow main → builder (claude · claude-fable-5-1 · high)',
    },
  ]);
  assert.equal(page.entries.length, 1);
  const [entry] = page.entries;
  assert.equal(entry.entity, 'profiles');
  assert.equal(entry.id, 'builder');
  assert.deepEqual(entry.meta, [
    'resolves to',
    'claude · claude-fable-5-1 · high',
  ]);
  assert.equal(
    entry.declaration,
    'workflows/main/profiles/builder/__init__.py',
  );
  assert.deepEqual(entry.target, {
    inspection: {
      entity: 'profiles',
      id: 'builder',
      subroutine: 'main',
      workflow: 'main',
    },
    scope: 'workflow:main',
    selection: {entity: 'nodes', id: 'subroutine'},
  });

  const unbound = entityPropertyPage(
    snapshot,
    scopes.main,
    {
      entity: 'session_parameters',
      id: agentSessionId('unbound'),
      subroutine: 'main__implement',
    },
    'Subroutine implement',
  )!;
  assert.deepEqual(unbound.fields, [
    {
      label: 'resolves to',
      value:
        'nothing in this project; a caller outside it binds this parameter',
    },
  ]);
  assert.deepEqual(unbound.entries, []);
});

test('a profile page carries provider arguments', () => {
  const value = testProject() as unknown as CanonicalProject;
  const main = subroutineInProject(value, graphId('main'))!;
  main.profiles = [
    {
      ...testProfile('default', 'Default', 'claude'),
      options: {
        model: null,
        reasoning_effort: null,
        extra_args: ['--tools', 'Read,Grep,Glob,WebSearch,WebFetch'],
      },
    },
  ];
  const details = entityDetails(value, 'main', 'profiles', 'default')!;
  assert.deepEqual(details.profile?.options.extra_args, [
    '--tools',
    'Read,Grep,Glob,WebSearch,WebFetch',
  ]);
  assert.deepEqual(
    entityDetails(testProject(), 'main', 'profiles', 'default')!.profile
      ?.options.extra_args,
    [],
  );
});
