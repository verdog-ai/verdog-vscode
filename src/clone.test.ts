/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Clone reading, path safety, and CLI verdict composition. */

import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';

import {documentsOf, visitDocumentsOf} from '../model/documents';
import {SCHEMA_VERSION, type SubroutineDefinition} from '../model/project';
import {subroutineCallTarget, subroutineIn} from '../model/snapshot';
import {
  snapshotDefinitions,
  snapshotCanvasGraphs,
  snapshotSubroutines,
  visibleDefinitionKeys,
} from '../webview/subroutineGraphs';
import {projectFileReadonly, readClone, subroutineFile} from './clone';
import {parseVerdict} from './cli';
import {testProfile} from './fixtures';
import {definitionTarget, navigationPage} from '../webview/navigation';
import {entityPropertyPage} from '../webview/propertyData';
import {nodeResourceFields} from '../model/resources';

test('file protection follows manifest ownership', () => {
  const root = path.resolve('workspace', 'project');
  const snapshot = {
    pinned: {
      'child.tools': {
        sources: [
          {ownership: 'generated', path: 'src/child/__init__.py'},
          {ownership: 'user', path: 'src/child/authored.py'},
        ],
      },
    },
    project: {
      sources: [
        {ownership: 'generated', path: 'src/demo/__init__.py'},
        {ownership: 'user', path: 'src/demo/authored.py'},
      ],
    },
  };
  const inside = (...parts: string[]): string => path.join(root, ...parts);

  assert.equal(
    projectFileReadonly(root, inside('src', 'demo', '__init__.py'), snapshot),
    true,
  );
  assert.equal(
    projectFileReadonly(root, inside('src', 'demo', 'authored.py'), snapshot),
    false,
  );
  assert.equal(
    projectFileReadonly(root, inside('project.json'), snapshot),
    false,
  );
  assert.equal(
    projectFileReadonly(root, inside('src', 'notes.py'), snapshot),
    false,
  );
  assert.equal(
    projectFileReadonly(
      root,
      inside('external', 'child', 'tools', 'project.json'),
      snapshot,
    ),
    false,
  );
  assert.equal(
    projectFileReadonly(
      root,
      inside('external', 'child', 'tools', 'src', 'child', '__init__.py'),
      snapshot,
    ),
    true,
  );
  assert.equal(
    projectFileReadonly(
      root,
      inside('external', 'child', 'tools', 'src', 'child', 'authored.py'),
      snapshot,
    ),
    false,
  );
  assert.equal(
    projectFileReadonly(
      root,
      inside('external', 'child', 'external', 'grandchild', 'impl.py'),
      snapshot,
    ),
    false,
  );
  assert.equal(
    projectFileReadonly(root, inside('external_tools', 'notes.py'), snapshot),
    false,
  );
  assert.equal(
    projectFileReadonly(
      root,
      path.resolve(root, '..', 'other', '__init__.py'),
      snapshot,
    ),
    undefined,
  );
});

test('an old clone reports its schema as unsupported', async context => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'verdog-vscode-old-schema-'),
  );
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  await fs.writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({schema_version: 12}),
  );

  await assert.rejects(
    readClone(root),
    new RegExp(`schema v12.*unsupported.*schema v${SCHEMA_VERSION}`, 'i'),
  );
});

test('partial graph edits still expose the available identities', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-vscode-partial-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  for (const subroutine of [
    undefined,
    {id: 'main'},
    {id: 'main', nodes: null, edges: {}},
    {
      id: 'main',
      nodes: [null, {id: 'enter', kind: 'enter'}, {id: 'unfinished'}],
      edges: [null, {id: 'partial'}],
      features: null,
    },
  ]) {
    await fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        package: 'demo',
        subroutine,
      }),
    );
    const snapshot = await readClone(root);
    const graphs = snapshotCanvasGraphs(snapshot);
    assert.equal(Object.keys(graphs).length, subroutine === undefined ? 0 : 1);
    if (subroutine !== undefined) {
      const graph = graphs.main;
      const target = definitionTarget(snapshot, graph);
      assert.equal(target?.scope, 'main');
      assert.ok(target?.inspection);
      assert.ok(
        entityPropertyPage(
          snapshot,
          graph,
          target.inspection,
          'Subroutine main',
        ),
      );
      assert.deepEqual(nodeResourceFields(snapshot, 'main', 'unfinished'), []);
      for (const category of [
        'subroutines',
        'workflows',
        'profiles',
        'sessions',
        'features',
        'status',
      ] as const) {
        assert.doesNotThrow(() => navigationPage(snapshot, 'main', category));
      }
    }
  }
});

test('entity documents follow their lexical source paths', async context => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'verdog-vscode-documents-'),
  );
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  const graph = (id: string, name: string): SubroutineDefinition => ({
    edges: [],
    features: [],
    profile_parameters: [],
    profiles: [],
    session_parameters: [],
    sessions: [],
    id,
    name,
    nodes: [],
    ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
    subroutines: [],
    workflows: [],
  });
  const subroutine = graph('main', 'Main');
  subroutine.nodes.push({
    id: 'update_status',
    kind: 'feature',
    name: 'Update status',
    operation: {},
  });
  subroutine.edges.push({
    conditions: [],
    effects: [],
    id: 'enter_update',
    name: 'Enter update',
    source: 'enter',
    target: 'update_status',
  });
  subroutine.edges.push({
    conditions: [],
    effects: [],
    id: 'update_exit',
    name: 'Update exit',
    source: 'update_status',
    target: 'exit',
  });
  subroutine.workflows.push({
    subroutine: 'main__worker',
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  });
  subroutine.subroutines.push(graph('worker', 'Worker'));
  subroutine.features.push({
    description: 'Current status',
    id: 'status',
    kind: 'boolean',
    label: 'Status',
  });
  subroutine.profile_parameters.push({id: 'agent', name: 'Agent'});
  subroutine.profiles.push(testProfile('local', 'Local'));
  subroutine.session_parameters.push({
    id: 'conversation',
    name: 'Conversation',
  });
  subroutine.sessions.push({id: 'scratch', name: 'Scratch', persistent: false});
  const featureNode = 'src/demo/project/subroutines/main/nodes/update_status';
  const base = 'src/demo/project/subroutines/main';
  const workflowBase = 'src/demo/project/workflows/main';
  await fs.writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      editor: {layouts: {}},
      externals: [],
      generated_from: '0'.repeat(64),
      package: 'demo.project',
      schema_version: SCHEMA_VERSION,
      sources: [
        {path: `${featureNode}/__init__.py`},
        {path: `${base}/edges/enter_update/__init__.py`},
        {path: `${base}/edges/update_exit/__init__.py`},
        {path: `${featureNode}/visit/enter_update/__init__.py`},
        {path: `${featureNode}/visit/enter_update/impl.py`},
        {path: `${base}/features/status/__init__.py`},
        {path: `${base}/features/status/impl.py`},
        {path: `${base}/profiles/__init__.py`},
        {path: `${base}/profiles/agent/__init__.py`},
        {path: `${base}/profiles/local/__init__.py`},
        {path: `${base}/profiles/local/impl.py`},
        {path: `${base}/sessions/__init__.py`},
        {path: `${base}/sessions/conversation/__init__.py`},
        {path: `${base}/sessions/scratch/__init__.py`},
        {path: `${workflowBase}/profiles/runtime/__init__.py`},
        {path: `${workflowBase}/sessions/runtime/__init__.py`},
      ],
      subroutine,
      workflow: {
        subroutine: 'main',
        profiles: [testProfile('runtime', 'Runtime')],
        sessions: [{id: 'runtime', name: 'Runtime', persistent: true}],
        profile_arguments: {},
        session_arguments: {},
      },
    }),
  );

  const snapshot = await readClone(root);
  assert.equal(snapshot.initial_scope, 'workflow:main');
  const documents = snapshot.entity_documents;
  assert.deepEqual(documents.nodes.main.update_status, {
    declaration: `${featureNode}/__init__.py`,
  });
  assert.deepEqual(documents.edges.main.enter_update, {
    declaration: `${base}/edges/enter_update/__init__.py`,
    visit: {
      declaration: `${featureNode}/visit/enter_update/__init__.py`,
      implementation: `${featureNode}/visit/enter_update/impl.py`,
    },
  });
  assert.deepEqual(documents.edges.main.update_exit, {
    declaration: `${base}/edges/update_exit/__init__.py`,
  });
  assert.deepEqual(documents.features.main.status, {
    declaration: `${base}/features/status/__init__.py`,
  });
  assert.deepEqual(documents.profile_parameters.main.agent, {
    declaration: `${base}/profiles/agent/__init__.py`,
  });
  assert.deepEqual(documents.profiles.main.local, {
    declaration: `${base}/profiles/local/__init__.py`,
  });
  assert.deepEqual(documents.session_parameters.main.conversation, {
    declaration: `${base}/sessions/conversation/__init__.py`,
  });
  assert.deepEqual(documents.sessions.main.scratch, {
    declaration: `${base}/sessions/scratch/__init__.py`,
  });
  assert.deepEqual(documents.profiles['workflow:main'].runtime, {
    declaration: `${workflowBase}/profiles/runtime/__init__.py`,
  });
  assert.deepEqual(documents.sessions['workflow:main'].runtime, {
    declaration: `${workflowBase}/sessions/runtime/__init__.py`,
  });
});

test('a check verdict becomes anchored diagnostics', () => {
  const root = '/clone';
  const verdict = parseVerdict(
    JSON.stringify({
      graph_hash: 'a'.repeat(64),
      changed: ['src/pkg/cap.py'],
      diagnostics: [
        {
          severity: 'error',
          code: 'contract.schema_stale',
          message: 'contract schema is stale',
          path: 'src/pkg/impl.py',
          line: 18,
          column: 13,
          end_line: 18,
          end_column: 25,
        },
      ],
      type_diagnostics: [
        {
          severity: 'error',
          code: 'invalid-return-type',
          message: 'Return type does not match returned value',
          path: 'src/pkg/cap.py',
          line: 14,
          column: 16,
        },
      ],
    }),
    root,
  );
  assert.ok(verdict);
  assert.equal(verdict.diagnostics.length, 2);
  assert.equal(verdict.graphHash, 'a'.repeat(64));
  const [structural, typed] = verdict.diagnostics;
  assert.equal(structural.file, '/clone/src/pkg/impl.py');
  assert.equal(structural.line, 18);
  assert.equal(structural.column, 13);
  assert.equal(structural.endLine, 18);
  assert.equal(structural.endColumn, 25);
  assert.match(structural.message, /contract\.schema_stale/);

  // `ty`'s half carries a real position, and that is what makes the Problems panel useful.
  assert.equal(typed.file, '/clone/src/pkg/cap.py');
  assert.equal(typed.line, 14);
  assert.equal(typed.column, 16);
  assert.equal(typed.severity, 'error');
});

test('a verdict the CLI never produced is absent rather than empty', () => {
  // A missing binary or a clone with no token prints prose and no object. Reporting that as
  // "no problems" would be the worst possible reading of it.
  assert.equal(
    parseVerdict('verdog could not be started: ENOENT', '/clone'),
    undefined,
  );
});

test("a pinned dependency's workflows are drawable, namespaced, and owner-qualified", () => {
  // The point under test is the keying, not disk reading. A pinned `main` and your own `main` are different workflows
  // with the same id, and before they were namespaced only one of them could exist.
  const subroutine = (id: string) => ({
    edges: [
      {
        conditions: [],
        effects: [],
        id: 'e',
        name: 'e',
        source: 'a',
        target: 'b',
      },
    ],
    features: [],
    profile_parameters: [],
    profiles: [],
    session_parameters: [],
    sessions: [],
    id,
    name: `Subroutine ${id}`,
    nodes: [
      {id: 'a', kind: 'python', name: 'A'},
      {id: 'b', kind: 'python', name: 'B'},
    ],
    ports: {enter: 'a', exit: 'b', failure: 'b'},
    subroutines: [],
    workflows: [],
  });
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
    pinned: {
      'local.tools': {
        editor: {layouts: {}},
        package: 'publisher.tools',
        subroutine: subroutine('main_body'),
        workflow: {
          subroutine: 'main_body',
          profiles: [],
          sessions: [],
          profile_arguments: {},
          session_arguments: {},
        },
      },
    },
    project: {
      editor: {layouts: {}},
      subroutine: subroutine('main_body'),
      workflow: {
        subroutine: 'main_body',
        profiles: [],
        sessions: [],
        profile_arguments: {},
        session_arguments: {},
      },
    },
  } as unknown as Parameters<typeof snapshotSubroutines>[0];

  const graphs = snapshotSubroutines(snapshot);
  assert.deepEqual(Object.keys(graphs), ['main_body', 'local.tools/main_body']);
  assert.equal(graphs['local.tools/main_body'].id, 'local.tools/main_body');
  // Same shape either way: a pinned graph is drawn by the same code, not a second renderer.
  assert.equal(graphs['local.tools/main_body'].nodes.length, 2);
  assert.equal(graphs['local.tools/main_body'].edges.length, 1);
});

test('an edit to a pinned workflow is aimed at the submodule, not at your own graph', () => {
  // The failure this prevents is silent: writing a dependency's change into your own
  // `project.json`, under a workflow id that does not exist there.
  const pinned = {
    'publisher.level_one': {},
    'publisher.level_one/publisher.demo': {},
  };
  assert.deepEqual(
    subroutineFile('/w/level2', 'publisher.level_one/main', pinned),
    {
      root: path.join('/w/level2', 'external', 'publisher', 'level_one'),
      subroutine: 'main',
    },
  );
  // Your own workflow is untouched, prefix or no prefix.
  assert.deepEqual(subroutineFile('/w/level2', 'main', pinned), {
    root: '/w/level2',
    subroutine: 'main',
  });
  // A prefix that is not an alias path this project pins is not a pin. Workflow ids cannot
  // contain `/`, so this can only arise from a hand-edited graph -- and guessing would send
  // the write into a directory that does not exist.
  assert.deepEqual(subroutineFile('/w/level2', 'not_a_pin/main', pinned), {
    root: '/w/level2',
    subroutine: 'not_a_pin/main',
  });
  // Each owner contributes one `external/<alias>` segment.
  assert.deepEqual(
    subroutineFile(
      '/w/level2',
      'publisher.level_one/publisher.demo/main',
      pinned,
    ).root,
    path.join(
      '/w/level2',
      'external',
      'publisher',
      'level_one',
      'external',
      'publisher',
      'demo',
    ),
  );
});

test("a clone follows each owner's direct aliases without flattening packages", async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-vscode-aliases-'));
  context.after(() => fs.rm(root, {force: true, recursive: true}));

  const subroutine = (nodes: Array<Record<string, unknown>> = []) => ({
    edges: [],
    features: [],
    profile_parameters: [],
    profiles: [],
    session_parameters: [],
    sessions: [],
    id: 'main_body',
    name: 'Main',
    nodes,
    ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
    subroutines: [],
    workflows: [],
  });
  const project = (
    packageName: string,
    externals: Array<Record<string, unknown>>,
    binding: {alias: string; id: string} | undefined = undefined,
    nodes: Array<Record<string, unknown>> = [],
    sources: Array<Record<string, unknown>> = [],
  ) => {
    const rootSubroutine = subroutine(nodes) as Record<string, unknown>;
    rootSubroutine.workflows =
      binding === undefined
        ? []
        : [
            {
              id: binding.id,
              name: binding.id,
              external: {alias: binding.alias, workflow: 'main_body'},
            },
          ];
    return {
      editor: {layouts: {}},
      externals,
      generated_from: '0'.repeat(64),
      package: packageName,
      schema_version: SCHEMA_VERSION,
      sources,
      subroutine: rootSubroutine,
      workflow: {
        subroutine: 'main_body',
        profiles: [],
        sessions: [],
        profile_arguments: {},
        session_arguments: {},
      },
    };
  };
  const call = (target: string, id: string) => ({
    id,
    kind: 'workflow_call',
    name: id,
    operation: {target},
  });

  const levelOne = path.join(root, 'external', 'publisher', 'level_one');
  const demoOne = path.join(levelOne, 'external', 'publisher', 'demo');
  const childDeclaration =
    'src/publisher/demo/subroutines/main_body/nodes/run/__init__.py';
  await fs.mkdir(demoOne, {recursive: true});
  await Promise.all([
    fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify(
        project(
          'owner.root',
          [{alias: 'publisher.level_one', package: 'publisher.level_one'}],
          {alias: 'publisher.level_one', id: 'level_one'},
          [call('main_body__level_one', 'call_level_one')],
          [{path: 'src/owner/root/workflows/main_body/requirements.txt'}],
        ),
      ),
    ),
    fs.writeFile(
      path.join(levelOne, 'project.json'),
      JSON.stringify(
        project(
          'publisher.level_one',
          [{alias: 'publisher.demo', package: 'publisher.demo'}],
          {alias: 'publisher.demo', id: 'demo_one'},
          [
            call('main_body__demo_one', 'call_demo_one'),
            {
              id: 'call_demo_subroutine',
              kind: 'subroutine_call',
              name: 'Call demo subroutine',
              operation: {
                profile_arguments: {},
                session_arguments: {},
                target: 'publisher.demo/main_body',
              },
            },
          ],
          [
            {
              path: 'src/publisher/level_one/workflows/main_body/requirements.txt',
            },
          ],
        ),
      ),
    ),
    fs.writeFile(
      path.join(demoOne, 'project.json'),
      JSON.stringify(
        project(
          'publisher.demo',
          [],
          undefined,
          [{id: 'run', kind: 'python', name: 'Run', operation: {}}],
          [{path: childDeclaration}],
        ),
      ),
    ),
  ]);

  const snapshot = await readClone(root);
  assert.deepEqual(Object.keys(snapshot.pinned), [
    'publisher.level_one',
    'publisher.level_one/publisher.demo',
  ]);
  assert.equal(
    snapshot.entity_documents.nodes[
      'publisher.level_one/publisher.demo/main_body'
    ].run.declaration,
    `external/publisher/level_one/external/publisher/demo/${childDeclaration}`,
    'the alias path locates the checkout, while the child package locates its sources',
  );

  const graphs = snapshotSubroutines(snapshot);
  assert.deepEqual(Object.keys(graphs), [
    'main_body',
    'publisher.level_one/main_body',
    'publisher.level_one/publisher.demo/main_body',
  ]);
  assert.deepEqual(
    graphs['publisher.level_one/main_body'].nodes.find(
      node => node.id === 'call_demo_one',
    )?.data.definition,
    {
      alias: 'publisher.demo',
      graph: 'main_body',
      ownerPath: 'publisher.level_one',
      scope: 'publisher.level_one/publisher.demo/workflow:main_body',
    },
  );
  assert.deepEqual(
    graphs['publisher.level_one/main_body'].nodes.find(
      node => node.id === 'call_demo_subroutine',
    )?.data.definition,
    {
      alias: 'publisher.demo',
      graph: 'main_body',
      ownerPath: 'publisher.level_one',
    },
  );
  assert.equal(
    graphs['publisher.level_one/main_body'].nodes.find(
      node => node.id === 'call_demo_subroutine',
    )?.data.implementation,
    'external/publisher/level_one/external/publisher/demo/src/publisher/demo/subroutines/main_body/impl.py',
  );
  assert.equal(
    subroutineCallTarget(snapshot, 'main_body', 'main_body')?.id,
    'main_body',
  );
  assert.equal(
    subroutineCallTarget(
      snapshot,
      'publisher.level_one/main_body',
      'publisher.demo/main_body',
    )?.id,
    'main_body',
  );
  assert.equal(
    subroutineCallTarget(
      snapshot,
      'publisher.level_one/main_body',
      'publisher.demo/nested/main',
    ),
    undefined,
  );
  const definitions = snapshotDefinitions(snapshot);
  const rootVisibility = visibleDefinitionKeys(snapshot, 'main_body');
  assert.equal(
    rootVisibility.has('publisher.level_one/subroutine:main_body'),
    true,
  );
  assert.equal(
    rootVisibility.has(
      'publisher.level_one/publisher.demo/subroutine:main_body',
    ),
    false,
  );
  assert.equal(
    visibleDefinitionKeys(snapshot, 'publisher.level_one/main_body').has(
      'publisher.level_one/publisher.demo/subroutine:main_body',
    ),
    true,
  );
  assert.deepEqual(
    definitions.find(({key}) => key === 'workflow:main_body')?.documents,
    [
      {
        label: 'requirements',
        path: 'src/owner/root/workflows/main_body/requirements.txt',
      },
    ],
  );
  assert.deepEqual(
    definitions.find(
      ({key}) => key === 'publisher.level_one/workflow:main_body',
    )?.documents,
    [
      {
        label: 'requirements',
        path: 'external/publisher/level_one/src/publisher/level_one/workflows/main_body/requirements.txt',
      },
    ],
  );
  assert.deepEqual(
    definitions.find(({key}) => key === 'workflow:main_body__level_one'),
    {
      declaredIn: 'main_body',
      documents: [],
      id: 'main_body__level_one',
      key: 'workflow:main_body__level_one',
      kind: 'workflow',
      ownerGraph: 'main_body',
      scope: 'publisher.level_one/workflow:main_body',
      target: 'publisher.level_one/main_body',
    },
  );
  assert.deepEqual(
    definitions.find(
      ({key}) => key === 'publisher.level_one/workflow:main_body__demo_one',
    ),
    {
      declaredIn: 'publisher.level_one/main_body',
      documents: [],
      id: 'main_body__demo_one',
      key: 'publisher.level_one/workflow:main_body__demo_one',
      kind: 'workflow',
      ownerGraph: 'publisher.level_one/main_body',
      scope: 'publisher.level_one/publisher.demo/workflow:main_body',
      target: 'publisher.level_one/publisher.demo/main_body',
    },
  );
  const withoutNestedPin = snapshotDefinitions({
    ...snapshot,
    pinned: {'publisher.level_one': snapshot.pinned['publisher.level_one']},
  });
  assert.deepEqual(
    withoutNestedPin.find(
      ({key}) => key === 'publisher.level_one/workflow:main_body__demo_one',
    ),
    {
      declaredIn: 'publisher.level_one/main_body',
      documents: [],
      id: 'main_body__demo_one',
      key: 'publisher.level_one/workflow:main_body__demo_one',
      kind: 'workflow',
      ownerGraph: 'publisher.level_one/main_body',
    },
  );
  assert.equal(
    subroutineFile(
      root,
      'publisher.level_one/publisher.demo/main_body',
      snapshot.pinned,
    ).root,
    demoOne,
  );
});

test('a clone does not follow an invalid alias outside its root', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-vscode-root-'));
  const outside = await fs.mkdtemp(
    path.join(tmpdir(), 'verdog-vscode-outside-'),
  );
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  context.after(() => fs.rm(outside, {force: true, recursive: true}));

  const project = (externals: Array<Record<string, unknown>>) => ({
    externals,
    generated_from: '0'.repeat(64),
    package: 'owner.root',
    schema_version: SCHEMA_VERSION,
    sources: [],
    subroutine: {
      edges: [],
      features: [],
      id: 'main_body',
      name: 'Main body',
      nodes: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      subroutines: [],
      workflows: [],
    },
    workflow: {
      subroutine: 'main_body',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
  });
  await Promise.all([
    fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify(project([{alias: `../../${path.basename(outside)}`}])),
    ),
    fs.writeFile(
      path.join(outside, 'project.json'),
      JSON.stringify(project([])),
    ),
  ]);

  assert.deepEqual((await readClone(root)).pinned, {});
});

test('a clone does not follow a symlinked external checkout', async context => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verdog-vscode-root-'));
  const outside = await fs.mkdtemp(
    path.join(tmpdir(), 'verdog-vscode-outside-'),
  );
  context.after(() => fs.rm(root, {force: true, recursive: true}));
  context.after(() => fs.rm(outside, {force: true, recursive: true}));
  await fs.mkdir(path.join(root, 'external', 'owner'), {recursive: true});
  try {
    await fs.symlink(
      outside,
      path.join(root, 'external', 'owner', 'borrowed'),
      'dir',
    );
  } catch {
    context.skip('directory symlinks are unavailable');
    return;
  }
  const project = (externals: Array<Record<string, unknown>>) => ({
    externals,
    generated_from: '0'.repeat(64),
    package: 'owner.root',
    schema_version: SCHEMA_VERSION,
    sources: [],
    subroutine: {
      edges: [],
      features: [],
      id: 'main_body',
      name: 'Main body',
      nodes: [],
      profile_parameters: [],
      profiles: [],
      session_parameters: [],
      sessions: [],
      ports: {enter: 'enter', exit: 'exit', failure: 'failure'},
      subroutines: [],
      workflows: [],
    },
    workflow: {
      subroutine: 'main_body',
      profiles: [],
      sessions: [],
      profile_arguments: {},
      session_arguments: {},
    },
  });
  await Promise.all([
    fs.writeFile(
      path.join(root, 'project.json'),
      JSON.stringify(
        project([{alias: 'owner.borrowed', package: 'owner.outside'}]),
      ),
    ),
    fs.writeFile(
      path.join(outside, 'project.json'),
      JSON.stringify(project([])),
    ),
  ]);

  assert.deepEqual((await readClone(root)).pinned, {});
});

test('entity documents have readable stable labels', () => {
  const full = {
    declaration: 'a/__init__.py',
    implementation: 'a/impl.py',
  };
  assert.deepEqual(documentsOf(full, 'nodes'), [
    {label: 'node declaration', path: 'a/__init__.py'},
    {label: 'node implementation', path: 'a/impl.py'},
  ]);

  const edge = {
    declaration: 'edges/c/__init__.py',
    visit: {
      declaration: 'c/__init__.py',
      implementation: 'c/impl.py',
    },
  };
  assert.deepEqual(documentsOf(edge, 'edges'), [
    {label: 'edge declaration', path: 'edges/c/__init__.py'},
  ]);
  assert.deepEqual(visitDocumentsOf(edge), [
    {label: 'visit declaration', path: 'c/__init__.py'},
    {label: 'visit implementation', path: 'c/impl.py'},
  ]);
  assert.deepEqual(documentsOf(undefined, 'nodes'), []);
  assert.deepEqual(
    documentsOf(
      {
        declaration: 'features/count/__init__.py',
        implementation: 'features/count/impl.py',
      },
      'features',
    ),
    [{label: 'feature declaration', path: 'features/count/__init__.py'}],
  );
  assert.deepEqual(
    documentsOf(
      {declaration: 'profiles/agent/__init__.py'},
      'profile_parameters',
    ),
    [
      {
        label: 'profile parameter declaration',
        path: 'profiles/agent/__init__.py',
      },
    ],
  );
});

test('a pinned workflow is read from the project that defines it', () => {
  // The panels read the raw graph, and a pinned workflow's key is `<alias path>/<id>` while its
  // definition lives in the submodule under the plain id. Looking the key up in this project
  // finds nothing, which left properties and resource navigation empty inside a
  // dependency.
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
    pinned: {
      'local.tools': {
        package: 'publisher.tools',
        subroutine: {
          id: 'main_body',
          name: 'Theirs',
          nodes: [],
          edges: [],
          workflows: [],
          subroutines: [],
        },
        workflow: {
          subroutine: 'main_body',
          profiles: [],
          sessions: [],
          profile_arguments: {},
          session_arguments: {},
        },
      },
    },
    project: {
      subroutine: {
        id: 'main_body',
        name: 'Ours',
        nodes: [],
        edges: [],
        workflows: [],
        subroutines: [],
      },
      workflow: {
        subroutine: 'main_body',
        profiles: [],
        sessions: [],
        profile_arguments: {},
        session_arguments: {},
      },
    },
  } as unknown as Parameters<typeof subroutineIn>[0];

  assert.equal(subroutineIn(snapshot, 'main_body')?.name, 'Ours');
  assert.equal(subroutineIn(snapshot, 'local.tools/main_body')?.name, 'Theirs');
  // A prefix that names no pin is looked for as a plain id.
  assert.equal(subroutineIn(snapshot, 'nope/main'), undefined);
  assert.equal(subroutineIn(snapshot, 'absent'), undefined);
});
