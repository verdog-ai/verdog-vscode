/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {FeatureDefinition} from './features';
import {
  graphId,
  type AgentProfileId,
  type AgentSessionId,
  type EdgeId,
  type FeatureId,
  type GraphId,
  type NodeId,
  type QualifiedSubroutineTarget,
} from './identifiers';

import {entries, object} from './reading';

export const SCHEMA_VERSION = 33 as const;

export type CanonicalObject = Record<string, unknown>;

export const EXECUTABLE_NODE_KINDS = ['python', 'feature', 'agent'] as const;
export type ExecutableNodeKind = (typeof EXECUTABLE_NODE_KINDS)[number];

export const CALL_NODE_KINDS = ['subroutine_call', 'workflow_call'] as const;
export type CallNodeKind = (typeof CALL_NODE_KINDS)[number];
export type AddableNodeKind = ExecutableNodeKind | CallNodeKind;
export type NodeKind = AddableNodeKind | 'enter' | 'exit' | 'failure';

export const DEFINITION_KINDS = ['subroutine', 'workflow'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export const DEFINITION_COLLECTION = {
  subroutine: 'subroutines',
  workflow: 'workflows',
} as const satisfies Record<DefinitionKind, 'subroutines' | 'workflows'>;

export const DEFINITION_KIND = {
  subroutines: 'subroutine',
  workflows: 'workflow',
} as const satisfies Record<
  (typeof DEFINITION_COLLECTION)[DefinitionKind],
  DefinitionKind
>;

export const CALL_DEFINITION_KIND = {
  subroutine_call: 'subroutine',
  workflow_call: 'workflow',
} as const satisfies Record<CallNodeKind, DefinitionKind>;

export const NODE_KIND_DESCRIPTIONS = {
  agent: 'runs an agent',
  feature: 'proposes workflow feature values with Python you write',
  python: 'runs Python you write',
  subroutine_call: 'calls a visible or external subroutine in this process',
  workflow_call: 'calls a visible workflow in its own process',
} as const satisfies Record<AddableNodeKind, string>;

export function isExecutableNodeKind(
  value: unknown,
): value is ExecutableNodeKind {
  return EXECUTABLE_NODE_KINDS.some(kind => kind === value);
}

export function isCallNodeKind(value: unknown): value is CallNodeKind {
  return CALL_NODE_KINDS.some(kind => kind === value);
}

export function isAddableNodeKind(value: unknown): value is AddableNodeKind {
  return isExecutableNodeKind(value) || isCallNodeKind(value);
}

/** Why an edge cannot use these endpoint kinds, or nothing when it can. */
export function edgeDirectionProblem(
  source: NodeKind,
  target: NodeKind,
): string | undefined {
  if (target === 'enter') {
    return 'the enter port cannot have incoming edges';
  }
  if (source === 'exit') {
    return 'the exit port cannot have outgoing edges';
  }
  if (source === 'failure') {
    return 'the failure port cannot have outgoing edges';
  }
  return undefined;
}

export interface FeatureObservation {
  feature_id: FeatureId;
  observation: string;
  value?: string;
}

export const AGENT_PROVIDERS = ['codex', 'claude'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface AgentInvokerOptions {
  model: string | null;
  reasoning_effort: string | null;
  extra_args: string[];
}

export type AgentProfileParameter = CanonicalObject & {
  id: AgentProfileId;
  name: string;
};

export type AgentProfile = AgentProfileParameter & {
  provider: AgentProvider;
  options: AgentInvokerOptions;
};

export type AgentSessionParameter = CanonicalObject & {
  id: AgentSessionId;
  name: string;
};

export type AgentSession = AgentSessionParameter & {
  persistent: boolean;
};

type NodeOperation = CanonicalObject & {
  profile?: AgentProfileId;
  session?: AgentSessionId;
  target?: GraphId | QualifiedSubroutineTarget;
};

export interface SubroutineCallArguments {
  /** Child profile parameter to a profile owned or received by the caller. */
  profile_arguments: Record<AgentProfileId, AgentProfileId>;
  /** Child session parameter to a session owned or received by the caller. */
  session_arguments: Record<AgentSessionId, AgentSessionId>;
}

type ProjectNodeBase = CanonicalObject & {
  id: NodeId;
  name: string;
};

/** A schema-valid agent always selects both explicit resources. */
export type ProjectNode = ProjectNodeBase &
  (
    | {
        kind: 'agent';
        operation: NodeOperation & {
          profile: AgentProfileId;
          session: AgentSessionId;
        };
      }
    | {
        kind: 'subroutine_call';
        operation: NodeOperation &
          SubroutineCallArguments & {
            target: GraphId | QualifiedSubroutineTarget;
          };
      }
    | {
        kind: Exclude<NodeKind, 'agent' | 'subroutine_call'>;
        operation?: NodeOperation;
      }
  );

export type ProjectEdge = CanonicalObject & {
  conditions: FeatureObservation[];
  effects: FeatureObservation[];
  id: EdgeId;
  name: string;
  source: NodeId;
  target: NodeId;
};

/** The sole graph and contract owner. */
export type SubroutineDefinition = CanonicalObject & {
  edges: ProjectEdge[];
  features: FeatureDefinition[];
  /** Identifier local to the declaration's lexical scope. */
  id: GraphId;
  name: string;
  nodes: ProjectNode[];
  ports: {enter: NodeId; exit: NodeId; failure: NodeId};
  profile_parameters: AgentProfileParameter[];
  profiles: AgentProfile[];
  session_parameters: AgentSessionParameter[];
  sessions: AgentSession[];
  subroutines: SubroutineDefinition[];
  workflows: WorkflowDefinition[];
};

/** A process boundary points at a separately declared subroutine graph. */
export type LocalWorkflowDefinition = CanonicalObject &
  SubroutineCallArguments & {
    profiles: AgentProfile[];
    sessions: AgentSession[];
    subroutine: GraphId;
  };

export type ExternalWorkflowDefinition = CanonicalObject & {
  external: {alias: string; workflow: GraphId};
  id: GraphId;
  name: string;
};

export type WorkflowDefinition =
  LocalWorkflowDefinition | ExternalWorkflowDefinition;

export type CanonicalProject = CanonicalObject & {
  generated_from: string;
  package: string;
  schema_version: typeof SCHEMA_VERSION;
  /** Root subroutines, visible from every scope. */
  subroutines: SubroutineDefinition[];
  /** Root workflows, each wrapping a root subroutine. */
  workflows: LocalWorkflowDefinition[];
};

export interface Definition {
  declaredIn?: GraphId;
  external?: ExternalWorkflowDefinition['external'];
  /** Identifier written on the declaration itself. */
  localId: GraphId;
  id: GraphId;
  kind: DefinitionKind;
  name: string;
  /** Generated source directory below `src/<package>/`. */
  path?: string[];
  /** The local graph this workflow invokes, or this subroutine definition itself. */
  subroutine?: SubroutineDefinition;
  /** Canonical id of that graph. */
  target?: GraphId;
  /** The local workflow envelope, when this is not an external binding. */
  workflow?: LocalWorkflowDefinition;
}

export type CallTarget = Pick<Definition, 'kind' | 'name' | 'external'> & {
  externalAlias?: string;
  id: GraphId | QualifiedSubroutineTarget;
};

export interface DefinitionIndex {
  /** All definitions, keyed by `definitionKey(kind, id)`. */
  definitions: ReadonlyMap<string, Definition>;
  /** Keys with more than one declaration. The maps deliberately retain the first. */
  duplicates: ReadonlySet<string>;
  subroutines: ReadonlyMap<GraphId, SubroutineDefinition>;
  /** Enclosing graph, keyed by a declaration or graph id. */
  parents: ReadonlyMap<GraphId, GraphId | undefined>;
}

function graph(value: unknown): SubroutineDefinition | undefined {
  const candidate = object(value);
  return typeof candidate.id === 'string'
    ? (candidate as SubroutineDefinition)
    : undefined;
}

function localWorkflow(value: unknown): LocalWorkflowDefinition | undefined {
  const candidate = object(value);
  return typeof candidate.subroutine === 'string' &&
    Array.isArray(candidate.profiles) &&
    Array.isArray(candidate.sessions) &&
    typeof candidate.profile_arguments === 'object' &&
    candidate.profile_arguments !== null &&
    typeof candidate.session_arguments === 'object' &&
    candidate.session_arguments !== null &&
    !('external' in candidate)
    ? (candidate as LocalWorkflowDefinition)
    : undefined;
}

/** Internal key for definitions whose authored identifiers may coincide across kinds. */
export function definitionKey(kind: DefinitionKind, id: GraphId): string {
  return `${kind}:${id}`;
}

const GRAPH_SEPARATOR = '__';

/** The declaration-local leaf of a canonical graph id. */
export function graphLeaf(id: GraphId): GraphId {
  const separator = id.lastIndexOf(GRAPH_SEPARATOR);
  return separator < 0
    ? id
    : graphId(id.slice(separator + GRAPH_SEPARATOR.length));
}

/** A declaration's canonical identity within its lexical owner; `''` is the project. */
export function qualifyGraph(
  owner: GraphId | undefined,
  localId: GraphId,
): GraphId {
  return owner === undefined || owner === ''
    ? localId
    : graphId(`${owner}${GRAPH_SEPARATOR}${localId}`);
}

/** A workflow's declaration-local identifier: explicit or derived from its wrapped graph. */
export function workflowId(value: unknown): GraphId | undefined {
  const candidate = object(value);
  const local = localWorkflow(candidate);
  return local === undefined
    ? typeof candidate.id === 'string'
      ? candidate.id
      : undefined
    : graphLeaf(local.subroutine);
}

/** Every declaration in the recursive lexical tree, indexed once for all consumers. */
export function definitionIndex(project: unknown): DefinitionIndex {
  const definitions = new Map<string, Definition>();
  const duplicates = new Set<string>();
  const subroutines = new Map<GraphId, SubroutineDefinition>();
  const parents = new Map<GraphId, GraphId | undefined>();

  const localDefinitions: Array<{
    definition: Definition;
    workflow: LocalWorkflowDefinition;
  }> = [];
  const add = (definition: Definition): boolean => {
    const key = definitionKey(definition.kind, definition.id);
    if (definitions.has(key)) {
      duplicates.add(key);
      return false;
    }
    definitions.set(key, definition);
    return true;
  };
  const visitWorkflow = (
    raw: CanonicalObject,
    declaredIn: GraphId | undefined,
    path: string[],
  ): void => {
    const workflow = localWorkflow(raw);
    if (workflow !== undefined) {
      const localId = graphLeaf(workflow.subroutine);
      const definition: Definition = {
        ...(declaredIn === undefined ? {} : {declaredIn}),
        id: qualifyGraph(declaredIn, localId),
        kind: 'workflow',
        localId,
        name: localId,
        path,
        target: workflow.subroutine,
        workflow,
      };
      if (add(definition)) {
        localDefinitions.push({definition, workflow});
      }
      return;
    }
    const external = object(raw.external);
    if (
      typeof raw.id === 'string' &&
      typeof external.alias === 'string' &&
      typeof external.workflow === 'string'
    ) {
      const localId = raw.id as GraphId;
      add({
        ...(declaredIn === undefined ? {} : {declaredIn}),
        external: {alias: external.alias, workflow: external.workflow},
        id: qualifyGraph(declaredIn, localId),
        kind: 'workflow',
        localId,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
      });
    }
  };
  const visitGraph = (
    body: SubroutineDefinition,
    parent: GraphId | undefined,
    path: string[],
  ) => {
    const id = qualifyGraph(parent, body.id);
    add({
      ...(parent === undefined ? {} : {declaredIn: parent}),
      id,
      kind: 'subroutine',
      localId: body.id,
      name: typeof body.name === 'string' ? body.name : body.id,
      path,
      subroutine: body,
      target: id,
    });
    if (!subroutines.has(id)) {
      subroutines.set(id, body);
      parents.set(id, parent);
    }

    for (const raw of entries(body.workflows)) {
      const localId = workflowId(raw);
      if (localId !== undefined) {
        visitWorkflow(raw, id, [...path, 'workflows', localId]);
      }
    }
    for (const raw of entries(body.subroutines)) {
      const nested = graph(raw);
      if (nested !== undefined) {
        visitGraph(nested, id, [...path, 'subroutines', nested.id]);
      }
    }
  };

  // The project is the owner of its root declarations, exactly as a subroutine owns nested ones.
  const root = object(project);
  for (const raw of entries(root.workflows)) {
    const localId = workflowId(raw);
    if (localId !== undefined) {
      visitWorkflow(raw, undefined, ['workflows', localId]);
    }
  }
  for (const raw of entries(root.subroutines)) {
    const body = graph(raw);
    if (body !== undefined) {
      visitGraph(body, undefined, ['subroutines', body.id]);
    }
  }

  for (const {definition, workflow} of localDefinitions) {
    const subroutine = subroutines.get(workflow.subroutine);
    if (subroutine !== undefined) {
      definition.name =
        typeof subroutine.name === 'string'
          ? subroutine.name
          : definition.localId;
      definition.subroutine = subroutine;
    }
  }

  return {definitions, duplicates, parents, subroutines};
}

/** The workflows the project itself declares. */
export function rootWorkflows(index: DefinitionIndex): GraphId[] {
  return [...index.definitions.values()]
    .filter(
      definition =>
        definition.kind === 'workflow' && definition.declaredIn === undefined,
    )
    .map(definition => definition.id);
}

/**
 * The workflow run when none is named, as the CLI chooses it: the only root workflow, else
 * `main` when declared, else none.
 */
export function defaultWorkflow(index: DefinitionIndex): GraphId | undefined {
  const roots = rootWorkflows(index);
  return roots.length === 1 ? roots[0] : roots.find(id => id === 'main');
}

/** One definition from its kind-specific namespace. */
export function definitionIn(
  project: unknown,
  kind: DefinitionKind,
  id: GraphId,
  index = definitionIndex(project),
): Definition | undefined {
  return index.definitions.get(definitionKey(kind, id));
}

export function subroutinesIn(
  project: unknown,
  index = definitionIndex(project),
): SubroutineDefinition[] {
  return [...index.subroutines].map(([id, body]) =>
    id === body.id ? body : {...body, id},
  );
}

export function subroutineInProject(
  project: unknown,
  id: GraphId,
): SubroutineDefinition | undefined {
  return definitionIndex(project).subroutines.get(id);
}

/** Definitions visible from a graph, nearest lexical scope first. */
export function visibleDefinitions(
  project: unknown,
  graphId: GraphId,
  kind?: DefinitionKind,
  index = definitionIndex(project),
): Definition[] {
  const scopes: GraphId[] = [];
  for (
    let scope: GraphId | undefined = graphId;
    scope !== undefined;
    scope = index.parents.get(scope)
  ) {
    scopes.push(scope);
  }
  const visible = scopes.flatMap(scope =>
    [...index.definitions.values()].filter(
      definition =>
        definition.declaredIn === scope &&
        (kind === undefined || definition.kind === kind),
    ),
  );
  // Root declarations belong to the project, which encloses every scope.
  const roots = [...index.definitions.values()].filter(
    definition =>
      definition.declaredIn === undefined &&
      (kind === undefined || definition.kind === kind),
  );
  return [...visible, ...roots];
}

/** Local definitions plus qualified external subroutines offered at one call site. */
export function callTargets(
  project: unknown,
  graphId: GraphId,
  kind: DefinitionKind,
  external: readonly CallTarget[] = [],
): CallTarget[] {
  const local = visibleDefinitions(project, graphId, kind);
  return kind === 'subroutine' ? [...local, ...external] : local;
}

/** Generated source directory below `src/<package>/` for one local definition. */
export function definitionPath(
  project: unknown,
  kind: DefinitionKind,
  id: GraphId,
  index = definitionIndex(project),
): string[] | undefined {
  return definitionIn(project, kind, id, index)?.path;
}

/** Resolve a local call target in lexical scope. Qualified subroutines resolve via a pin. */
export function resolveCall(
  project: unknown,
  graphId: GraphId,
  node: Pick<ProjectNode, 'kind' | 'operation'>,
  index = definitionIndex(project),
): Definition | undefined {
  if (
    !isCallNodeKind(node.kind) ||
    typeof node.operation?.target !== 'string'
  ) {
    return undefined;
  }
  const expected = CALL_DEFINITION_KIND[node.kind];
  return visibleDefinitions(project, graphId, expected, index).find(
    definition =>
      definition.id === node.operation?.target &&
      !index.duplicates.has(definitionKey(expected, definition.id)),
  );
}
