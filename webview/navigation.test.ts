/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {graphId} from '../model/identifiers';
import type {CanonicalProject} from '../model/project';
import type {ProjectSnapshot} from '../model/snapshot';
import {testProfile, testProject} from '../src/fixtures';
import {
  calledDefinitionTarget,
  definitionComponentEntries,
  definitionTarget,
  navigationPage,
  removalNavigationEntry,
  terminationNavigation,
} from './navigation';
import {entityPropertyPage} from './propertyData';
import type {DefinitionTermination} from '../model/termination';
import {activeWorkflowScope, snapshotCanvasGraphs} from './subroutineGraphs';

function documents(): ProjectSnapshot['entity_documents'] {
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

function snapshot(
  project: CanonicalProject,
  pinned: Record<string, CanonicalProject> = {},
): ProjectSnapshot {
  return {
    checked: false,
    diagnostic_count: 0,
    editable: true,
    entity_documents: documents(),
    graph_hash: 'graph',
    initial_scope: `workflow:${project.subroutine.id}`,
    pinned,
    project,
  };
}

function project(): CanonicalProject {
  return testProject() as unknown as CanonicalProject;
}

test('direct call navigation refuses inaccessible and ambiguous definitions', () => {
  const root = project();
  const child = root.subroutine.subroutines[0];
  const privateChild = structuredClone(child);
  privateChild.id = graphId('private');
  privateChild.subroutines = [];
  child.subroutines.push(privateChild);
  const call = root.subroutine.nodes.find(({id}) => id === 'call_implement')!;
  assert.equal(call.kind, 'subroutine_call');
  assert.ok(call.operation);
  call.operation.target = graphId('main__implement__private');
  let current = snapshot(root);
  let graph = snapshotCanvasGraphs(current).main;
  let node = graph.nodes.find(({id}) => id === call.id)!;
  assert.equal(calledDefinitionTarget(current, graph, node), undefined);
  assert.equal(node.data.definition, undefined);

  call.operation.target = graphId('main__implement');
  root.subroutine.subroutines.push(structuredClone(child));
  current = snapshot(root);
  graph = snapshotCanvasGraphs(current).main!;
  node = graph.nodes.find(({id}) => id === call.id)!;
  assert.equal(calledDefinitionTarget(current, graph, node), undefined);
  assert.equal(node.data.definition, undefined);
});

test('canvas history restores the workflow environment around nested workflows', () => {
  const root = project();
  root.subroutine.workflows.push({
    subroutine: graphId('main__implement'),
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  });
  const graphs = snapshotCanvasGraphs(snapshot(root));
  const history = [
    'workflow:main',
    'main',
    'workflow:main__implement',
    'main__implement',
  ];
  assert.deepEqual(activeWorkflowScope(graphs, history, 1), {
    key: 'workflow:main',
    scope: graphs['workflow:main']?.scope,
  });
  assert.deepEqual(activeWorkflowScope(graphs, history, 3), {
    key: 'workflow:main__implement',
    scope: graphs['workflow:main__implement']?.scope,
  });
});

test('status navigation preserves root and pinned verification context', () => {
  const root = project();
  const current = snapshot(root);
  current.checked = true;
  current.diagnostic_count = 2;
  current.graph_hash = root.generated_from;
  assert.deepEqual(navigationPage(current, 'main', 'status'), {
    category: 'status',
    context: 'Subroutine main',
    status: {
      checked: true,
      diagnosticCount: 2,
      graphHash: root.generated_from,
      location: '/',
      pinned: false,
      stale: false,
    },
    title: 'Status',
    termination: {
      state: {status: 'unavailable', reason: 'Analysis has not run yet.'},
      entries: [],
    },
  });

  const pinned = project();
  pinned.package = 'publisher.tool';
  const external = snapshot(root, {'publisher.tool': pinned});
  assert.deepEqual(navigationPage(external, 'publisher.tool/main', 'status'), {
    category: 'status',
    context: 'Subroutine publisher.tool/main',
    status: {
      checked: false,
      diagnosticCount: 0,
      graphHash: 'graph',
      location: '/publisher/tool',
      pinned: true,
      stale: true,
    },
    title: 'Status',
    termination: {
      state: {status: 'unavailable', reason: 'Analysis has not run yet.'},
      entries: [],
    },
  });
});

test('termination links reuse scoped entity navigation without deletion actions', () => {
  const root = project();
  const current = snapshot(root, {pin: project()});
  const definition: DefinitionTermination = {
    status: 'not_certified',
    local_status: 'not_certified',
    reason: 'Residual cycles remain.',
    memory_states: 4,
    rules: 5,
    dependencies: [{scope: 'main__implement', node: 'call_implement'}],
    edges: {iteration_consumed: 'remaining'},
    regions: [
      {
        id: '0',
        nodes: ['profile', 'consume_iteration'],
        edges: ['iteration_consumed'],
        witnesses: [
          {
            feature: 'remaining_iterations',
            expression: 'remaining_iterations↓',
            edges: ['iteration_consumed'],
            opposing_edges: [],
          },
        ],
        cycle: [
          {
            node: 'consume_iteration',
            values: ['remaining_iterations>0'],
            edge: 'iteration_consumed',
          },
        ],
      },
    ],
  };
  current.termination = {
    status: 'ready',
    report: {
      projects: {'': 'root', pin: 'pin'},
      definitions: {
        main: definition,
        'pin/main': {...definition, dependencies: []},
        main__implement: {
          ...definition,
          status: 'certified',
          local_status: 'certified',
          dependencies: [],
          regions: [],
        },
      },
    },
  };
  const analysis = terminationNavigation(current, 'main');
  const edge = analysis.entries.find(({entity}) => entity === 'edges');
  assert.equal(edge?.target?.scope, 'main');
  assert.equal(edge?.target?.inspection?.entity, 'edges');
  assert.equal(edge?.target?.selection?.id, 'iteration_consumed');
  assert.equal(
    analysis.entries.find(({entity}) => entity === 'features')?.target
      ?.inspection?.id,
    'remaining_iterations',
  );
  const dependency = analysis.entries.find(({key}) =>
    key.startsWith('termination/dependency:'),
  );
  assert.equal(dependency?.target?.scope, 'main__implement');
  assert.deepEqual(dependency?.meta, ['Certified', 'called by call_implement']);
  assert.ok(
    analysis.entries.every(
      ({removal, children}) => removal === undefined && children.length === 0,
    ),
  );
  const pinned = terminationNavigation(current, 'pin/main');
  assert.ok(pinned.entries.every(({target}) => target?.scope === 'pin/main'));
  const graph = snapshotCanvasGraphs(current).main;
  const target = definitionTarget(current, graph)!;
  const page = entityPropertyPage(
    current,
    graph,
    target.inspection!,
    'Subroutine main',
  );
  assert.deepEqual(
    page?.termination,
    navigationPage(current, 'main', 'status').termination,
  );
});

test('definition navigation keeps root and pin duplicate identities distinct', () => {
  const root = project();
  root.externals = [{alias: 'publisher.tool'}];
  root.sources = [
    ...(root.sources as unknown[]),
    {path: 'src/demo/project/subroutines/main/__init__.py'},
  ];
  const pinned = project();
  pinned.package = 'publisher.tool';
  pinned.sources = [{path: 'src/publisher/tool/subroutines/main/__init__.py'}];
  const current = snapshot(root, {'publisher.tool': pinned});

  const definitions = navigationPage(current, 'main', 'subroutines').entries;
  const local = definitions.find(({key}) => key === 'subroutine:main');
  const localNested = definitions.find(
    ({key}) => key === 'subroutine:main__implement',
  );
  const external = definitions.find(
    ({key}) => key === 'publisher.tool/subroutine:main',
  );
  const externalNested = definitions.find(
    ({key}) => key === 'publisher.tool/subroutine:main__implement',
  );
  assert.ok(local);
  assert.ok(localNested);
  assert.ok(external);
  assert.ok(externalNested);
  assert.notEqual(local.key, external.key);
  assert.deepEqual(local.removal, {
    entity: 'subroutines',
    id: 'main',
    subroutine: 'main',
  });
  assert.deepEqual(localNested.removal, {
    entity: 'subroutines',
    id: 'main__implement',
    subroutine: 'main',
  });
  assert.deepEqual(external.removal, {
    entity: 'subroutines',
    id: 'main',
    subroutine: 'publisher.tool/main',
  });
  assert.deepEqual(externalNested.removal, {
    entity: 'subroutines',
    id: 'main__implement',
    subroutine: 'publisher.tool/main',
  });
  assert.deepEqual(
    externalNested.children.find(({id}) => id === 'call_implement')?.removal,
    {
      entity: 'nodes',
      id: 'call_implement',
      subroutine: 'publisher.tool/main',
    },
  );
  assert.deepEqual(local.scope, ['demo/project']);
  assert.deepEqual(external.scope, ['external/publisher/tool']);
  assert.equal(
    local.declaration,
    'src/demo/project/subroutines/main/__init__.py',
  );
  assert.equal(
    external.declaration,
    'external/publisher/tool/src/publisher/tool/subroutines/main/__init__.py',
  );
  assert.deepEqual(local.target, {
    inspection: {entity: 'subroutines', id: 'main', subroutine: 'main'},
    scope: 'main',
  });
  assert.deepEqual(external.target, {
    inspection: {
      entity: 'subroutines',
      id: 'main',
      subroutine: 'publisher.tool/main',
    },
    scope: 'publisher.tool/main',
  });

  const pinnedComponents = definitionComponentEntries(
    current,
    snapshotCanvasGraphs(current)['publisher.tool/main'],
    {
      entity: 'subroutines',
      id: graphId('main'),
      subroutine: 'publisher.tool/main',
    },
  );
  assert.deepEqual(
    pinnedComponents.find(
      ({entity, id}) => entity === 'nodes' && id === 'profile',
    )?.removal,
    {entity: 'nodes', id: 'profile', subroutine: 'publisher.tool/main'},
  );
  assert.deepEqual(
    pinnedComponents.find(
      ({entity, id}) => entity === 'edges' && id === 'profile_analyze',
    )?.removal,
    {entity: 'edges', id: 'profile_analyze', subroutine: 'publisher.tool/main'},
  );
  assert.deepEqual(
    pinnedComponents.find(
      ({entity, id}) => entity === 'profiles' && id === 'default',
    )?.removal,
    {entity: 'profiles', id: 'default', subroutine: 'publisher.tool/main'},
  );
});

test('same-id subroutine and workflow definitions list only their matching callers', () => {
  const root = project();
  const rootWorkflowDeclaration = 'src/demo/project/workflows/main/__init__.py';
  root.sources = [
    ...(root.sources as unknown[]),
    {path: rootWorkflowDeclaration},
  ];
  root.subroutine.workflows.push({
    subroutine: graphId('main__implement'),
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  });
  root.subroutine.nodes.push({
    id: 'run_implement',
    kind: 'workflow_call',
    name: 'Run implement',
    operation: {target: graphId('main__implement')},
  });
  const current = snapshot(root);
  const subroutineDeclaration =
    'src/demo/project/subroutines/main/nodes/call_implement/__init__.py';
  const workflowDeclaration =
    'src/demo/project/subroutines/main/nodes/run_implement/__init__.py';
  current.entity_documents.nodes.main = {
    call_implement: {declaration: subroutineDeclaration},
    run_implement: {declaration: workflowDeclaration},
  };

  const subroutine = navigationPage(
    current,
    'main',
    'subroutines',
  ).entries.find(({key}) => key === 'subroutine:main__implement');
  const rootSubroutine = navigationPage(
    current,
    'main',
    'subroutines',
  ).entries.find(({key}) => key === 'subroutine:main');
  const workflow = navigationPage(current, 'main', 'workflows').entries.find(
    ({key}) => key === 'workflow:main__implement',
  );
  const rootWorkflow = navigationPage(
    current,
    'main',
    'workflows',
  ).entries.find(({key}) => key === 'workflow:main');
  assert.ok(subroutine);
  assert.ok(rootSubroutine);
  assert.ok(workflow);
  assert.ok(rootWorkflow);
  assert.equal(workflow.target?.scope, 'workflow:main__implement');
  assert.equal(rootWorkflow.target?.scope, 'workflow:main');
  assert.deepEqual(rootWorkflow.removal, {
    entity: 'subroutines',
    id: 'main',
    subroutine: 'main',
  });
  assert.deepEqual(
    subroutine.children.map(entry => ({
      declaration: entry.declaration,
      entity: entry.entity,
      id: entry.id,
      meta: entry.meta,
      scope: entry.scope,
      target: entry.target,
    })),
    [
      {
        declaration: subroutineDeclaration,
        entity: 'nodes',
        id: 'call_implement',
        meta: ['in main'],
        scope: ['demo/project', 'main'],
        target: {
          selection: {entity: 'nodes', id: 'call_implement'},
          scope: 'main',
        },
      },
      {
        declaration: undefined,
        entity: 'workflows',
        id: 'main__implement',
        meta: ['in workflow:main__implement'],
        scope: ['demo/project', 'main', 'Workflows', 'main__implement'],
        target: {
          inspection: {
            entity: 'workflows',
            id: 'main__implement',
            subroutine: 'main',
            workflow: 'main__implement',
          },
          scope: 'workflow:main__implement',
          selection: {entity: 'nodes', id: 'subroutine'},
        },
      },
    ],
  );
  const rootCaller = rootSubroutine.children.find(
    ({entity, id}) => entity === 'workflows' && id === 'main',
  );
  assert.deepEqual(rootCaller, {
    children: [],
    declaration: rootWorkflowDeclaration,
    entity: 'workflows',
    id: 'main',
    key: 'subroutine:main/caller:workflow:main:subroutine',
    meta: ['in workflow:main'],
    scope: ['demo/project', 'Workflows', 'main'],
    target: {
      inspection: {
        entity: 'workflows',
        id: 'main',
        subroutine: 'main',
        workflow: 'main',
      },
      scope: 'workflow:main',
      selection: {entity: 'nodes', id: 'subroutine'},
    },
  });
  assert.equal(rootCaller.removal, undefined);
  assert.deepEqual(
    workflow.children.map(entry => ({
      declaration: entry.declaration,
      entity: entry.entity,
      id: entry.id,
      meta: entry.meta,
      scope: entry.scope,
      target: entry.target,
    })),
    [
      {
        declaration: workflowDeclaration,
        entity: 'nodes',
        id: 'run_implement',
        meta: ['in main'],
        scope: ['demo/project', 'main'],
        target: {
          selection: {entity: 'nodes', id: 'run_implement'},
          scope: 'main',
        },
      },
    ],
  );

  const graphs = snapshotCanvasGraphs(current);
  const caller = graphs.main;
  const call = caller?.nodes.find(({id}) => id === 'call_implement');
  assert.ok(caller);
  assert.ok(call);
  assert.deepEqual(
    calledDefinitionTarget(current, caller, call),
    subroutine.target,
  );
  assert.deepEqual(
    definitionTarget(current, graphs.main__implement),
    subroutine.target,
  );
  assert.deepEqual(
    definitionTarget(current, graphs['workflow:main__implement']),
    workflow.target,
  );
});

test('qualified subroutine calls and external workflow calls keep their definition owner', () => {
  const root = project();
  root.externals = [{alias: 'publisher.tool'}];
  root.subroutine.workflows.push({
    external: {alias: 'publisher.tool', workflow: graphId('main')},
    id: graphId('borrowed'),
    name: 'Borrowed',
  });
  root.subroutine.nodes.push(
    {
      id: 'call_pinned',
      kind: 'subroutine_call',
      name: 'Call pinned',
      operation: {
        profile_arguments: {},
        session_arguments: {},
        target: 'publisher.tool/main__implement',
      },
    },
    {
      id: 'run_borrowed',
      kind: 'workflow_call',
      name: 'Run borrowed',
      operation: {target: graphId('main__borrowed')},
    },
  );
  const pinned = project();
  pinned.package = 'publisher.tool';
  const current = snapshot(root, {'publisher.tool': pinned});
  current.entity_documents.nodes.main = {
    call_pinned: {
      declaration:
        'src/demo/project/subroutines/main/nodes/call_pinned/__init__.py',
    },
    run_borrowed: {
      declaration:
        'src/demo/project/subroutines/main/nodes/run_borrowed/__init__.py',
    },
  };

  const subroutines = navigationPage(current, 'main', 'subroutines').entries;
  const local = subroutines.find(
    ({key}) => key === 'subroutine:main__implement',
  );
  const external = subroutines.find(
    ({key}) => key === 'publisher.tool/subroutine:main__implement',
  );
  assert.ok(local);
  assert.ok(external);
  assert.equal(
    local.children.some(({id}) => id === 'call_pinned'),
    false,
  );
  assert.deepEqual(
    external.children.find(
      ({id, target}) => id === 'call_pinned' && target?.scope === 'main',
    )?.target,
    {
      selection: {entity: 'nodes', id: 'call_pinned'},
      scope: 'main',
    },
  );
  assert.deepEqual(
    external.children.find(({id}) => id === 'call_pinned')?.removal,
    {
      entity: 'nodes',
      id: 'call_pinned',
      subroutine: 'main',
    },
  );

  const workflows = navigationPage(current, 'main', 'workflows').entries;
  const binding = workflows.find(({key}) => key === 'workflow:main__borrowed');
  const pinnedWorkflow = workflows.find(
    ({key}) => key === 'publisher.tool/workflow:main',
  );
  assert.ok(binding);
  assert.ok(pinnedWorkflow);
  assert.deepEqual(
    binding.children.map(({id}) => id),
    ['run_borrowed'],
  );
  assert.deepEqual(binding.target, {
    inspection: {entity: 'workflows', id: 'main__borrowed', subroutine: 'main'},
    scope: 'publisher.tool/workflow:main',
  });
  const caller = snapshotCanvasGraphs(current).main;
  const call = caller?.nodes.find(({id}) => id === 'run_borrowed');
  assert.ok(caller);
  assert.ok(call);
  assert.deepEqual(
    calledDefinitionTarget(current, caller, call),
    binding.target,
  );
  assert.deepEqual(binding.removal, {
    entity: 'workflows',
    id: 'main__borrowed',
    subroutine: 'main',
  });
  assert.deepEqual(pinnedWorkflow.removal, {
    entity: 'subroutines',
    id: 'main',
    subroutine: 'publisher.tool/main',
  });
  assert.equal(
    pinnedWorkflow.children.some(({id}) => id === 'run_borrowed'),
    false,
  );
});

test('bindings are not declarations and an unavailable nested target falls back to its owner', () => {
  const root = project();
  const ownerDeclaration = 'src/demo/project/subroutines/main/__init__.py';
  root.externals = [{alias: 'missing.tool'}];
  root.sources = [
    {path: 'src/demo/project/workflows/main/bindings/__init__.py'},
    {path: ownerDeclaration},
  ];
  root.subroutine.workflows.push({
    external: {alias: 'missing.tool', workflow: graphId('main')},
    id: graphId('borrowed'),
    name: 'Borrowed',
  });

  const workflows = navigationPage(snapshot(root), 'main', 'workflows').entries;
  const rootWorkflow = workflows.find(({key}) => key === 'workflow:main');
  const unresolved = workflows.find(
    ({key}) => key === 'workflow:main__borrowed',
  );
  assert.ok(rootWorkflow);
  assert.ok(unresolved);
  assert.equal(rootWorkflow.declaration, undefined);
  assert.equal(unresolved.declaration, ownerDeclaration);
  assert.deepEqual(unresolved.target, {
    inspection: {entity: 'workflows', id: 'main__borrowed', subroutine: 'main'},
    scope: 'main',
  });
  assert.equal(unresolved.meta.includes('target unavailable'), true);
});

test('external owner folders distinguish a colliding alias and preserve nested scope', () => {
  const root = project();
  root.externals = [{alias: 'demo.project'}];

  const direct = project();
  direct.package = 'publisher.tool';
  direct.externals = [{alias: 'helper.tool'}];
  const nested = project();
  nested.package = 'helper.impl';
  const nestedDeclaration =
    'src/helper/impl/subroutines/main/subroutines/implement/__init__.py';
  nested.sources = [{path: nestedDeclaration}];

  const current = snapshot(root, {
    'demo.project': direct,
    'demo.project/helper.tool': nested,
  });
  const definitions = navigationPage(current, 'main', 'subroutines').entries;
  const local = definitions.find(({key}) => key === 'subroutine:main');
  const external = definitions.find(
    ({key}) => key === 'demo.project/subroutine:main',
  );
  const nestedChild = definitions.find(
    ({key}) => key === 'demo.project/helper.tool/subroutine:main__implement',
  );
  assert.ok(local);
  assert.ok(external);
  assert.ok(nestedChild);
  assert.deepEqual(local.scope, ['demo/project']);
  assert.deepEqual(external.scope, ['external/demo/project']);
  assert.deepEqual(nestedChild.scope, [
    'external/demo/project/external/helper/tool',
    'main',
  ]);
  assert.equal(
    nestedChild.declaration,
    `external/demo/project/external/helper/tool/${nestedDeclaration}`,
  );
  assert.deepEqual(nestedChild.target, {
    inspection: {
      entity: 'subroutines',
      id: 'main__implement',
      subroutine: 'demo.project/helper.tool/main',
    },
    scope: 'demo.project/helper.tool/main__implement',
  });
});

test("removal navigation qualifies a pinned node's scope and declaration", () => {
  const root = project();
  const pinned = project();
  pinned.package = 'publisher.tool';
  const current = snapshot(root, {'publisher.tool': pinned});
  const declaration =
    'external/publisher/tool/src/publisher/tool/subroutines/main/nodes/profile/__init__.py';
  current.entity_documents.nodes['publisher.tool/main'] = {
    profile: {declaration},
  };

  const entry = removalNavigationEntry(current, 'publisher.tool/main', {
    effect: 'delete',
    entity: 'nodes',
    id: 'profile',
    reasons: ['calls_deleted_target'],
    scope: [graphId('main')],
  });

  assert.equal(entry.key, 'publisher.tool/main/nodes:profile');
  assert.deepEqual(entry.scope, ['external/publisher/tool', 'main']);
  assert.equal(entry.declaration, declaration);
  assert.deepEqual(entry.target, {
    selection: {entity: 'nodes', id: 'profile'},
    scope: 'publisher.tool/main',
  });
});

test('a feature and each canvas referrer link to their own declarations', () => {
  const current = snapshot(project());
  const featureDeclaration =
    'src/demo/project/subroutines/main/features/remaining_iterations/__init__.py';
  const edgeDeclaration =
    'src/demo/project/subroutines/main/edges/profile_analyze/__init__.py';
  current.entity_documents.features.main = {
    remaining_iterations: {declaration: featureDeclaration},
  };
  current.entity_documents.edges.main = {
    profile_analyze: {declaration: edgeDeclaration},
  };

  const feature = navigationPage(current, 'main', 'features').entries.find(
    ({id}) => id === 'remaining_iterations',
  );
  assert.ok(feature);
  assert.equal(feature.declaration, featureDeclaration);
  assert.deepEqual(feature.meta, ['integer']);
  assert.deepEqual(feature.target, {
    inspection: {
      entity: 'features',
      id: 'remaining_iterations',
      subroutine: 'main',
    },
    scope: 'main',
  });
  assert.deepEqual(feature.removal, {
    entity: 'features',
    id: 'remaining_iterations',
    subroutine: 'main',
  });
  const edge = feature.children.find(({id}) => id === 'profile_analyze');
  assert.ok(edge);
  assert.equal(edge.declaration, edgeDeclaration);
  assert.deepEqual(edge.meta, []);
  assert.deepEqual(edge.target, {
    selection: {entity: 'edges', id: 'profile_analyze'},
    scope: 'main',
  });
  assert.deepEqual(edge.removal, {
    entity: 'edges',
    id: 'profile_analyze',
    subroutine: 'main',
  });
});

test('read-only navigation offers no deletion actions', () => {
  const current = snapshot(project());
  current.editable = false;
  const entries = (
    ['subroutines', 'workflows', 'features', 'profiles', 'sessions'] as const
  ).flatMap(category => navigationPage(current, 'main', category).entries);
  const visit = (entry: (typeof entries)[number]): void => {
    assert.equal(entry.removal, undefined);
    entry.children.forEach(visit);
  };
  entries.forEach(visit);
});

test('partially authored references degrade to empty instead of throwing', () => {
  const current = snapshot(project());
  const graph = current.project.subroutine as unknown as Record<
    string,
    unknown
  >;
  graph.edges = [
    {conditions: 'being typed', effects: undefined, id: 'partial'},
  ];
  graph.nodes = [{id: 'partial', kind: 'agent', operation: undefined}];

  assert.equal(navigationPage(current, 'main', 'features').entries.length, 1);
  assert.deepEqual(
    navigationPage(current, 'main', 'profiles').entries[0]?.children,
    [],
  );
  assert.equal(navigationPage(current, 'main', 'sessions').entries.length, 2);

  graph.features = 'being typed';
  graph.nodes = 'being typed';
  assert.deepEqual(navigationPage(current, 'main', 'features').entries, []);
  assert.equal(navigationPage(current, 'main', 'profiles').entries.length, 1);
});

test('workflow navigation keeps its wrapper context and explicit boundary resources', () => {
  const root = project();
  root.subroutine.profile_parameters = [
    {id: 'generator', name: 'Generator'},
    {id: 'reviewer', name: 'Reviewer'},
  ];
  root.subroutine.session_parameters = [
    {id: 'conversation', name: 'Conversation'},
    {id: 'scratch', name: 'Scratch'},
  ];
  root.workflow.profile_arguments = {
    generator: 'builder',
    reviewer: 'builder',
  };
  root.workflow.session_arguments = {
    conversation: 'history',
    scratch: 'temporary',
  };
  root.workflow.profiles = [testProfile('builder', 'Builder')];
  root.workflow.sessions = [
    {id: 'history', name: 'History', persistent: true},
    {id: 'temporary', name: 'Temporary', persistent: false},
  ];
  const current = snapshot(root);
  const declaration =
    'src/demo/project/workflows/main/profiles/builder/__init__.py';
  current.entity_documents.profiles['workflow:main'] = {builder: {declaration}};

  const profiles = navigationPage(current, 'workflow:main', 'profiles');
  assert.equal(profiles.context, 'Workflow main');
  assert.deepEqual(
    profiles.entries.map(({id}) => id),
    ['builder'],
  );
  assert.deepEqual(profiles.entries[0]?.meta, ['codex']);
  assert.equal(profiles.entries[0]?.declaration, declaration);
  assert.deepEqual(profiles.entries[0]?.target, {
    inspection: {
      entity: 'profiles',
      id: 'builder',
      subroutine: 'main',
      workflow: 'main',
    },
    scope: 'workflow:main',
    selection: {entity: 'nodes', id: 'subroutine'},
  });
  assert.deepEqual(profiles.entries[0]?.scope, [
    'demo/project',
    'Workflows',
    'main',
  ]);
  assert.equal(profiles.entries[0]?.removal, undefined);
  assert.equal(
    profiles.entries[0]?.removalBlocked,
    'Rebind this profile before deleting it.',
  );
  assert.deepEqual(profiles.entries[0]?.children, [
    {
      children: [],
      entity: 'nodes',
      id: 'subroutine',
      key: 'workflow:main/profiles:builder/binding:subroutine',
      meta: ['profile generator', 'profile reviewer'],
      scope: ['demo/project', 'Workflows', 'main'],
      target: {
        inspection: {
          entity: 'workflows',
          id: 'main',
          subroutine: 'main',
          workflow: 'main',
        },
        scope: 'workflow:main',
        selection: {entity: 'nodes', id: 'subroutine'},
      },
    },
  ]);

  const sessions = navigationPage(current, 'workflow:main', 'sessions');
  assert.deepEqual(
    sessions.entries.map(({id, meta}) => ({id, meta})),
    [
      {id: 'history', meta: ['persistent']},
      {id: 'temporary', meta: ['fresh']},
    ],
  );
  assert.deepEqual(
    sessions.entries.map(({removal}) => removal),
    [undefined, undefined],
  );
  assert.deepEqual(
    sessions.entries.map(({removalBlocked}) => removalBlocked),
    [
      'Rebind this session before deleting it.',
      'Rebind this session before deleting it.',
    ],
  );
  assert.deepEqual(
    sessions.entries.map(({children}) =>
      children.map(({id, meta, target}) => ({id, meta, target})),
    ),
    [
      [
        {
          id: 'subroutine',
          meta: ['session conversation'],
          target: {
            inspection: {
              entity: 'workflows',
              id: 'main',
              subroutine: 'main',
              workflow: 'main',
            },
            scope: 'workflow:main',
            selection: {entity: 'nodes', id: 'subroutine'},
          },
        },
      ],
      [
        {
          id: 'subroutine',
          meta: ['session scratch'],
          target: {
            inspection: {
              entity: 'workflows',
              id: 'main',
              subroutine: 'main',
              workflow: 'main',
            },
            scope: 'workflow:main',
            selection: {entity: 'nodes', id: 'subroutine'},
          },
        },
      ],
    ],
  );
  assert.deepEqual(
    navigationPage(current, 'workflow:main', 'features').entries,
    [],
  );
  assert.equal(
    navigationPage(current, 'workflow:main', 'subroutines').entries.find(
      ({key}) => key === 'subroutine:main',
    )?.target?.scope,
    'main',
  );
  assert.equal(
    navigationPage(current, 'workflow:main', 'workflows').entries.find(
      ({key}) => key === 'workflow:main',
    )?.target?.scope,
    'workflow:main',
  );
  assert.equal(
    navigationPage(current, 'workflow:main', 'status').context,
    'Workflow main',
  );

  const components = definitionComponentEntries(
    current,
    snapshotCanvasGraphs(current)['workflow:main'],
    {entity: 'workflows', id: graphId('main'), subroutine: 'main'},
  );
  assert.deepEqual(
    components.map(({entity, id}) => ({entity, id})),
    [
      {entity: 'nodes', id: 'subroutine'},
      {entity: 'profiles', id: 'builder'},
      {entity: 'sessions', id: 'history'},
      {entity: 'sessions', id: 'temporary'},
    ],
  );
  assert.equal(
    components.every(({scope}) => scope.length === 0),
    true,
  );
  assert.equal(components[0]?.removal, undefined);
  assert.deepEqual(components[0]?.target, {
    inspection: {
      entity: 'workflows',
      id: 'main',
      subroutine: 'main',
      workflow: 'main',
    },
    scope: 'workflow:main',
    selection: {entity: 'nodes', id: 'subroutine'},
  });
  assert.equal(components[1]?.removal, undefined);
  assert.equal(
    components[1]?.removalBlocked,
    'Rebind this profile before deleting it.',
  );
  assert.equal(components[1]?.children.length, 1);
});

test('a subroutine definition lists every directly owned entity', () => {
  const root = project();
  root.subroutine.profile_parameters = [{id: 'agent', name: 'Agent'}];
  root.subroutine.session_parameters = [
    {id: 'conversation', name: 'Conversation'},
  ];
  root.subroutine.workflows.push({
    profile_arguments: {},
    profiles: [],
    session_arguments: {},
    sessions: [],
    subroutine: graphId('main__implement'),
  });
  const child = root.subroutine.subroutines[0];
  assert.ok(child);
  const grandchild = structuredClone(child);
  grandchild.id = graphId('deeper');
  grandchild.name = 'Deeper';
  child.subroutines.push(grandchild);

  const current = snapshot(root);
  const components = definitionComponentEntries(
    current,
    snapshotCanvasGraphs(current).main,
    {entity: 'subroutines', id: graphId('main'), subroutine: 'main'},
  );
  assert.deepEqual([...new Set(components.map(({entity}) => entity))].sort(), [
    'edges',
    'features',
    'nodes',
    'profile_parameters',
    'profiles',
    'session_parameters',
    'sessions',
    'subroutines',
    'workflows',
  ]);
  assert.equal(
    components.every(({scope}) => scope.length === 0),
    true,
  );
  assert.deepEqual(
    components.filter(({entity}) => entity === 'subroutines').map(({id}) => id),
    ['main__implement'],
  );
  assert.deepEqual(
    components.filter(({entity}) => entity === 'workflows').map(({id}) => id),
    ['main__implement'],
  );
  for (const port of ['enter', 'exit', 'failure']) {
    assert.equal(
      components.find(({entity, id}) => entity === 'nodes' && id === port)
        ?.removal,
      undefined,
    );
  }
  assert.deepEqual(
    components.find(({entity, id}) => entity === 'nodes' && id === 'profile')
      ?.target,
    {
      inspection: {entity: 'nodes', id: 'profile', subroutine: 'main'},
      scope: 'main',
      selection: {entity: 'nodes', id: 'profile'},
    },
  );
  assert.deepEqual(
    components.find(
      ({entity, id}) => entity === 'edges' && id === 'profile_analyze',
    )?.removal,
    {entity: 'edges', id: 'profile_analyze', subroutine: 'main'},
  );

  current.editable = false;
  const readOnly = definitionComponentEntries(
    current,
    snapshotCanvasGraphs(current).main,
    {entity: 'subroutines', id: graphId('main'), subroutine: 'main'},
  );
  const visit = (entry: (typeof readOnly)[number]): void => {
    assert.equal(entry.removal, undefined);
    entry.children.forEach(visit);
  };
  readOnly.forEach(visit);
});

test("a profile referrer focuses its agent node and opens that node's declaration", () => {
  const root = project();
  const call = root.subroutine.nodes.find(({id}) => id === 'call_implement');
  assert.equal(call?.kind, 'subroutine_call');
  if (call?.kind !== 'subroutine_call') {
    return;
  }
  call.operation.profile_arguments = {agent: 'default'};
  const current = snapshot(root);
  const declaration =
    'src/demo/project/subroutines/main/nodes/optimize/__init__.py';
  current.entity_documents.nodes.main = {optimize: {declaration}};

  const profile = navigationPage(current, 'main', 'profiles').entries.find(
    ({id}) => id === 'default',
  );
  assert.ok(profile);
  assert.deepEqual(profile.target, {
    inspection: {entity: 'profiles', id: 'default', subroutine: 'main'},
    scope: 'main',
  });
  const agent = profile.children.find(({id}) => id === 'optimize');
  assert.ok(agent);
  assert.equal(agent.declaration, declaration);
  assert.deepEqual(agent.target, {
    selection: {entity: 'nodes', id: 'optimize'},
    scope: 'main',
  });
  assert.deepEqual(
    profile.children.find(({id}) => id === 'call_implement')?.target,
    {
      selection: {entity: 'nodes', id: 'call_implement'},
      scope: 'main',
    },
  );
});

test('resource parameters are labeled as parameters', () => {
  const root = project();
  root.subroutine.profile_parameters = [{id: 'agent', name: 'Agent'}];
  root.subroutine.session_parameters = [
    {id: 'conversation', name: 'Conversation'},
  ];

  const parameter = navigationPage(
    snapshot(root),
    'main',
    'profiles',
  ).entries.find(({id}) => id === 'agent');
  assert.deepEqual(parameter?.meta, ['parameter']);
  assert.deepEqual(
    navigationPage(snapshot(root), 'main', 'sessions').entries.find(
      ({id}) => id === 'conversation',
    )?.meta,
    ['parameter'],
  );
});

test('a parameter links to every workflow and subroutine call that binds it', () => {
  const root = project();
  const child = root.subroutine.subroutines.find(({id}) => id === 'implement');
  assert.ok(child);
  child.profile_parameters = [{id: 'agent', name: 'Agent'}];
  const call = root.subroutine.nodes.find(({id}) => id === 'call_implement');
  assert.equal(call?.kind, 'subroutine_call');
  if (call?.kind !== 'subroutine_call') {
    return;
  }
  call.operation.profile_arguments = {agent: 'default'};
  root.subroutine.workflows.push({
    profile_arguments: {agent: 'builder'},
    profiles: [testProfile('builder', 'Builder')],
    session_arguments: {},
    sessions: [],
    subroutine: graphId('main__implement'),
  });

  const page = navigationPage(snapshot(root), 'main__implement', 'profiles');
  assert.equal(page.context, 'Subroutine main__implement');
  const parameter = page.entries.find(({id}) => id === 'agent');
  assert.ok(parameter);
  assert.deepEqual(parameter.target, {
    inspection: {
      entity: 'profile_parameters',
      id: 'agent',
      subroutine: 'main__implement',
    },
    scope: 'main__implement',
  });
  assert.deepEqual(
    parameter.children.find(({entity}) => entity === 'nodes')?.target,
    {
      selection: {entity: 'nodes', id: 'call_implement'},
      scope: 'main',
    },
  );
  assert.deepEqual(
    parameter.children.find(({entity}) => entity === 'workflows')?.target,
    {
      inspection: {
        entity: 'workflows',
        id: 'main__implement',
        subroutine: 'main',
        workflow: 'main__implement',
      },
      scope: 'workflow:main__implement',
      selection: {entity: 'nodes', id: 'subroutine'},
    },
  );
});

test('a removed definition links to its graph and declaration', () => {
  const root = project();
  const declaration =
    'src/demo/project/subroutines/main/subroutines/implement/__init__.py';
  root.sources = [...(root.sources as unknown[]), {path: declaration}];
  const entry = removalNavigationEntry(snapshot(root), 'main', {
    effect: 'delete',
    entity: 'subroutines',
    id: 'main__implement',
    reasons: ['selected'],
    scope: [graphId('main')],
  });

  assert.equal(entry.declaration, declaration);
  assert.deepEqual(entry.target, {
    inspection: {
      entity: 'subroutines',
      id: 'main__implement',
      subroutine: 'main',
    },
    scope: 'main__implement',
  });
});

test('a removed non-canvas identity opens properties in its owning graph', () => {
  const entry = removalNavigationEntry(snapshot(project()), 'main', {
    effect: 'delete',
    entity: 'features',
    id: 'remaining_iterations',
    reasons: ['selected'],
    scope: [graphId('main')],
  });

  assert.deepEqual(entry.target, {
    inspection: {
      entity: 'features',
      id: 'remaining_iterations',
      subroutine: 'main',
    },
    scope: 'main',
  });
});

test('a removed workflow resource opens its workflow declaration and properties', () => {
  const root = project();
  root.subroutine.workflows.push({
    profile_arguments: {},
    profiles: [testProfile('builder', 'Builder')],
    session_arguments: {},
    sessions: [],
    subroutine: graphId('main__implement'),
  });
  const current = snapshot(root);
  const declaration =
    'src/demo/project/subroutines/main/workflows/implement/profiles/builder/__init__.py';
  current.entity_documents.profiles['workflow:main__implement'] = {
    builder: {declaration},
  };

  const entry = removalNavigationEntry(current, 'main', {
    effect: 'delete',
    entity: 'profiles',
    id: 'builder',
    reasons: ['selected'],
    scope: [graphId('main'), graphId('main__implement')],
    workflow: graphId('main__implement'),
  });

  assert.equal(entry.declaration, declaration);
  assert.deepEqual(entry.scope, [
    'demo/project',
    'main',
    'Workflows',
    'main__implement',
  ]);
  assert.deepEqual(entry.target, {
    inspection: {
      entity: 'profiles',
      id: 'builder',
      subroutine: 'main',
      workflow: 'main__implement',
    },
    selection: {entity: 'nodes', id: 'subroutine'},
    scope: 'workflow:main__implement',
  });
});

test('editable pinned workflow resources keep their deletion action', () => {
  const root = project();
  const pinned = project();
  pinned.package = 'publisher.tool';
  pinned.workflow.profiles = [testProfile('builder', 'Builder')];
  const current = snapshot(root, {'publisher.tool': pinned});

  const profile = navigationPage(
    current,
    'publisher.tool/workflow:main',
    'profiles',
  ).entries[0];
  assert.deepEqual(profile?.removal, {
    entity: 'profiles',
    id: 'builder',
    subroutine: 'publisher.tool/main',
    workflow: 'main',
  });
});
