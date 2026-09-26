/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Editing the graph: what a canvas gesture does to `project.json`.
 *
 * Pure functions over a parsed project, so they can be tested without an editor and without a
 * service. They are deliberately not validators -- `verdog check` is the authority, and it
 * says exactly what is wrong and where. What these owe the author is a *plausible* document:
 * ids that are free, module paths that name the right module, and no dangling reference left
 * behind by a deletion. Getting those three wrong is what makes hand-editing tedious.
 *
 * Nothing here writes a file. `projectHost.edit` applies changes through the editor, so canvas
 * actions share the typing undo stack and cannot clobber unsaved edits.
 */

import {defaultAgentInvokerOptions} from './agents';
import {visitDocumentPaths} from './documents';
import {isFeatureKind, observationsFor, type FeatureKind} from './features';
import {
  agentProfileId,
  agentSessionId,
  edgeId,
  featureId,
  graphId,
  nodeId,
  parseQualifiedSubroutineTarget,
  qualifiedSubroutineTarget,
  type AgentProfileId,
  type AgentSessionId,
  type EdgeId,
  type FeatureId,
  type GraphId,
  type NodeId,
} from './identifiers';
import {
  definitionIdentifierProblem,
  identifierProblem,
  KEYWORDS,
  packageDirectory,
  packageProblem,
} from './names';
import {
  subroutinesIn,
  subroutineInProject,
  definitionIn,
  definitionKey,
  definitionPath,
  definitionIndex,
  CALL_DEFINITION_KIND,
  DEFINITION_KIND,
  edgeDirectionProblem,
  graphLeaf,
  qualifyGraph,
  visibleDefinitions,
  workflowId,
  type CallNodeKind,
  type CanonicalObject,
  type DefinitionKind,
  type Definition,
  type ExecutableNodeKind,
  type AgentInvokerOptions,
  type AgentProvider,
  type LocalWorkflowDefinition,
  type SubroutineCallArguments,
  type SubroutineDefinition,
} from './project';
import {array, entries, object} from './reading';
import {
  normalizeNodeResources,
  normalizeWorkflowResources,
  type ResourceSelection,
} from './resources';
import {projectIn, type ProjectGraphs} from './snapshot';

export interface Position {
  x: number;
  y: number;
}

export type AuthoredFileEdit =
  | {kind: 'delete'; path: string}
  | {from: string; kind: 'rename'; to: string}
  | {kind: 'require_absent'; path: string};

export type Entity =
  | 'edges'
  | 'features'
  | 'nodes'
  | 'profile_parameters'
  | 'profiles'
  | 'session_parameters'
  | 'sessions'
  | 'subroutines'
  | 'workflows';

export type RemovalReason =
  | 'selected'
  | 'contained'
  | 'attached'
  | 'calls_deleted_target'
  | 'wraps_deleted_subroutine'
  | 'uses_deleted_resource'
  | 'reference_removed'
  | 'reset';

export interface RemovalImpact {
  effect: 'delete' | 'update';
  entity: Entity;
  id: string;
  /** Canonical ancestry, including the boundary for a workflow-owned entity. */
  scope: GraphId[];
  reasons: RemovalReason[];
  /** Workflow boundary that owns this entity, when it is not subroutine-owned. */
  workflow?: GraphId;
}

export interface RemovalPlan {
  code: string[];
  impacts: RemovalImpact[];
  orphaned: string[];
  project: Project;
  reset?: true;
}

export type EntityIdentifier<Kind extends Entity> = Kind extends 'edges'
  ? EdgeId
  : Kind extends 'features'
    ? FeatureId
    : Kind extends 'nodes'
      ? NodeId
      : Kind extends 'profile_parameters' | 'profiles'
        ? AgentProfileId
        : Kind extends 'session_parameters' | 'sessions'
          ? AgentSessionId
          : Kind extends 'subroutines' | 'workflows'
            ? GraphId
            : never;

export interface AgentAssignment {
  profile: AgentProfileId;
  session: AgentSessionId;
}

function agentProfile(
  id: AgentProfileId,
  name: string,
  provider: AgentProvider = 'codex',
) {
  return {
    id,
    name,
    provider,
    options: defaultAgentInvokerOptions(),
  };
}

/** The parsed `project.json`. Deliberately loose: the compiler owns the shape. */
export type Project = CanonicalObject;

/** The operation a newly-authored node of this kind needs. */
function nodeOperation(
  kind: ExecutableNodeKind,
  detail?: AgentAssignment,
): Record<string, unknown> {
  switch (kind) {
    case 'agent': {
      if (detail === undefined) {
        throw new Error('an agent needs a profile and session');
      }
      return {...detail};
    }
    case 'feature':
    case 'python':
      return {};
    default: {
      const unknown: never = kind;
      throw new Error(`unknown node kind ${String(unknown)}`);
    }
  }
}

/**
 * A free identifier derived from a name.
 *
 * Only *live* ids are avoided. A name that is no longer used becomes available again: there
 * is nothing to protect it any more, because a dependency is a repository at a commit and a
 * name freed in a later commit cannot reach anyone who pinned an earlier one.
 */
export function identifier(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_{2,}/g, '_')
      .replace(/^([0-9])/, 'n$1') || 'entity';
  const safe = KEYWORDS.has(base) ? `${base}_step` : base;
  if (!used.has(safe)) {
    return safe;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${safe}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** Endpoint-readable edge ids; `__N` is reserved for parallel edges. */
function derivedEdgeId(
  source: NodeId,
  target: NodeId,
  taken: Iterable<unknown>,
): EdgeId {
  const used = new Set(Array.from(taken, String));
  const base = `${source}__${target}`;
  if (!used.has(base)) {
    return edgeId(base);
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}__${suffix}`;
    if (!used.has(candidate)) {
      return edgeId(candidate);
    }
  }
}

function isDerivedEdgeId(id: EdgeId, source: NodeId, target: NodeId): boolean {
  const base = `${source}__${target}`;
  if (id === base) {
    return true;
  }
  if (!id.startsWith(`${base}__`)) {
    return false;
  }
  return /^(?:[2-9]|[1-9][0-9]+)$/.test(id.slice(base.length + 2));
}

function subroutineGraph(
  project: Project,
  subroutineId: GraphId,
  index?: DefinitionIndex,
): Record<string, unknown> {
  const found =
    index?.subroutines.get(subroutineId) ??
    subroutineInProject(project, subroutineId);
  if (found === undefined) {
    throw new Error(`no subroutine ${subroutineId} in this project`);
  }
  return found;
}

/** The ids already used for one kind of entity in one subroutine. */
function names(
  project: Project,
  subroutineId: GraphId,
  kind: Entity,
): string[] {
  return entries(subroutineGraph(project, subroutineId)[kind]).map(item =>
    String(item.id),
  );
}

/** Executable nodes have their own scope-local namespace. */
function bodyEntityNames(project: Project, subroutineId: GraphId): string[] {
  return names(project, subroutineId, 'nodes');
}

export function emptySubroutine(
  id: string,
  name: string,
): SubroutineDefinition {
  return {
    edges: [
      {
        conditions: [],
        effects: [],
        id: edgeId('enter__exit'),
        name: 'Pass through',
        source: nodeId('enter'),
        target: nodeId('exit'),
      },
    ],
    features: [],
    id: graphId(id),
    name,
    nodes: [
      {id: nodeId('enter'), name: 'Enter', kind: 'enter', operation: {}},
      {id: nodeId('exit'), name: 'Exit', kind: 'exit', operation: {}},
      {id: nodeId('failure'), name: 'Failure', kind: 'failure', operation: {}},
    ],
    ports: {
      enter: nodeId('enter'),
      exit: nodeId('exit'),
      failure: nodeId('failure'),
    },
    profile_parameters: [],
    profiles: [],
    session_parameters: [],
    sessions: [],
    subroutines: [],
    workflows: [],
  };
}

/** Add a new graph definition. */
export function addSubroutineDefinition(
  project: Project,
  name: string,
  parentId: GraphId,
): {id: GraphId; project: Project} {
  const next = structuredClone(project);
  const taken = names(next, parentId, 'subroutines');
  const id = graphId(identifier(name, taken));
  const parent = subroutineGraph(next, parentId);
  parent.subroutines = [
    ...array(parent.subroutines),
    emptySubroutine(id, name.trim() || id),
  ];
  return {id: qualifyGraph(parentId, id), project: next};
}

/** Wrap one visible subroutine in its own process, without creating another graph. */
export function addWorkflowDefinition(
  project: Project,
  parentId: GraphId,
  subroutineId: GraphId,
): {id: GraphId; project: Project} {
  const next = structuredClone(project);
  const target = visibleDefinitions(next, parentId, 'subroutine').find(
    definition => definition.id === subroutineId,
  );
  if (target === undefined) {
    throw new Error(
      `${subroutineId} is not a visible subroutine in ${parentId}`,
    );
  }
  if (target.subroutine === undefined) {
    throw new Error(`${subroutineId} has no local subroutine declaration`);
  }
  const id = qualifyGraph(parentId, graphLeaf(subroutineId));
  if (definitionIn(next, 'workflow', id) !== undefined) {
    throw new Error(`${subroutineId} already has a workflow definition`);
  }
  const parent = subroutineGraph(next, parentId);
  const profileArguments = Object.fromEntries(
    target.subroutine.profile_parameters.map(({id}) => [id, id]),
  ) as SubroutineCallArguments['profile_arguments'];
  const sessionArguments = Object.fromEntries(
    target.subroutine.session_parameters.map(({id}) => [id, id]),
  ) as SubroutineCallArguments['session_arguments'];
  parent.workflows = [
    ...array(parent.workflows),
    {
      subroutine: subroutineId,
      profiles: target.subroutine.profile_parameters.map(({id, name}) =>
        agentProfile(id, name),
      ),
      sessions: target.subroutine.session_parameters.map(({id, name}) => ({
        id,
        name,
        persistent: true,
      })),
      profile_arguments: profileArguments,
      session_arguments: sessionArguments,
    },
  ];
  return {id, project: next};
}

/**
 * Add a node.
 *
 * Nothing connects it: an unreachable node is a diagnostic, not a silent failure, and joining
 * it up is the next gesture rather than a guess about which edge the author meant to split.
 */
export function addNode(
  project: Project,
  subroutineId: GraphId,
  kind: ExecutableNodeKind,
  name: string,
  position?: Position,
  detail?: AgentAssignment,
): {id: NodeId; project: Project} {
  const next = structuredClone(project);
  const target = subroutineGraph(next, subroutineId);
  const id = nodeId(identifier(name, bodyEntityNames(next, subroutineId)));
  const node: Record<string, unknown> = {
    id,
    name: name.trim() || id,
    kind,
    operation: nodeOperation(kind, detail),
  };
  target.nodes = [...array(target.nodes), node];
  if (position !== undefined) {
    place(next, subroutineId, {[id]: position});
  }
  return {id, project: next};
}

/** Add a call to one visible definition. Definitions and invocations are separate gestures. */
export function addCall(
  project: Project,
  subroutineId: GraphId,
  kind: CallNodeKind,
  name: string,
  target: GraphId | ReturnType<typeof qualifiedSubroutineTarget>,
  position?: Position,
  args?: SubroutineCallArguments,
): {id: NodeId; project: Project} {
  const expected: DefinitionKind = CALL_DEFINITION_KIND[kind];
  const external =
    kind === 'subroutine_call'
      ? parseQualifiedSubroutineTarget(target)
      : undefined;
  const externalSubroutine =
    external !== undefined &&
    packageProblem(external.alias) === undefined &&
    definitionIdentifierProblem(external.subroutine) === undefined;
  if (
    !externalSubroutine &&
    !visibleDefinitions(project, subroutineId, expected).some(
      definition => definition.id === target,
    )
  ) {
    throw new Error(
      `${target} is not a visible ${expected} in ${subroutineId}`,
    );
  }
  const next = structuredClone(project);
  const body = subroutineGraph(next, subroutineId);
  if (kind === 'subroutine_call' && args === undefined) {
    throw new Error('a subroutine call needs profile and session arguments');
  }
  if (kind === 'workflow_call' && args !== undefined) {
    throw new Error('a workflow call cannot bind in-process resources');
  }
  const id = nodeId(identifier(name, bodyEntityNames(next, subroutineId)));
  body.nodes = [
    ...array(body.nodes),
    {
      id,
      kind,
      name: name.trim() || id,
      operation: {target, ...(args ?? {})},
    },
  ];
  if (position !== undefined) {
    place(next, subroutineId, {[id]: position});
  }
  return {id, project: next};
}

/**
 * Add a feature. Its `description` is required and non-empty -- an agent reads it.
 *
 * Scalar features have four keys; an enum also carries its declared `values`. This used to
 * write an `implementation` pointing at
 * `features/<id>/impl`, from when the graph carried module paths; it stopped
 * carrying them, and the compiler refuses the key outright -- `features[0] has unknown
 * keys: implementation` -- so every feature added from the canvas made the project fail to
 * load. The path is derived from the id, exactly as a node's is.
 */
export function addFeature(
  project: Project,
  subroutineId: GraphId,
  kind: FeatureKind,
  label: string,
  description: string,
  values?: readonly string[],
): {id: FeatureId; project: Project} {
  const next = structuredClone(project);
  const target = subroutineGraph(next, subroutineId);
  const id = featureId(
    identifier(label, names(next, subroutineId, 'features')),
  );
  const members =
    kind === 'enum'
      ? (values ?? []).map(value => value.trim()).filter(Boolean)
      : [];
  if (kind === 'enum') {
    if (members.length === 0) {
      throw new Error('an enum feature needs at least one value');
    }
    const problem = members
      .map(identifierProblem)
      .find(item => item !== undefined);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    if (new Set(members).size !== members.length) {
      throw new Error("an enum feature's values must be unique");
    }
  }
  target.features = [
    ...array(target.features),
    {
      id,
      label: label.trim() || id,
      description: description.trim() || label.trim() || id,
      kind,
      ...(kind === 'enum' ? {values: members} : {}),
    },
  ];
  return {id, project: next};
}

export type AgentResourceCollection =
  'profile_parameters' | 'profiles' | 'session_parameters' | 'sessions';

function agentResourceNames(
  project: Project,
  subroutineId: GraphId,
  collections: readonly AgentResourceCollection[],
): string[] {
  const graph = subroutineGraph(project, subroutineId);
  return collections.flatMap(collection =>
    entries(graph[collection]).map(item => String(item.id)),
  );
}

function localWorkflow(project: Project, id: GraphId): LocalWorkflowDefinition {
  const workflow = definitionIn(project, 'workflow', id)?.workflow;
  if (workflow === undefined) {
    throw new Error(`no local workflow ${id}`);
  }
  return workflow;
}

/** Add a locally-owned profile or a formal profile parameter. */
export function addAgentProfile(
  project: Project,
  subroutineId: GraphId,
  name: string,
  parameter: boolean,
): {id: AgentProfileId; project: Project} {
  const next = structuredClone(project);
  const graph = subroutineGraph(next, subroutineId);
  const collection = parameter ? 'profile_parameters' : 'profiles';
  const id = agentProfileId(
    identifier(
      name,
      agentResourceNames(next, subroutineId, [
        'profile_parameters',
        'profiles',
      ]),
    ),
  );
  graph[collection] = [
    ...array(graph[collection]),
    parameter
      ? {id, name: name.trim() || id}
      : agentProfile(id, name.trim() || id),
  ];
  if (parameter) {
    for (const definition of workflowsTargeting(
      definitionIndex(next),
      subroutineId,
    )) {
      const workflow = definition.workflow;
      if (workflow === undefined) {
        continue;
      }
      workflow.profile_arguments[id] = id;
      if (!workflow.profiles.some(profile => profile.id === id)) {
        workflow.profiles.push(agentProfile(id, name.trim() || id));
      }
    }
  }
  return {id, project: next};
}

/** Add a locally-owned session or a formal session parameter. */
export function addAgentSession(
  project: Project,
  subroutineId: GraphId,
  name: string,
  parameter: boolean,
  persistent?: boolean,
): {id: AgentSessionId; project: Project} {
  if (!parameter && persistent === undefined) {
    throw new Error('a local session needs persistence');
  }
  const next = structuredClone(project);
  const graph = subroutineGraph(next, subroutineId);
  const collection = parameter ? 'session_parameters' : 'sessions';
  const id = agentSessionId(
    identifier(
      name,
      agentResourceNames(next, subroutineId, [
        'session_parameters',
        'sessions',
      ]),
    ),
  );
  graph[collection] = [
    ...array(graph[collection]),
    {
      id,
      name: name.trim() || id,
      ...(parameter ? {} : {persistent}),
    },
  ];
  if (parameter) {
    for (const definition of workflowsTargeting(
      definitionIndex(next),
      subroutineId,
    )) {
      const workflow = definition.workflow;
      if (workflow === undefined) {
        continue;
      }
      workflow.session_arguments[id] = id;
      if (!workflow.sessions.some(session => session.id === id)) {
        workflow.sessions.push({id, name: name.trim() || id, persistent: true});
      }
    }
  }
  return {id, project: next};
}

/** Add a concrete profile owned by a workflow boundary. */
export function addWorkflowProfile(
  project: Project,
  workflowId: GraphId,
  name: string,
): {id: AgentProfileId; project: Project} {
  const next = structuredClone(project);
  const workflow = localWorkflow(next, workflowId);
  const id = agentProfileId(
    identifier(
      name,
      workflow.profiles.map(({id}) => id),
    ),
  );
  workflow.profiles.push(agentProfile(id, name.trim() || id));
  return {id, project: next};
}

/** Add a concrete session owned by a workflow boundary. */
export function addWorkflowSession(
  project: Project,
  workflowId: GraphId,
  name: string,
  persistent: boolean,
): {id: AgentSessionId; project: Project} {
  const next = structuredClone(project);
  const workflow = localWorkflow(next, workflowId);
  const id = agentSessionId(
    identifier(
      name,
      workflow.sessions.map(({id}) => id),
    ),
  );
  workflow.sessions.push({id, name: name.trim() || id, persistent});
  return {id, project: next};
}

/** Connect two nodes. The edge carries no constraints yet; those are the next gesture. */
export function connect(
  project: Project,
  subroutineId: GraphId,
  source: NodeId,
  target: NodeId,
): {files: AuthoredFileEdit[]; id: EdgeId; project: Project} {
  const next = structuredClone(project);
  const graph = subroutineGraph(next, subroutineId);
  const nodes = (graph as SubroutineDefinition).nodes;
  const from = nodes.find(node => node.id === source);
  const to = nodes.find(node => node.id === target);
  if (from === undefined) {
    throw new Error(`no node ${source} in ${subroutineId}`);
  }
  if (to === undefined) {
    throw new Error(`no node ${target} in ${subroutineId}`);
  }
  const problem = edgeDirectionProblem(from.kind, to.kind);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const id = derivedEdgeId(source, target, names(next, subroutineId, 'edges'));
  const edge = {
    id,
    name: `${source} ${target}`,
    source,
    target,
    conditions: [],
    effects: [],
  };
  graph.edges = [...array(graph.edges), edge];
  const implementation = edgeImplementationPath(next, subroutineId, edge);
  return {
    files:
      implementation === undefined
        ? []
        : [{kind: 'require_absent', path: implementation}],
    id,
    project: next,
  };
}

/** Point an existing edge at different nodes without changing what the edge means. */
export function relink(
  project: Project,
  subroutineId: GraphId,
  edgeId: EdgeId,
  source: NodeId,
  target: NodeId,
  implementation: 'move' | 'fresh' = 'move',
): {
  files: AuthoredFileEdit[];
  newImplementation?: string;
  oldImplementation?: string;
  project: Project;
} {
  const next = structuredClone(project);
  const graph = subroutineGraph(next, subroutineId) as SubroutineDefinition;
  const edge = graph.edges.find(item => item.id === edgeId);
  if (edge === undefined) {
    throw new Error(`no edge ${edgeId} in ${subroutineId}`);
  }
  if (
    edge.id.includes('__') &&
    !isDerivedEdgeId(edge.id, edge.source, edge.target)
  ) {
    throw new Error(`derived edge id ${edge.id} does not match its endpoints`);
  }
  const oldImplementation = edgeImplementationPath(next, subroutineId, edge);
  const from = graph.nodes.find(node => node.id === source);
  const to = graph.nodes.find(node => node.id === target);
  if (from === undefined) {
    throw new Error(`no node ${source} in ${subroutineId}`);
  }
  if (to === undefined) {
    throw new Error(`no node ${target} in ${subroutineId}`);
  }
  const problem = edgeDirectionProblem(from.kind, to.kind);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  if (from.kind !== 'feature' && entries(edge.effects).length > 0) {
    throw new Error('only an edge from a feature node can declare effects');
  }
  const otherIds = graph.edges
    .filter(item => item !== edge)
    .map(item => item.id);
  const generatedId = isDerivedEdgeId(edge.id, edge.source, edge.target);
  const generatedName = edge.name === `${edge.source} ${edge.target}`;
  if (generatedId) {
    edge.id = derivedEdgeId(source, target, otherIds);
  }
  if (generatedName) {
    edge.name = `${source} ${target}`;
  }
  edge.source = source;
  edge.target = target;
  const newImplementation = edgeImplementationPath(next, subroutineId, edge);
  const files: AuthoredFileEdit[] = [];
  if (oldImplementation !== newImplementation) {
    if (
      oldImplementation !== undefined &&
      newImplementation !== undefined &&
      implementation === 'move'
    ) {
      moveSource(next, oldImplementation, newImplementation);
      files.push({
        from: oldImplementation,
        kind: 'rename',
        to: newImplementation,
      });
    } else {
      if (oldImplementation !== undefined) {
        withoutPath(next, oldImplementation);
        files.push({kind: 'delete', path: oldImplementation});
      }
      if (newImplementation !== undefined) {
        files.push({kind: 'require_absent', path: newImplementation});
      }
    }
  }
  return {
    files,
    ...(newImplementation === undefined ? {} : {newImplementation}),
    ...(oldImplementation === undefined ? {} : {oldImplementation}),
    project: next,
  };
}

/**
 * Remove a node, edge or feature, and everything that would dangle without it.
 *
 * A node takes its edges: leaving an edge pointing at a node that is gone is a broken graph,
 * and the author asked to delete a node, not to be told about the consequences. A feature takes
 * its observations for the same reason. A port node is refused, because a subroutine without an
 * `enter` cannot be entered.
 *
 * Nothing is recorded. The name is simply free again — and it can be, because a dependency is
 * a repository at a commit: whoever pinned the release that had a `measure` node still has it,
 * frozen, and a later commit that gives the name to something else cannot reach them.
 *
 * The entity's files leave `sources` with it, and `code` names the files or directories the
 * caller moves to the OS trash before saving the graph. Both halves are needed and neither is
 * sufficient: the manifest prune is what keeps `verdog check` alive, because `Clone.files()`
 * reads every listed path and raises on a missing one; removing the files is what keeps `ty`
 * quiet, because `ty` walks the working tree rather than the manifest. Returning both from this
 * one mutation keeps every caller on the same lifecycle.
 */
type ContainedEntity = Exclude<Entity, 'subroutines' | 'workflows'>;

const CONTAINED_ENTITIES = Object.keys({
  nodes: true,
  edges: true,
  features: true,
  profile_parameters: true,
  profiles: true,
  session_parameters: true,
  sessions: true,
} satisfies Record<ContainedEntity, true>) as readonly ContainedEntity[];

type DefinitionIndex = ReturnType<typeof definitionIndex>;

function workflowsTargeting(index: DefinitionIndex, subroutineId: GraphId) {
  return [...index.definitions.values()].filter(
    definition => definition.workflow?.subroutine === subroutineId,
  );
}

function removalScope(index: DefinitionIndex, owner: GraphId): GraphId[] {
  const result: GraphId[] = [];
  const seen = new Set<GraphId>();
  for (
    let current: GraphId | undefined = owner;
    current !== undefined && !seen.has(current);
    current = index.parents.get(current)
  ) {
    seen.add(current);
    result.unshift(current);
  }
  return result;
}

function removalImpact(
  index: DefinitionIndex,
  owner: GraphId,
  effect: RemovalImpact['effect'],
  entity: Entity,
  id: string,
  reason: RemovalReason,
  workflow?: GraphId,
): RemovalImpact {
  const scope = removalScope(index, owner);
  if (workflow !== undefined && scope.at(-1) !== workflow) {
    scope.push(workflow);
  }
  return {
    effect,
    entity,
    id,
    scope,
    reasons: [reason],
    ...(workflow === undefined ? {} : {workflow}),
  };
}

/** One row per scoped identity. A deletion absorbs an update to the same identity. */
function mergeRemovalImpacts(
  ...groups: readonly RemovalImpact[][]
): RemovalImpact[] {
  const result: RemovalImpact[] = [];
  const byIdentity = new Map<string, RemovalImpact>();
  for (const impact of groups.flat()) {
    const key = `${impact.scope.join('\0')}\0${impact.workflow ?? ''}\0${impact.entity}\0${impact.id}`;
    const found = byIdentity.get(key);
    if (found === undefined) {
      const copy = {
        ...impact,
        scope: [...impact.scope],
        reasons: [...impact.reasons],
      };
      byIdentity.set(key, copy);
      result.push(copy);
      continue;
    }
    if (impact.effect === 'delete') {
      found.effect = 'delete';
    }
    for (const reason of impact.reasons) {
      if (!found.reasons.includes(reason)) {
        found.reasons.push(reason);
      }
    }
  }
  return result;
}

/** Keep only the outermost trash roots, without changing their reported order. */
function compactDeletedCode(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    path =>
      !unique.some(parent => parent !== path && path.startsWith(`${parent}/`)),
  );
}

function removalPlan(
  project: Project,
  code: readonly string[],
  impacts: readonly RemovalImpact[],
  reset = false,
): RemovalPlan {
  return {
    code: compactDeletedCode(code),
    impacts: mergeRemovalImpacts([...impacts]),
    orphaned: [],
    project,
    ...(reset ? {reset: true as const} : {}),
  };
}

export function remove<Kind extends Entity>(
  project: Project,
  subroutineId: GraphId,
  kind: Kind,
  id: EntityIdentifier<Kind>,
  workflow?: GraphId,
): RemovalPlan {
  const next = structuredClone(project);
  const index = definitionIndex(next);
  const duplicate = index.duplicates.values().next().value;
  if (duplicate !== undefined) {
    const [kind, id] = duplicate.split(':', 2);
    throw new Error(`duplicate ${kind} definition ${id}`);
  }
  const alreadyOrphaned = new Set(orphanedPins(next, index));
  const result =
    workflow === undefined
      ? removeBecause(next, index, subroutineId, kind, id, 'selected')
      : removeWorkflowResource(next, index, subroutineId, workflow, kind, id);
  return {
    ...result,
    orphaned: orphanedPins(result.project).filter(
      alias => !alreadyOrphaned.has(alias),
    ),
  };
}

function removeWorkflowResource<Kind extends Entity>(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  workflowId: GraphId,
  kind: Kind,
  id: EntityIdentifier<Kind>,
): RemovalPlan {
  if (kind !== 'profiles' && kind !== 'sessions') {
    throw new Error(`a workflow does not own ${kind}`);
  }
  const definition = index.definitions.get(
    definitionKey('workflow', workflowId),
  );
  const workflow = definition?.workflow;
  if (
    definition === undefined ||
    workflow === undefined ||
    (definition.declaredIn ?? definition.target) !== subroutineId
  ) {
    throw new Error(`no local workflow ${workflowId} in ${subroutineId}`);
  }

  const resourceId = String(id);
  const resources = kind === 'profiles' ? workflow.profiles : workflow.sessions;
  if (!resources.some(resource => resource.id === resourceId)) {
    throw new Error(`no workflow ${kind.slice(0, -1)} ${resourceId}`);
  }
  const args =
    kind === 'profiles'
      ? workflow.profile_arguments
      : workflow.session_arguments;
  if (Object.values(args).includes(resourceId)) {
    throw new Error(
      `workflow ${kind.slice(0, -1)} ${resourceId} is bound; rebind it before deleting it`,
    );
  }

  if (kind === 'profiles') {
    workflow.profiles = workflow.profiles.filter(
      resource => resource.id !== resourceId,
    );
  } else {
    workflow.sessions = workflow.sessions.filter(
      resource => resource.id !== resourceId,
    );
  }
  const directory = entityCode(
    project,
    workflowId,
    kind,
    resourceId,
    index,
    'workflow',
  );
  if (directory !== undefined) {
    withoutDirectory(project, directory);
  }
  return removalPlan(project, directory === undefined ? [] : [directory], [
    removalImpact(
      index,
      subroutineId,
      'delete',
      kind,
      resourceId,
      'selected',
      workflowId,
    ),
  ]);
}

function removeBecause<Kind extends Entity>(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: Kind,
  id: EntityIdentifier<Kind>,
  reason: RemovalReason,
): RemovalPlan {
  switch (kind) {
    case 'workflows':
    case 'subroutines':
      return removeDefinition(project, index, subroutineId, kind, id, reason);
    case 'profiles':
    case 'profile_parameters':
    case 'sessions':
    case 'session_parameters':
      return removeAgentResource(
        project,
        index,
        subroutineId,
        kind,
        id,
        reason,
      );
    case 'nodes':
      return removeNode(project, index, subroutineId, kind, id, reason);
    case 'features':
      return removeFeature(project, index, subroutineId, kind, id, reason);
    case 'edges':
      return removeEdge(project, index, subroutineId, kind, id, reason);
    default:
      throw new Error(`unknown entity ${String(kind)}`);
  }
}

/** Finds the contained definitions and outside wrappers affected by deletion. */
function definitionsToRemove(
  index: DefinitionIndex,
  definitionKind: DefinitionKind,
  definitionId: GraphId,
) {
  const removedSubroutines = new Set<GraphId>();
  if (definitionKind === 'subroutine') {
    for (const candidate of index.subroutines.keys()) {
      for (
        let parent: GraphId | undefined = candidate;
        parent !== undefined;
        parent = index.parents.get(parent)
      ) {
        if (parent === definitionId) {
          removedSubroutines.add(candidate);
          break;
        }
      }
    }
  }

  const removedWorkflows = new Set<GraphId>(
    definitionKind === 'workflow' ? [definitionId] : [],
  );
  const outsideWrappers: Array<Definition & {declaredIn: GraphId}> = [];
  for (const definition of index.definitions.values()) {
    if (definition.kind !== 'workflow' || definition.declaredIn === undefined) {
      continue;
    }
    if (removedSubroutines.has(definition.declaredIn)) {
      removedWorkflows.add(definition.id);
      continue;
    }
    const wrapsRemoved =
      definition.external === undefined &&
      definition.target !== undefined &&
      removedSubroutines.has(definition.target);
    if (wrapsRemoved) {
      removedWorkflows.add(definition.id);
      outsideWrappers.push({...definition, declaredIn: definition.declaredIn});
    }
  }

  return {removedSubroutines, removedWorkflows, outsideWrappers};
}

function removedWorkflowResources(
  index: DefinitionIndex,
  workflowsLosingResources: ReadonlySet<GraphId>,
  reason: RemovalReason,
): RemovalImpact[] {
  const impacts: RemovalImpact[] = [];
  for (const workflow of workflowsLosingResources) {
    const definition = index.definitions.get(
      definitionKey('workflow', workflow),
    );
    const owner = definition?.declaredIn ?? definition?.target;
    if (definition?.workflow === undefined || owner === undefined) {
      continue;
    }
    for (const kind of ['profiles', 'sessions'] as const) {
      for (const resource of definition.workflow[kind]) {
        impacts.push(
          removalImpact(
            index,
            owner,
            'delete',
            kind,
            resource.id,
            reason === 'wraps_deleted_subroutine' ? reason : 'contained',
            workflow,
          ),
        );
      }
    }
  }

  return impacts;
}

function callersOfRemovedDefinitions(
  index: DefinitionIndex,
  removedSubroutines: ReadonlySet<GraphId>,
  removedWorkflows: ReadonlySet<GraphId>,
) {
  const callers: Array<{id: NodeId; owner: GraphId}> = [];
  for (const [owner, body] of index.subroutines) {
    if (removedSubroutines.has(owner)) {
      continue;
    }
    for (const node of body.nodes) {
      const target = node.operation?.target;
      const localTarget =
        typeof target === 'string' && !target.includes('/')
          ? graphId(target)
          : undefined;
      if (
        (node.kind === 'workflow_call' &&
          localTarget !== undefined &&
          removedWorkflows.has(localTarget)) ||
        (node.kind === 'subroutine_call' &&
          localTarget !== undefined &&
          removedSubroutines.has(localTarget))
      ) {
        callers.push({id: node.id, owner});
      }
    }
  }

  return callers;
}

function removedSubroutineContents(
  index: DefinitionIndex,
  definitionId: GraphId,
  removedSubroutines: ReadonlySet<GraphId>,
  retainedAfterReset: ReadonlySet<string>,
  resettingRoot: boolean,
): RemovalImpact[] {
  const impacts: RemovalImpact[] = [];
  if (resettingRoot && index.rootWorkflow !== undefined) {
    impacts.push(
      removalImpact(
        index,
        definitionId,
        'update',
        'workflows',
        index.rootWorkflow,
        'reset',
      ),
    );
  }
  for (const definition of index.definitions.values()) {
    if (
      definition.kind === 'subroutine' &&
      removedSubroutines.has(definition.id)
    ) {
      if (
        definition.id !== definitionId &&
        definition.declaredIn !== undefined
      ) {
        impacts.push(
          removalImpact(
            index,
            definition.declaredIn,
            'delete',
            'subroutines',
            definition.id,
            'contained',
          ),
        );
      }
      continue;
    }
    if (
      definition.kind === 'workflow' &&
      definition.declaredIn !== undefined &&
      removedSubroutines.has(definition.declaredIn)
    ) {
      impacts.push(
        removalImpact(
          index,
          definition.declaredIn,
          'delete',
          'workflows',
          definition.id,
          'contained',
        ),
      );
    }
  }
  for (const [owner, body] of index.subroutines) {
    if (!removedSubroutines.has(owner)) {
      continue;
    }
    for (const entity of CONTAINED_ENTITIES) {
      for (const item of entries(body[entity])) {
        const retained =
          owner === definitionId &&
          retainedAfterReset.has(`${entity}:${String(item.id)}`);
        impacts.push(
          removalImpact(
            index,
            owner,
            retained ? 'update' : 'delete',
            entity,
            String(item.id),
            retained ? 'reset' : 'contained',
          ),
        );
      }
    }
  }
  return impacts;
}

function removeDefinition(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: 'subroutines' | 'workflows',
  id: string,
  reason: RemovalReason,
): RemovalPlan {
  const graph = subroutineGraph(project, subroutineId, index);
  const impacts = [
    removalImpact(index, subroutineId, 'delete', kind, String(id), reason),
  ];

  const definitionKind = DEFINITION_KIND[kind];
  const definitionId = graphId(id);
  const selected = index.definitions.get(
    definitionKey(definitionKind, definitionId),
  );
  const resettingRoot =
    definitionKind === 'subroutine' &&
    definitionId === index.rootSubroutine &&
    subroutineId === definitionId;
  if (
    selected === undefined ||
    (!resettingRoot && selected.declaredIn !== subroutineId)
  ) {
    throw new Error(`no ${kind.slice(0, -1)} ${id} in ${subroutineId}`);
  }
  const replacement = resettingRoot
    ? emptySubroutine(selected.localId, selected.name)
    : undefined;
  const retainedAfterReset = new Set([
    ...(replacement?.nodes ?? []).map(node => `nodes:${node.id}`),
    ...(replacement?.edges ?? []).map(edge => `edges:${edge.id}`),
  ]);
  if (resettingRoot) {
    impacts[0].effect = 'update';
    impacts[0].reasons.push('reset');
  }
  const found = resettingRoot
    ? graph
    : entries(graph[kind]).find(definition =>
        definitionKind === 'workflow'
          ? workflowId(definition) === selected.localId
          : definition.id === selected.localId,
      );
  if (found === undefined) {
    throw new Error(`no ${kind.slice(0, -1)} ${id} in ${subroutineId}`);
  }

  const {removedSubroutines, removedWorkflows, outsideWrappers} =
    definitionsToRemove(index, definitionKind, definitionId);

  const outsideWorkflowIds = new Set(outsideWrappers.map(({id}) => id));
  const workflowsLosingResources = new Set(
    [...removedWorkflows].filter(id => !outsideWorkflowIds.has(id)),
  );
  if (resettingRoot && index.rootWorkflow !== undefined) {
    workflowsLosingResources.add(index.rootWorkflow);
  }
  impacts.push(
    ...removedWorkflowResources(
      index,
      workflowsLosingResources,
      definitionKind === 'workflow' ? reason : 'contained',
    ),
  );

  if (definitionKind === 'subroutine') {
    impacts.push(
      ...removedSubroutineContents(
        index,
        definitionId,
        removedSubroutines,
        retainedAfterReset,
        resettingRoot,
      ),
    );
  }

  const callers = callersOfRemovedDefinitions(
    index,
    removedSubroutines,
    removedWorkflows,
  );

  let projectAfter = project;
  const code: string[] = [];
  for (const caller of callers) {
    const result = removeBecause(
      projectAfter,
      index,
      caller.owner,
      'nodes',
      caller.id,
      'calls_deleted_target',
    );
    projectAfter = result.project;
    code.push(...result.code);
    impacts.push(...result.impacts);
  }
  for (const wrapper of outsideWrappers) {
    const result = removeBecause(
      projectAfter,
      index,
      wrapper.declaredIn,
      'workflows',
      wrapper.id,
      'wraps_deleted_subroutine',
    );
    projectAfter = result.project;
    code.push(...result.code);
    impacts.push(...result.impacts);
  }

  const directory = definitionCode(
    projectAfter,
    definitionKind,
    definitionId,
    index,
  );
  const rootWorkflowDirectory =
    resettingRoot && index.rootWorkflow !== undefined
      ? definitionCode(projectAfter, 'workflow', index.rootWorkflow, index)
      : undefined;
  const rootWorkflowImplementation =
    rootWorkflowDirectory === undefined
      ? undefined
      : `${rootWorkflowDirectory}/impl.py`;
  if (directory !== undefined) {
    code.push(directory);
  }
  if (rootWorkflowImplementation !== undefined) {
    code.push(rootWorkflowImplementation);
  }
  if (replacement !== undefined) {
    projectAfter.subroutine = replacement;
    const rootWorkflow = projectAfter.workflow as LocalWorkflowDefinition;
    rootWorkflow.profiles = [];
    rootWorkflow.sessions = [];
    rootWorkflow.profile_arguments = {};
    rootWorkflow.session_arguments = {};
  } else {
    const graphAfter = subroutineGraph(projectAfter, subroutineId, index);
    graphAfter[kind] = entries(graphAfter[kind]).filter(definition =>
      definitionKind === 'workflow'
        ? workflowId(definition) !== selected.localId
        : definition.id !== selected.localId,
    );
  }
  const layouts = object(object(projectAfter.editor).layouts);
  const parentLayout = object(layouts[subroutineId]);
  delete parentLayout[definitionKey(definitionKind, definitionId)];
  layouts[subroutineId] = parentLayout;
  for (const nestedId of removedSubroutines) {
    delete layouts[nestedId];
  }
  if (directory !== undefined) {
    withoutDirectory(projectAfter, directory);
  }
  if (rootWorkflowImplementation !== undefined) {
    withoutPath(projectAfter, rootWorkflowImplementation);
  }
  return removalPlan(projectAfter, code, impacts, resettingRoot);
}

function removeAgentResource(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: AgentResourceCollection,
  id: string,
  reason: RemovalReason,
): RemovalPlan {
  const graph = subroutineGraph(project, subroutineId, index);
  const impacts = [
    removalImpact(index, subroutineId, 'delete', kind, String(id), reason),
  ];

  const collection = kind;
  const field = collection.startsWith('profile') ? 'profile' : 'session';
  const argumentField = `${field}_arguments`;
  const before = entries(graph[collection]);
  if (!before.some(resource => resource.id === id)) {
    throw new Error(`no ${collection.slice(0, -1)} ${id} in ${subroutineId}`);
  }

  // A removed formal no longer belongs in callers. This happens before finding callers that
  // consume the resource, so a recursive self-call does not get deleted merely because its
  // now-removed formal happened to map to itself.
  if (collection.endsWith('_parameters')) {
    for (const [owner, body] of index.subroutines) {
      for (const node of body.nodes) {
        if (
          node.kind !== 'subroutine_call' ||
          node.operation.target !== subroutineId
        ) {
          continue;
        }
        const args = object(node.operation[argumentField]);
        if (id in args) {
          delete args[id];
          impacts.push(
            removalImpact(
              index,
              owner,
              'update',
              'nodes',
              node.id,
              'reference_removed',
            ),
          );
        }
      }
    }
    for (const definition of workflowsTargeting(index, subroutineId)) {
      const args = object(definition.workflow?.[argumentField]);
      if (!(id in args)) {
        continue;
      }
      delete args[String(id)];
      const owner = definition.declaredIn ?? definition.target;
      if (owner !== undefined) {
        impacts.push(
          removalImpact(
            index,
            owner,
            'update',
            'workflows',
            definition.id,
            'reference_removed',
          ),
        );
      }
    }
  }

  const usedBy = entries(graph.nodes)
    .filter(node => {
      const operation = object(node.operation);
      return node.kind === 'agent'
        ? operation[field] === id
        : node.kind === 'subroutine_call' &&
            Object.values(object(operation[argumentField])).includes(id);
    })
    .map(node => nodeId(String(node.id)));
  let projectAfter = project;
  const code: string[] = [];
  for (const node of usedBy) {
    const result = removeBecause(
      projectAfter,
      index,
      subroutineId,
      'nodes',
      node,
      'uses_deleted_resource',
    );
    projectAfter = result.project;
    code.push(...result.code);
    impacts.push(...result.impacts);
  }
  const graphAfter = subroutineGraph(projectAfter, subroutineId, index);
  graphAfter[collection] = entries(graphAfter[collection]).filter(
    resource => resource.id !== id,
  );
  const directory = entityCode(
    projectAfter,
    subroutineId,
    collection,
    id,
    index,
  );
  if (directory !== undefined) {
    code.push(directory);
    withoutDirectory(projectAfter, directory);
  }
  return removalPlan(projectAfter, code, impacts);
}

function removeNode(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: 'nodes',
  id: string,
  reason: RemovalReason,
): RemovalPlan {
  const graph = subroutineGraph(project, subroutineId, index);
  const impacts = [
    removalImpact(index, subroutineId, 'delete', kind, String(id), reason),
  ];

  const ports = object(graph.ports);
  const port = Object.entries(ports).find(([, value]) => value === id);
  if (port !== undefined) {
    throw new Error(
      `${id} is this subroutine's ${port[0]} port: every subroutine needs one, so it cannot be removed`,
    );
  }
  if (!entries(graph.nodes).some(node => node.id === id)) {
    throw new Error(`no node ${id} in ${subroutineId}`);
  }
  const attached = entries(graph.edges).filter(
    edge => edge.source === id || edge.target === id,
  );
  const directory = entityCode(project, subroutineId, kind, id, index);
  const code = directory === undefined ? [] : [directory];
  for (const edge of attached) {
    impacts.push(
      removalImpact(
        index,
        subroutineId,
        'delete',
        'edges',
        String(edge.id),
        'attached',
      ),
    );
    if (edge.source !== id || edge.target === id) {
      continue;
    }
    const implementation = edgeImplementationPath(
      project,
      subroutineId,
      edge as Pick<
        SubroutineDefinition['edges'][number],
        'id' | 'source' | 'target'
      >,
      index,
    );
    if (implementation !== undefined) {
      code.push(implementation);
      withoutPath(project, implementation);
    }
  }
  graph.edges = entries(graph.edges).filter(
    edge => edge.source !== id && edge.target !== id,
  );
  graph.nodes = entries(graph.nodes).filter(node => node.id !== id);
  const layouts = object(object(project.editor).layouts);
  const subroutineLayout = object(layouts[subroutineId]);
  if (id in subroutineLayout) {
    delete subroutineLayout[id];
    layouts[subroutineId] = subroutineLayout;
  }
  if (directory !== undefined) {
    withoutDirectory(project, directory);
  }
  return removalPlan(project, code, impacts);
}

function removeFeature(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: 'features',
  id: string,
  reason: RemovalReason,
): RemovalPlan {
  const graph = subroutineGraph(project, subroutineId, index);
  const impacts = [
    removalImpact(index, subroutineId, 'delete', kind, String(id), reason),
  ];

  // Only a node can be a dependency's caller, so nothing below can orphan a pin.
  if (!entries(graph.features).some(feature => feature.id === id)) {
    throw new Error(`no feature ${id} in ${subroutineId}`);
  }
  graph.features = entries(graph.features).filter(feature => feature.id !== id);
  for (const edge of entries(graph.edges)) {
    for (const collection of ['conditions', 'effects'] as const) {
      const before = entries(edge[collection]);
      const after = before.filter(item => item.feature_id !== id);
      if (after.length !== before.length) {
        impacts.push(
          removalImpact(
            index,
            subroutineId,
            'update',
            'edges',
            String(edge.id),
            'reference_removed',
          ),
        );
      }
      edge[collection] = after;
    }
  }
  const directory = entityCode(project, subroutineId, kind, id, index);
  const code = directory === undefined ? [] : [directory];
  for (const item of code) {
    withoutDirectory(project, item);
  }
  return removalPlan(project, code, impacts);
}

function removeEdge(
  project: Project,
  index: DefinitionIndex,
  subroutineId: GraphId,
  kind: 'edges',
  id: string,
  reason: RemovalReason,
): RemovalPlan {
  const graph = subroutineGraph(project, subroutineId, index);
  const impacts = [
    removalImpact(index, subroutineId, 'delete', kind, String(id), reason),
  ];

  const edge = entries(graph.edges).find(candidate => candidate.id === id);
  if (edge === undefined) {
    throw new Error(`no edge ${id} in ${subroutineId}`);
  }
  const implementation = edgeImplementationPath(
    project,
    subroutineId,
    edge as Pick<
      SubroutineDefinition['edges'][number],
      'id' | 'source' | 'target'
    >,
    index,
  );
  if (implementation !== undefined) {
    withoutPath(project, implementation);
  }
  graph.edges = entries(graph.edges).filter(edge => edge.id !== id);
  return removalPlan(
    project,
    implementation === undefined ? [] : [implementation],
    impacts,
  );
}

/**
 * The directory containing an entity's authored files.
 *
 * `undefined` for an entity without authored files, and for a project with no package.
 */
function entityCode(
  project: Project,
  ownerId: GraphId,
  kind: Entity,
  id: string,
  index?: DefinitionIndex,
  ownerKind: DefinitionKind = 'subroutine',
): string | undefined {
  if (kind === 'edges' || kind === 'workflows' || kind === 'subroutines') {
    return undefined;
  }
  const packageName = String(project.package ?? '');
  const definition = definitionPath(project, ownerKind, ownerId, index);
  if (!packageName || definition === undefined) {
    return undefined;
  }
  const directory = kind.startsWith('profile_')
    ? 'profiles'
    : kind.startsWith('session_')
      ? 'sessions'
      : kind;
  return `src/${packageDirectory(packageName)}/${definition.join('/')}/${directory}/${id}`;
}

/** The target node's authored entry handler selected by a non-terminal edge. */
export function edgeImplementationPath(
  project: Project,
  subroutineId: GraphId,
  edge: Pick<SubroutineDefinition['edges'][number], 'id' | 'source' | 'target'>,
  index?: DefinitionIndex,
): string | undefined {
  const graph =
    index?.subroutines.get(subroutineId) ??
    subroutineInProject(project, subroutineId);
  const target = graph?.nodes.find(node => node.id === edge.target);
  if (
    target === undefined ||
    target.kind === 'enter' ||
    target.kind === 'exit' ||
    target.kind === 'failure'
  ) {
    return undefined;
  }
  const root = entityCode(project, subroutineId, 'nodes', target.id, index);
  return root === undefined
    ? undefined
    : visitDocumentPaths(root, edge).implementation;
}

function definitionCode(
  project: Project,
  kind: DefinitionKind,
  id: string,
  index?: DefinitionIndex,
): string | undefined {
  const packageName = String(project.package ?? '');
  const definition = definitionPath(project, kind, id, index);
  return !packageName || definition === undefined
    ? undefined
    : `src/${packageDirectory(packageName)}/${definition.join('/')}`;
}

/**
 * Drop every manifest entry under one directory.
 *
 * Generated entries too, not only the author's. They share the node directory the caller is
 * about to delete, so an entry the projection would have pruned on the *next* check is
 * fatal in the meantime. That is not hypothetical: it is what the two-dialog version shipped,
 * and `verdog check` died on a generated declaration with a message about UTF-8.
 *
 * The trailing slash is load-bearing. Without it, removing `profile` takes `profile_2` with it.
 */
function withoutDirectory(project: Project, code: string): void {
  const sources = project.sources;
  if (!Array.isArray(sources)) {
    return;
  }
  project.sources = (sources as Array<Record<string, unknown>>).filter(
    source => !String(source.path ?? '').startsWith(`${code}/`),
  );
}

function withoutPath(project: Project, path: string): void {
  if (!Array.isArray(project.sources)) {
    return;
  }
  project.sources = (project.sources as Array<Record<string, unknown>>).filter(
    source => source.path !== path,
  );
}

function moveSource(project: Project, from: string, to: string): void {
  if (!Array.isArray(project.sources)) {
    return;
  }
  const source = (project.sources as Array<Record<string, unknown>>).find(
    candidate => candidate.path === from,
  );
  if (source !== undefined) {
    source.path = to;
  }
}

/**
 * Pinned dependencies this graph no longer calls.
 *
 * Reported rather than silently dropped, because undoing an import means deleting the pin,
 * checkout and `.gitmodules` entry. The compiler permits unused pins; the editor offers this
 * explicit cleanup when an edit removes the last use.
 */
export function orphanedPins(
  project: Project,
  index = definitionIndex(project),
): string[] {
  const called = new Set<string>();
  for (const definition of index.definitions.values()) {
    const alias = definition.external?.alias;
    if (alias !== undefined) {
      called.add(alias);
    }
  }
  for (const body of subroutinesIn(project, index)) {
    for (const node of body.nodes) {
      if (node.kind !== 'subroutine_call') {
        continue;
      }
      const target = node.operation?.target;
      if (typeof target !== 'string') {
        continue;
      }
      const external = parseQualifiedSubroutineTarget(target);
      if (external !== undefined) {
        called.add(external.alias);
      }
    }
  }
  return entries(project.externals)
    .map(pin => String(object(pin).alias))
    .filter(alias => alias && !called.has(alias));
}

/**
 * Constrain an edge: one observation of one feature, as a condition or an effect.
 *
 * Replaces any existing entry for that feature, because the compiler allows one per feature
 * per collection -- a second would be refused, and "you already constrained this" is not a
 * conversation worth having when the author's intent is obvious.
 */
export function constrain(
  project: Project,
  subroutineId: GraphId,
  edgeId: EdgeId,
  collection: 'conditions' | 'effects',
  featureId: FeatureId,
  observation: string,
  value?: string,
): Project {
  const next = structuredClone(project);
  const graph = subroutineGraph(next, subroutineId);
  const edge = entries(graph.edges).find(item => item.id === edgeId);
  if (edge === undefined) {
    throw new Error(`no edge ${edgeId} in ${subroutineId}`);
  }
  const feature = entries(graph.features).find(item => item.id === featureId);
  if (feature === undefined || !isFeatureKind(feature.kind)) {
    throw new Error(`no feature ${featureId} in ${subroutineId}`);
  }
  if (collection === 'effects') {
    const source = entries(graph.nodes).find(item => item.id === edge.source);
    if (source?.kind !== 'feature') {
      throw new Error('only an edge from a feature node can declare effects');
    }
  }
  if (
    !observationsFor(collection, feature.kind).some(
      allowed => allowed === observation,
    )
  ) {
    throw new Error(
      `${observation} is not a ${collection} observation for ${feature.kind}`,
    );
  }
  if (observation === 'equal') {
    const values = feature?.kind === 'enum' ? array(feature.values) : [];
    if (value === undefined || !values.includes(value)) {
      throw new Error(
        `${String(value)} is not a value of enum feature ${featureId}`,
      );
    }
  } else if (value !== undefined) {
    throw new Error(`observation ${observation} does not accept a value`);
  }
  edge[collection] = [
    ...entries(edge[collection]).filter(item => item.feature_id !== featureId),
    {
      feature_id: featureId,
      observation,
      ...(value === undefined ? {} : {value}),
    },
  ];
  return next;
}

/** Drop one feature observation from an edge. */
export function unconstrain(
  project: Project,
  subroutineId: GraphId,
  edgeId: EdgeId,
  collection: 'conditions' | 'effects',
  featureId: FeatureId,
): Project {
  if (collection !== 'conditions' && collection !== 'effects') {
    throw new Error(`${String(collection)} is not a constraint collection`);
  }
  const next = structuredClone(project);
  const edge = entries(subroutineGraph(next, subroutineId).edges).find(
    item => item.id === edgeId,
  );
  if (edge === undefined) {
    throw new Error(`no edge ${edgeId} in ${subroutineId}`);
  }
  edge[collection] = entries(edge[collection]).filter(
    item => item.feature_id !== featureId,
  );
  return next;
}

/** Apply one complete set of agent resources or subroutine-call bindings. */
export function setNodeResources(
  snapshot: ProjectGraphs,
  subroutineId: string,
  nodeId: NodeId,
  submitted: readonly ResourceSelection[],
): Project {
  const update = normalizeNodeResources(
    snapshot,
    subroutineId,
    nodeId,
    submitted,
  );
  const at = projectIn(snapshot, subroutineId);
  const next = structuredClone(at.project);
  const node = entries(subroutineGraph(next, at.id).nodes).find(
    item => item.id === nodeId,
  )!;
  node.operation =
    update.kind === 'agent'
      ? {profile: update.profile, session: update.session}
      : {...object(node.operation), ...update.arguments};
  return next;
}

/** Replace one concrete profile's provider configuration. */
export function setProfileConfiguration(
  project: Project,
  subroutineId: GraphId,
  profileId: AgentProfileId,
  provider: AgentProvider,
  options: AgentInvokerOptions,
  workflowId?: GraphId,
): Project {
  const next = structuredClone(project);
  const workflow =
    workflowId === undefined ? undefined : localWorkflow(next, workflowId);
  const profiles =
    workflow?.profiles ?? entries(subroutineGraph(next, subroutineId).profiles);
  const profile = profiles.find(candidate => candidate.id === profileId);
  if (profile === undefined) {
    throw new Error(`no profile ${profileId}`);
  }
  profile.provider = provider;
  profile.options = {
    model: options.model?.trim() || null,
    reasoning_effort: options.reasoning_effort?.trim() || null,
    extra_args: [...options.extra_args],
  };
  return next;
}

/** Change a session's persistence without conflating it with its profile. */
export function setSessionPersistence(
  project: Project,
  subroutineId: GraphId,
  sessionId: AgentSessionId,
  persistent: boolean,
  workflowId?: GraphId,
): Project {
  const next = structuredClone(project);
  const workflow =
    workflowId === undefined ? undefined : localWorkflow(next, workflowId);
  const sessions =
    workflow?.sessions ?? entries(subroutineGraph(next, subroutineId).sessions);
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (session === undefined) {
    throw new Error(`no session ${sessionId}`);
  }
  session.persistent = persistent;
  return next;
}

/** Replace the resource bindings on a local workflow's sole subroutine call. */
export function setWorkflowResources(
  project: Project,
  workflowId: GraphId,
  submitted: readonly ResourceSelection[],
): Project {
  const next = structuredClone(project);
  const definition = definitionIn(next, 'workflow', workflowId);
  const workflow = definition?.workflow;
  const target =
    definition?.target === undefined
      ? undefined
      : subroutineInProject(next, definition.target);
  if (workflow === undefined || target === undefined) {
    throw new Error(`no local workflow ${workflowId}`);
  }
  const args = normalizeWorkflowResources(target, workflow, submitted);
  workflow.profile_arguments = args.profile_arguments;
  workflow.session_arguments = args.session_arguments;
  return next;
}

/**
 * Change what an entity is *called*, which is not the same as renaming it.
 *
 * `name` is prose for a reader -- "Profile compile time" -- and nothing refers to it, so this
 * is a plain edit. `id` is the identifier every generated module path and every edge endpoint
 * is built from, and changing that is `verdog rename`: it moves a directory and rewrites the
 * references. A display-label edit needs generation but not this source-reference rewrite.
 *
 * A feature's prose lives in `label`, not `name`, which is why the field is chosen by kind.
 */
export function setName(
  project: Project,
  subroutineId: GraphId,
  kind: Entity,
  id: string,
  name: string,
  workflow?: GraphId,
): Project {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('a name must not be empty');
  }
  const next = structuredClone(project);
  if (workflow !== undefined) {
    if (kind !== 'profiles' && kind !== 'sessions') {
      throw new Error(`a workflow does not own ${kind}`);
    }
    const resources = localWorkflow(next, workflow)[kind];
    const resource = resources.find(candidate => candidate.id === id);
    if (resource === undefined) {
      throw new Error(`no workflow ${kind.slice(0, -1)} ${id}`);
    }
    resource.name = trimmed;
    return next;
  }
  const definition =
    kind === 'workflows' || kind === 'subroutines'
      ? definitionIn(next, DEFINITION_KIND[kind], graphId(id))
      : undefined;
  if (kind === 'workflows' && definition?.workflow !== undefined) {
    throw new Error(
      'a local workflow derives its id and name from its subroutine',
    );
  }
  const rootSubroutine =
    kind === 'subroutines' &&
    definition?.declaredIn === undefined &&
    definition?.id === subroutineId
      ? definition.subroutine
      : undefined;
  const found =
    rootSubroutine ??
    entries(subroutineGraph(next, subroutineId)[kind]).find(item =>
      kind === 'workflows'
        ? definition !== undefined && workflowId(item) === definition.localId
        : kind === 'subroutines'
          ? item.id === definition?.localId
          : item.id === id,
    );
  if (found === undefined) {
    throw new Error(`no ${kind.slice(0, -1)} ${id} in ${subroutineId}`);
  }
  found[kind === 'features' ? 'label' : 'name'] = trimmed;
  return next;
}

/** Record where nodes sit, in `editor.layouts`. Rounded, as the generator writes integers. */
export function place(
  project: Project,
  subroutineId: GraphId,
  positions: Partial<Record<NodeId, Position>>,
): Project {
  const editor = object(project.editor);
  const layouts = object(editor.layouts);
  const subroutineLayout = object(layouts[subroutineId]);
  for (const [id, position] of Object.entries(positions)) {
    if (position === undefined) {
      continue;
    }
    subroutineLayout[id] = {
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
  }
  layouts[subroutineId] = subroutineLayout;
  editor.layouts = layouts;
  project.editor = editor;
  return project;
}

/** Positions written into a copy, for the callers that must not mutate their input. */
export function moved(
  project: Project,
  subroutineId: GraphId,
  positions: Partial<Record<NodeId, Position>>,
): Project {
  return place(structuredClone(project), subroutineId, positions);
}

/** The document, formatted as the service writes it, so a save is not a whitespace diff. */
export function serialize(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}
