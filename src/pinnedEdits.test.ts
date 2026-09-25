/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Every editing gesture, aimed at a workflow this project does not define.
 *
 * This is the test that was missing, and three bugs reached the author through the gap. A pinned
 * workflow's key is `<alias path>/<id>`, and every gesture has to undo *both* halves together --
 * open the submodule's `project.json`, and use the plain id inside it. Get it wrong and nothing
 * type-checks differently: `mutate` is handed a project and a string, and both are the right
 * *types*. What happens instead is `no workflow verdog_ai.demo1_level1/main in this project`, or
 * silence.
 *
 * The webview harness could not see any of it, because it stubs the host: the resolution under
 * test happens entirely on the extension side. So this exercises the composition directly --
 * `projectIn` to read, `subroutineFile` to write, `mutate` to change -- which is what
 * `editWorkflow` does for every gesture in `projectHost.ts`.
 *
 * `projectHost.ts` itself cannot be imported here: it requires `vscode`. That is the reason the
 * resolution lives in `clone.ts` and `model/` rather than in the host, and the reason this test
 * can exist at all.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import {test} from 'node:test';

import {subroutineFile} from './clone';
import * as mutate from '../model/editing';
import {subroutineInProject} from '../model/project';
import {projectIn, type ProjectGraphs} from '../model/snapshot';
import {testProject} from './fixtures';

const ALIAS = 'local.tools';
const SUBROUTINE = 'main';
const KEY = `${ALIAS}/${SUBROUTINE}`;

/** A snapshot of one project that also carries another as a pinned dependency. */
function world(): ProjectGraphs {
  return {
    entity_documents: {
      edges: {},
      features: {},
      nodes: {},
      profile_parameters: {},
      profiles: {},
      session_parameters: {},
      sessions: {},
    },
    pinned: {[ALIAS]: testProject()},
    project: testProject(),
  } as unknown as ProjectGraphs;
}

/** What `editWorkflow` does: resolve the clone and the plain id, then change that project. */
function edited(
  snapshot: ProjectGraphs,
  key: string,
  change: (project: mutate.Project, workflow: string) => mutate.Project,
): {project: mutate.Project; root: string} {
  const at = subroutineFile('/w/mine', key, snapshot.pinned ?? {});
  const {id, project} = projectIn(snapshot, key);
  return {project: change(project, id), root: at.root};
}

function nodes(project: mutate.Project, id = SUBROUTINE) {
  return (
    subroutineInProject(project, id) as unknown as Record<string, unknown>
  ).nodes as Array<Record<string, unknown>>;
}

test('a pinned workflow is edited in its own project, under its own id', () => {
  const snapshot = world();

  // The plain id, or `mutate` refuses -- which is the error the author actually saw.
  assert.equal(projectIn(snapshot, KEY).id, SUBROUTINE);
  assert.equal(
    subroutineFile('/w/mine', KEY, snapshot.pinned ?? {}).root,
    path.join('/w/mine', 'external', 'local', 'tools'),
  );
  // And this project's own workflows are untouched by the split.
  assert.equal(projectIn(snapshot, 'main').id, 'main');
  assert.equal(
    subroutineFile('/w/mine', 'main', snapshot.pinned ?? {}).root,
    '/w/mine',
  );

  // Handing `mutate` the composite id is the bug, and it fails loudly rather than quietly.
  assert.throws(
    () => mutate.addNode(projectIn(snapshot, KEY).project, KEY, 'python', 'X'),
    /no subroutine local\.tools\/main/,
    'the composite id must never reach `mutate`',
  );
});

test('every gesture lands in the pinned project and leaves this one alone', () => {
  const snapshot = world();
  const mine = JSON.stringify(snapshot.project);

  // Add a node -- the gesture that reported nothing at all.
  const added = edited(
    snapshot,
    KEY,
    (project, workflow) =>
      mutate.addNode(project, workflow, 'python', 'Measure').project,
  );
  assert.ok(nodes(added.project).some(node => node.id === 'measure'));
  assert.ok(added.root.endsWith(path.join('external', 'local', 'tools')));

  // Delete one -- the gesture that said "no workflow … in this project".
  const removed = edited(
    snapshot,
    KEY,
    (project, workflow) =>
      mutate.remove(project, workflow, 'nodes', 'prepare_optimization').project,
  );
  assert.ok(
    !nodes(removed.project).some(node => node.id === 'prepare_optimization'),
  );

  // Rename the label, constrain an edge, and assign an agent's resources.
  const named = edited(snapshot, KEY, (project, workflow) =>
    mutate.setName(project, workflow, 'nodes', 'profile', 'Profile it'),
  );
  assert.equal(
    nodes(named.project).find(n => n.id === 'profile')!.name,
    'Profile it',
  );

  const constrained = edited(snapshot, KEY, (project, workflow) =>
    mutate.constrain(
      project,
      workflow,
      'profile_analyze',
      'conditions',
      'remaining_iterations',
      'greater_zero',
    ),
  );
  const edge = subroutineInProject(constrained.project, SUBROUTINE)!.edges.find(
    item => item.id === 'profile_analyze',
  )!;
  assert.deepEqual(edge.conditions, [
    {feature_id: 'remaining_iterations', observation: 'greater_zero'},
  ]);

  const assigned = edited(snapshot, KEY, (project, workflow) =>
    mutate.setNodeResources(
      {...snapshot, project: project as ProjectGraphs['project']},
      workflow,
      'plan',
      [
        {resource: 'profile', value: 'default'},
        {resource: 'session', value: 'optimize'},
      ],
    ),
  );
  assert.deepEqual(
    nodes(assigned.project).find(node => node.id === 'plan')!.operation,
    {profile: 'default', session: 'optimize'},
    'agent resources in a dependency are edited in the owning project',
  );

  // Placing nodes, which is what `tidy` and a drag both write.
  const placed = edited(snapshot, KEY, (project, workflow) =>
    mutate.moved(project, workflow, {profile: {x: 10, y: 20}}),
  );
  assert.ok(placed.project.editor !== undefined);

  // Throughout: this project's own graph is byte-identical. A gesture aimed at a dependency
  // must never touch the graph that pins it.
  assert.equal(JSON.stringify(snapshot.project), mine);
});

test('generation runs in the clone that owns the workflow, not the one that pins it', () => {
  // `verdog generate` turns a graph into code, so the clone it runs in has to follow what
  // the canvas is showing. Running it only in this project would leave a node added to a
  // pinned workflow without its scaffold -- which reads exactly like "adding a node does
  // nothing".
  //
  // A submodule is a usable clone for this: `open_clone` accepts it even though its `.git` is a
  // file rather than a directory, and it finds the package and origin from the submodule itself.
  const pinned = {'local.tools': {}};
  assert.equal(
    subroutineFile('/w/mine', `local.tools/${SUBROUTINE}`, pinned).root,
    path.join('/w/mine', 'external', 'local', 'tools'),
  );
  // And your own workflows still generate here.
  assert.equal(subroutineFile('/w/mine', 'main', pinned).root, '/w/mine');
  // Canonical package components are nested filesystem directories.
  assert.equal(
    subroutineFile('/w/mine', 'drexlerd.pyverdog_lgp/main', {
      'drexlerd.pyverdog_lgp': {},
    }).root,
    path.join('/w/mine', 'external', 'drexlerd', 'pyverdog_lgp'),
  );
});
