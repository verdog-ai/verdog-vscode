import { agentProfiles, agentSessions } from "../model/agents";
import { bindingSummary, resolveParameter } from "../model/bindings";
import type { DocumentLink, DocumentedEntity, EntityDocumentRefs } from "../model/documents";
import type { Entity, RemovalImpact } from "../model/editing";
import {
  edgeId,
  featureId,
  graphId,
  nodeId,
  parseQualifiedSubroutineTarget,
  type GraphId,
} from "../model/identifiers";
import { packageDirectory } from "../model/names";
import {
  CALL_DEFINITION_KIND,
  DEFINITION_COLLECTION,
  DEFINITION_KIND,
  definitionIndex,
  definitionKey,
  graphLeaf,
  isCallNodeKind,
  resolveCall,
  subroutinesIn,
  type DefinitionIndex,
  type ProjectNode,
} from "../model/project";
import { entries, object } from "../model/reading";
import type {
  CanvasSelection,
  EntityNavigationCategory,
  EntityNavigationPage,
  NavigationCategory,
  NavigationEntry,
  NavigationInspection,
  NavigationPage,
  NavigationTarget,
  StatusNavigationPage,
  TerminationNavigation,
} from "../model/protocol";
import { TERMINATION_LABEL, terminationFor } from "../model/termination";
import {
  isStale,
  projectIn,
  ownerRoot,
  qualifiedKey,
  subroutineAddress,
  subroutineIn,
  type ProjectSnapshot,
} from "../model/snapshot";
import {
  snapshotDefinitionIndexes,
  snapshotDefinitions,
  visibleDefinitionKeys,
} from "./subroutineGraphs";
import type { DefinitionItem, SubroutineGraph, SubroutineNode } from "./subroutines";

const TITLES: Record<NavigationCategory, string> = {
  features: "Features",
  profiles: "Profiles",
  sessions: "Sessions",
  status: "Status",
  subroutines: "Subroutines",
  workflows: "Workflows",
};

const initPath = (path: string | undefined): string | undefined =>
  path?.endsWith("/__init__.py") ? path : undefined;

const inspection = (
  entity: Entity,
  id: string,
  subroutine: string,
  workflow?: GraphId,
): NavigationInspection => ({
  entity,
  id,
  subroutine,
  ...(workflow === undefined ? {} : { workflow }),
} as NavigationInspection);

const declarationOf = (documents: readonly DocumentLink[]): string | undefined =>
  documents
    .filter(({ label }) => label.endsWith("declaration"))
    .map(({ path }) => initPath(path))
    .find((path) => path !== undefined);

const ownerFolder = (ownerPath: string | undefined, packageName: string): string =>
  ownerPath === undefined ? packageDirectory(packageName) : ownerRoot(ownerPath);

function graphScope(snapshot: ProjectSnapshot, key: string): string[] {
  const { ownerPath, subroutine } = subroutineAddress(snapshot.pinned, key);
  const project = projectIn(snapshot, key).project;
  const owner = ownerFolder(ownerPath, project.package);
  const ancestry = String(subroutine).split("__");
  return [owner, ...ancestry];
}

function definitionRootScope(snapshot: ProjectSnapshot, item: DefinitionItem): string[] {
  const localKey = definitionKey(item.kind, item.id);
  const suffix = `/${localKey}`;
  const ownerPath = item.key.endsWith(suffix)
    ? item.key.slice(0, -suffix.length)
    : undefined;
  return [ownerFolder(ownerPath, snapshot.project.package)];
}

function callDefinitionKey(
  snapshot: ProjectSnapshot,
  caller: string,
  node: Pick<ProjectNode, "kind" | "operation">,
  available: ReadonlySet<string>,
  index?: DefinitionIndex,
): string | undefined {
  if (!isCallNodeKind(node.kind) || typeof node.operation?.target !== "string") return undefined;
  const kind = CALL_DEFINITION_KIND[node.kind];
  const target = node.operation.target;
  const { ownerPath } = subroutineAddress(snapshot.pinned, caller);
  const at = projectIn(snapshot, caller);
  const local = resolveCall(at.project, at.id, node, index);
  if (local !== undefined) {
    const key = qualifiedKey(ownerPath, definitionKey(local.kind, local.id));
    return available.has(key) ? key : undefined;
  }
  const external = kind === "subroutine" ? parseQualifiedSubroutineTarget(target) : undefined;
  if (external === undefined) return undefined;
  const key = qualifiedKey(qualifiedKey(ownerPath, external.alias), definitionKey(kind, external.subroutine));
  return available.has(key) ? key : undefined;
}

function definitionCallReferences(
  snapshot: ProjectSnapshot,
  indexes: ReadonlyMap<string, DefinitionIndex>,
  definitions: readonly DefinitionItem[],
): Map<string, NavigationEntry[]> {
  const references = new Map<string, NavigationEntry[]>();
  const owners: [string | undefined, ProjectSnapshot["project"]][] = [
    [undefined, snapshot.project],
    ...Object.entries(snapshot.pinned),
  ];
  for (const [ownerPath, project] of owners) {
    const index = indexes.get(ownerPath ?? "") ?? definitionIndex(project);
    for (const graph of subroutinesIn(project, index)) {
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const caller = qualifiedKey(ownerPath, graph.id);
      const visible = visibleDefinitionKeys(snapshot, caller, indexes);
      for (const node of nodes) {
        if (!isCallNodeKind(node?.kind)) continue;
        const parentKey = callDefinitionKey(snapshot, caller, node, visible, index);
        if (parentKey === undefined) continue;
        const declaration = initPath(
          snapshot.entity_documents.nodes[caller]?.[node.id]?.declaration,
        );
        const entry: NavigationEntry = {
          children: [],
          ...(declaration === undefined ? {} : { declaration }),
          entity: "nodes",
          id: node.id,
          key: `${parentKey}/caller:${caller}:${node.id}`,
          meta: [`in ${caller}`],
          ...(snapshot.editable
            ? { removal: inspection("nodes", node.id, caller) }
            : {}),
          scope: graphScope(snapshot, caller),
          target: {
            selection: { entity: "nodes", id: node.id },
            scope: caller,
          },
        };
        const siblings = references.get(parentKey);
        if (siblings === undefined) references.set(parentKey, [entry]);
        else siblings.push(entry);
      }
    }
  }
  for (const definition of definitions) {
    if (
      definition.kind !== "workflow" ||
      definition.workflow === undefined ||
      definition.target === undefined ||
      definition.scope === undefined ||
      definition.ambiguous === true
    ) continue;
    const { ownerPath, subroutine } = subroutineAddress(snapshot.pinned, definition.target);
    const parentKey = qualifiedKey(
      ownerPath,
      definitionKey("subroutine", graphId(subroutine)),
    );
    const declaration = declarationOf(definition.documents);
    const baseScope = definition.declaredIn === undefined
      ? definitionRootScope(snapshot, definition)
      : graphScope(snapshot, definition.declaredIn);
    const entry: NavigationEntry = {
      children: [],
      ...(declaration === undefined ? {} : { declaration }),
      entity: "workflows",
      id: definition.id,
      key: `${parentKey}/caller:${definition.key}:subroutine`,
      meta: [`in ${definition.key}`],
      scope: [...baseScope, "Workflows", definition.id],
      target: {
        inspection: inspection(
          "workflows",
          definition.id,
          definition.ownerGraph,
          definition.id,
        ),
        scope: definition.scope,
        selection: { entity: "nodes", id: nodeId("subroutine") },
      },
    };
    const siblings = references.get(parentKey);
    if (siblings === undefined) references.set(parentKey, [entry]);
    else siblings.push(entry);
  }
  return references;
}

function definitionNavigationTarget(item: DefinitionItem): NavigationTarget | undefined {
  const targetScope = item.ambiguous === true ? undefined : item.scope ?? item.target ?? item.declaredIn;
  return targetScope === undefined ? undefined : {
    inspection: inspection(
      DEFINITION_COLLECTION[item.kind],
      item.id,
      item.ownerGraph,
      item.kind === "workflow" && item.workflow !== undefined ? item.id : undefined,
    ),
    scope: targetScope,
  };
}

function definitionEntry(
  snapshot: ProjectSnapshot,
  visible: ReadonlySet<string>,
  definitions: readonly DefinitionItem[],
  callers: ReadonlyMap<string, NavigationEntry[]>,
  item: DefinitionItem,
): NavigationEntry {
  const ambiguous = item.ambiguous === true;
  const unavailable = item.target === undefined || ambiguous;
  const declaring = unavailable && item.declaredIn !== undefined
    ? definitions.find(({ kind, target }) => kind === "subroutine" && target === item.declaredIn)
    : undefined;
  const declaration = declarationOf(item.documents) ?? declarationOf(declaring?.documents ?? []);
  const removalSubroutine = item.declaredIn ?? item.target;
  const rootReset = item.declaredIn === undefined;
  const target = definitionNavigationTarget(item);
  return {
    children: callers.get(item.key) ?? [],
    ...(declaration === undefined ? {} : { declaration }),
    entity: DEFINITION_COLLECTION[item.kind],
    id: item.id,
    key: item.key,
    meta: [
      visible.has(item.key) ? "visible here" : "not visible here",
      ...(ambiguous ? ["duplicate identity"] : unavailable ? ["target unavailable"] : []),
    ],
    ...(!ambiguous && removalSubroutine !== undefined && snapshot.editable
      ? {
          removal: rootReset
            ? inspection("subroutines", item.id, removalSubroutine)
            : inspection(
                DEFINITION_COLLECTION[item.kind],
                item.id,
                removalSubroutine,
              ),
        }
      : {}),
    scope:
      item.declaredIn === undefined
        ? definitionRootScope(snapshot, item)
        : graphScope(snapshot, item.declaredIn),
    ...(target === undefined ? {} : { target }),
  };
}

function entityDeclaration(
  snapshot: ProjectSnapshot,
  subroutine: string,
  entity: DocumentedEntity,
  id: string,
): string | undefined {
  const refs = snapshot.entity_documents[entity][subroutine]?.[id] as
    | EntityDocumentRefs
    | undefined;
  return initPath(refs?.declaration);
}

function referenceEntry(
  snapshot: ProjectSnapshot,
  current: string,
  parentKey: string,
  scope: string[],
  selection: CanvasSelection,
  index: number,
): NavigationEntry {
  const declaration = entityDeclaration(snapshot, current, selection.entity, selection.id);
  return {
    children: [],
    ...(declaration === undefined ? {} : { declaration }),
    entity: selection.entity,
    id: selection.id,
    key: `${parentKey}/referrer:${selection.entity}:${selection.id}:${index}`,
    meta: [],
    ...(snapshot.editable
      ? { removal: inspection(selection.entity, selection.id, current) }
      : {}),
    scope,
    target: { selection, scope: current },
  };
}

function parameterBindingReferences(
  snapshot: ProjectSnapshot,
  current: string,
): NavigationEntry[] {
  const indexes = snapshotDefinitionIndexes(snapshot);
  const definitions = snapshotDefinitions(snapshot, indexes);
  const { ownerPath, subroutine } = subroutineAddress(snapshot.pinned, current);
  const key = qualifiedKey(ownerPath, definitionKey("subroutine", subroutine));
  return definitionCallReferences(snapshot, indexes, definitions).get(key) ?? [];
}

type LocalIdentity = Exclude<DocumentedEntity, "edges" | "nodes">;

function workflowCanvas(
  snapshot: ProjectSnapshot,
  current: string,
) {
  const definition = snapshotDefinitions(snapshot).find(({ key }) => key === current);
  if (
    definition?.kind !== "workflow" ||
    definition.workflow === undefined ||
    definition.target === undefined
  ) return undefined;
  const target = subroutineIn(snapshot, definition.target);
  if (target === undefined) return undefined;
  const baseScope = definition.declaredIn === undefined
    ? definitionRootScope(snapshot, definition)
    : graphScope(snapshot, definition.declaredIn);
  return {
    declaration: declarationOf(definition.documents),
    definition: definition.id,
    ownerGraph: definition.ownerGraph,
    scope: [...baseScope, "Workflows", definition.id],
    target,
    workflow: definition.workflow,
  };
}

/** Human-readable scope shared by overview and entity pages. */
export function navigationContext(snapshot: ProjectSnapshot, current: string): string {
  const workflowContext = workflowCanvas(snapshot, current);
  const graphContext = workflowContext?.ownerGraph ?? current;
  const { ownerPath } = subroutineAddress(snapshot.pinned, graphContext);
  return workflowContext === undefined
    ? `Subroutine ${current}`
    : `Workflow ${qualifiedKey(ownerPath, workflowContext.definition)}`;
}

function localIdentityEntry(
  snapshot: ProjectSnapshot,
  current: string,
  baseScope: string[],
  entity: LocalIdentity,
  id: string,
  group: string | undefined,
  meta: string[],
  references: CanvasSelection[],
  bindings: NavigationEntry[] = [],
): NavigationEntry {
  const key = `${current}/${entity}:${id}`;
  const scope = group === undefined ? baseScope : [...baseScope, group];
  const declaration = entityDeclaration(snapshot, current, entity, id);
  return {
    children: [
      ...bindings.map((binding) => ({
        ...binding,
        key: `${key}/binding:${binding.key}`,
      })),
      ...references.map((reference, index) =>
        referenceEntry(snapshot, current, key, scope, reference, index)
      ),
    ],
    ...(declaration === undefined ? {} : { declaration }),
    entity,
    id,
    key,
    meta,
    ...(snapshot.editable ? { removal: inspection(entity, id, current) } : {}),
    scope,
    target: {
      inspection: inspection(entity, id, current),
      scope: current,
    },
  };
}

function localIdentityEntries(
  snapshot: ProjectSnapshot,
  current: string,
  category: "features" | "profiles" | "sessions",
): NavigationEntry[] {
  const canvas = workflowCanvas(snapshot, current);
  if (canvas !== undefined) {
    if (category === "features") return [];
    const arguments_ = category === "profiles"
      ? canvas.workflow.profile_arguments
      : canvas.workflow.session_arguments;
    const bindingKind = category === "profiles" ? "profile" : "session";
    const resources = category === "profiles"
      ? agentProfiles(canvas.workflow).map(({ id, provider }) => ({ id, meta: [provider ?? "profile"] }))
      : agentSessions(canvas.workflow).map((session) => ({
          id: session.id,
          meta: [session.origin === "parameter" ? "parameter" : session.persistent ? "persistent" : "fresh"],
        }));
    return resources.map(({ id, meta }) => {
      const key = `${current}/${category}:${id}`;
      const declaration = entityDeclaration(snapshot, current, category, id);
      const parameters = Object.entries(arguments_)
        .filter(([, resource]) => resource === id)
        .map(([parameter]) => parameter)
        .sort();
      return {
        children: parameters.length === 0
          ? []
          : [{
              children: [],
              ...(canvas.declaration === undefined
                ? {}
                : { declaration: canvas.declaration }),
              entity: "nodes" as const,
              id: "subroutine",
              key: `${key}/binding:subroutine`,
              meta: parameters.map((parameter) => `${bindingKind} ${parameter}`),
              scope: canvas.scope,
              target: {
                inspection: inspection(
                  "workflows",
                  canvas.definition,
                  canvas.ownerGraph,
                  canvas.definition,
                ),
                scope: current,
                selection: { entity: "nodes" as const, id: nodeId("subroutine") },
              },
            }],
        ...(declaration === undefined ? {} : { declaration }),
        entity: category,
        id,
        key,
        meta,
        ...(snapshot.editable && parameters.length === 0
          ? {
              removal: inspection(
                category,
                id,
                canvas.ownerGraph,
                canvas.definition,
              ),
            }
          : {}),
        ...(snapshot.editable && parameters.length > 0
          ? { removalBlocked: `Rebind this ${bindingKind} before deleting it.` }
          : {}),
        scope: canvas.scope,
        target: {
          inspection: inspection(category, id, canvas.ownerGraph, canvas.definition),
          scope: current,
          selection: { entity: "nodes" as const, id: nodeId("subroutine") },
        },
      };
    });
  }
  const graph = object(subroutineIn(snapshot, current));
  const scope = graphScope(snapshot, current);
  if (category === "features") {
    const edges = entries(graph.edges);
    return entries(graph.features).flatMap((feature) => {
      if (typeof feature.id !== "string" || feature.id === "") return [];
      const id = featureId(feature.id);
      const tag = String(feature.kind ?? "");
      return [
        localIdentityEntry(
          snapshot,
          current,
          scope,
          "features",
          id,
          undefined,
          tag === "" ? [] : [tag],
          edges
            .filter((edge) =>
              [...entries(edge.conditions), ...entries(edge.effects)]
                .some((item) => item.feature_id === id)
            )
            .map((edge) => ({ entity: "edges", id: edgeId(String(edge.id)) })),
        ),
      ];
    });
  }

  const field = category === "profiles" ? "profile" : "session";
  const resources = category === "profiles" ? agentProfiles(graph) : agentSessions(graph);
  const nodes = entries(graph.nodes);
  const bindings = parameterBindingReferences(snapshot, current);
  return resources.map((resource) => {
    const entity: LocalIdentity = resource.origin === "parameter"
      ? category === "profiles" ? "profile_parameters" : "session_parameters"
      : category;
    const references: CanvasSelection[] = nodes.flatMap((node) => {
      const operation = object(node.operation);
      const used = node.kind === "agent"
        ? operation[field] === resource.id
        : node.kind === "subroutine_call" && Object.values(
          object(operation[`${field}_arguments`]),
        ).some((id) => id === resource.id);
      return used ? [{ entity: "nodes", id: nodeId(String(node.id)) }] : [];
    });
    const meta = resource.origin === "parameter"
      ? ["parameter"]
      : "persistent" in resource
        ? [resource.persistent ? "persistent" : "fresh"]
        : [resource.provider ?? "profile"];
    return localIdentityEntry(
      snapshot,
      current,
      scope,
      entity,
      resource.id,
      resource.origin === "parameter" ? "Parameters" : "Local definitions",
      meta,
      references,
      resource.origin === "parameter" ? bindings : [],
    );
  });
}

const directComponent = (entry: NavigationEntry): NavigationEntry => ({
  ...entry,
  scope: [],
});

function canvasComponentEntry(
  snapshot: ProjectSnapshot,
  current: string,
  entity: CanvasSelection["entity"],
  id: string,
  removable: boolean,
): NavigationEntry {
  const selection: CanvasSelection = entity === "edges"
    ? { entity, id: edgeId(id) }
    : { entity, id: nodeId(id) };
  const declaration = entityDeclaration(snapshot, current, entity, id);
  return {
    children: [],
    ...(declaration === undefined ? {} : { declaration }),
    entity,
    id,
    key: `${current}/${entity}:${id}`,
    meta: [],
    ...(removable && snapshot.editable
      ? { removal: inspection(entity, id, current) }
      : {}),
    scope: [],
    target: {
      inspection: inspection(entity, id, current),
      scope: current,
      selection,
    },
  };
}

/** The entities owned immediately by a definition, ready for its property page. */
export function definitionComponentEntries(
  snapshot: ProjectSnapshot,
  current: SubroutineGraph,
  inspected: NavigationInspection,
): NavigationEntry[] {
  if (inspected.entity !== "subroutines" && inspected.entity !== "workflows") return [];
  const indexes = snapshotDefinitionIndexes(snapshot);
  const definitions = snapshotDefinitions(snapshot, indexes);
  const definition = definitions.find(({ id, kind, ownerGraph }) =>
    kind === DEFINITION_KIND[inspected.entity] &&
    id === inspected.id &&
    ownerGraph === inspected.subroutine
  );
  if (definition === undefined || definition.ambiguous === true) return [];

  if (inspected.entity === "workflows") {
    if (
      definition.workflow === undefined ||
      definition.key !== current.id ||
      definition.scope !== current.id
    ) return [];
    const declaration = declarationOf(definition.documents);
    return [
      {
        children: [],
        ...(declaration === undefined ? {} : { declaration }),
        entity: "nodes",
        id: "subroutine",
        key: `${current.id}/nodes:subroutine`,
        meta: [],
        scope: [],
        target: {
          inspection: inspection(
            "workflows",
            definition.id,
            definition.ownerGraph,
            definition.id,
          ),
          scope: current.id,
          selection: { entity: "nodes", id: nodeId("subroutine") },
        },
      },
      ...(["profiles", "sessions"] as const).flatMap((category) =>
        localIdentityEntries(snapshot, current.id, category)
      ).map(directComponent),
    ];
  }

  if (current.scope.kind !== "subroutine" || definition.target !== current.id) return [];
  const graph = object(subroutineIn(snapshot, current.id));
  const ports = new Set(
    Object.values(object(graph.ports)).filter((id): id is string => typeof id === "string"),
  );
  const nodes = entries(graph.nodes).flatMap((node) =>
    typeof node.id === "string" && node.id !== ""
      ? [canvasComponentEntry(snapshot, current.id, "nodes", node.id, !ports.has(node.id))]
      : []
  );
  const edges = entries(graph.edges).flatMap((edge) =>
    typeof edge.id === "string" && edge.id !== ""
      ? [canvasComponentEntry(snapshot, current.id, "edges", edge.id, true)]
      : []
  );
  const visible = visibleDefinitionKeys(snapshot, current.id, indexes);
  const callers = definitionCallReferences(snapshot, indexes, definitions);
  const nested = definitions
    .filter(({ declaredIn }) => declaredIn === current.id)
    .map((item) => definitionEntry(snapshot, visible, definitions, callers, item));
  return [
    ...nodes,
    ...edges,
    ...(["features", "profiles", "sessions"] as const).flatMap((category) =>
      localIdentityEntries(snapshot, current.id, category)
    ),
    ...nested,
  ].map(directComponent);
}

/**
 * Where a profile or session parameter leads: one entry per concrete resource it resolves to
 * through this project's call paths, each opening that resource's own page.
 */
export function resolvedBindingEntries(
  snapshot: ProjectSnapshot,
  inspected: NavigationInspection,
): NavigationEntry[] {
  if (inspected.entity !== "profile_parameters" && inspected.entity !== "session_parameters") return [];
  const resource = inspected.entity === "profile_parameters" ? "profile" : "session";
  const category = resource === "profile" ? "profiles" : "sessions";
  const { ownerPath, subroutine } = subroutineAddress(snapshot.pinned, inspected.subroutine);
  const project = projectIn(snapshot, inspected.subroutine).project;
  const parentKey = `${inspected.subroutine}/${inspected.entity}:${inspected.id}`;
  return resolveParameter(project, subroutine, resource, inspected.id).flatMap((binding) => {
    const summary = bindingSummary(binding);
    const meta = ["resolves to", ...(summary.includes("(") ? [summary.slice(summary.indexOf("(") + 1, -1)] : [])];
    if (binding.owner.kind === "workflow") {
      const workflowKey = qualifiedKey(ownerPath, definitionKey("workflow", binding.owner.id));
      const canvas = workflowCanvas(snapshot, workflowKey);
      if (canvas === undefined) return [];
      const declaration = entityDeclaration(snapshot, workflowKey, category, binding.id);
      return [{
        children: [],
        ...(declaration === undefined ? {} : { declaration }),
        entity: category,
        id: binding.id,
        key: `${parentKey}/resolves:${workflowKey}:${binding.id}`,
        meta,
        scope: canvas.scope,
        target: {
          inspection: inspection(category, binding.id, canvas.ownerGraph, canvas.definition),
          scope: workflowKey,
          selection: { entity: "nodes" as const, id: nodeId("subroutine") },
        },
      }];
    }
    const ownerKey = qualifiedKey(ownerPath, binding.owner.id);
    const declaration = entityDeclaration(snapshot, ownerKey, category, binding.id);
    return [{
      children: [],
      ...(declaration === undefined ? {} : { declaration }),
      entity: category,
      id: binding.id,
      key: `${parentKey}/resolves:${ownerKey}:${binding.id}`,
      meta,
      scope: [...graphScope(snapshot, ownerKey), "Local definitions"],
      target: {
        inspection: inspection(category, binding.id, ownerKey),
        scope: ownerKey,
      },
    }];
  });
}

/** The identities shown by one canvas navigator, projected without React or VS Code. */
export function terminationNavigation(snapshot: ProjectSnapshot, current: string): TerminationNavigation {
  const state = terminationFor(snapshot.termination, current);
  if (state.status !== "ready") return { state, entries: [] };
  const { definition } = state;
  const witnesses = definition.regions.flatMap(({ witnesses }) => witnesses);
  const nodes = new Set(definition.regions.flatMap(({ nodes }) => nodes));
  const edges = new Set([
    ...definition.regions.flatMap(({ edges }) => edges),
    ...witnesses.flatMap(({ edges, opposing_edges }) => [...edges, ...opposing_edges]),
  ]);
  const features = new Set(witnesses.map(({ feature }) => feature));
  const definitions = snapshotDefinitions(snapshot);
  const references = definition.dependencies.flatMap(({ scope, node }) => {
    const item = definitions.find(({ key }) => key === scope) ??
      definitions.find((item) => item.kind === "subroutine" && item.scope === scope);
    if (item === undefined) return [];
    const entry = definitionEntry(snapshot, new Set([item.key]), definitions, new Map(), item);
    const dependency = terminationFor(snapshot.termination, scope);
    return [{
      ...entry,
      key: `termination/dependency:${node}:${scope}`,
      meta: [
        dependency.status === "ready" ? TERMINATION_LABEL[dependency.definition.status] : "Unavailable",
        node === "" ? "entry subroutine" : `called by ${node}`,
      ],
    }];
  });
  const links = [
    ...[...nodes].map((id) => canvasComponentEntry(snapshot, current, "nodes", id, false)),
    ...[...edges].map((id) => canvasComponentEntry(snapshot, current, "edges", id, false)),
    ...localIdentityEntries(snapshot, current, "features").filter(({ id }) => features.has(id)),
    ...references,
  ];
  return {
    state,
    entries: links.map(({ removal: _removal, removalBlocked: _blocked, ...entry }) => ({
      ...entry, children: [], scope: [],
    })),
  };
}

export function navigationPage(
  snapshot: ProjectSnapshot,
  current: string,
  category: "status",
): StatusNavigationPage;
export function navigationPage(
  snapshot: ProjectSnapshot,
  current: string,
  category: EntityNavigationCategory,
): EntityNavigationPage;
export function navigationPage(
  snapshot: ProjectSnapshot,
  current: string,
  category: NavigationCategory,
): NavigationPage;
export function navigationPage(
  snapshot: ProjectSnapshot,
  current: string,
  category: NavigationCategory,
): NavigationPage {
  const workflowContext = workflowCanvas(snapshot, current);
  const graphContext = workflowContext?.ownerGraph ?? current;
  const { ownerPath } = subroutineAddress(snapshot.pinned, graphContext);
  const context = navigationContext(snapshot, current);
  if (category === "status") {
    return {
      category,
      context,
      status: {
        checked: snapshot.checked,
        diagnosticCount: snapshot.diagnostic_count,
        graphHash: snapshot.graph_hash,
        location: ownerPath === undefined ? "/" : `/${packageDirectory(ownerPath)}`,
        pinned: ownerPath !== undefined,
        stale: isStale(snapshot),
      },
      title: TITLES[category],
      termination: terminationNavigation(snapshot, current),
    };
  }

  let entries: NavigationEntry[];
  if (category === "subroutines" || category === "workflows") {
    const kind = DEFINITION_KIND[category];
    const indexes = snapshotDefinitionIndexes(snapshot);
    const visible = visibleDefinitionKeys(snapshot, graphContext, indexes);
    const definitions = snapshotDefinitions(snapshot, indexes);
    const callers = definitionCallReferences(snapshot, indexes, definitions);
    entries = definitions
      .filter((item) => item.kind === kind)
      .map((item) => definitionEntry(snapshot, visible, definitions, callers, item));
  } else {
    entries = localIdentityEntries(snapshot, current, category);
  }
  return { category, context, entries, title: TITLES[category] };
}

/** The definition represented by the current canvas scope. */
export function definitionTarget(
  snapshot: ProjectSnapshot,
  current: SubroutineGraph,
): NavigationTarget | undefined {
  const scope = current.scope;
  const definition = snapshotDefinitions(snapshot).find((item) =>
    item.kind === scope.kind && (scope.kind === "subroutine"
      ? item.target === current.id
      : item.key === current.id && item.id === scope.definition && item.ownerGraph === scope.ownerGraph)
  );
  return definition === undefined ? undefined : definitionNavigationTarget(definition);
}

/** The exact definition represented by a call node, including a local external alias. */
export function calledDefinitionTarget(
  snapshot: ProjectSnapshot,
  current: SubroutineGraph,
  node: SubroutineNode,
): NavigationTarget | undefined {
  return calledDefinitionEntry(snapshot, current, node)?.target;
}

/** The definition entry represented by a call node, including its declaration. */
export function calledDefinitionEntry(
  snapshot: ProjectSnapshot,
  current: SubroutineGraph,
  node: SubroutineNode,
): NavigationEntry | undefined {
  if (!isCallNodeKind(node.data.kind)) return undefined;
  const indexes = snapshotDefinitionIndexes(snapshot);
  const definitions = snapshotDefinitions(snapshot, indexes);
  const caller = current.scope.ownerGraph;
  const visible = visibleDefinitionKeys(snapshot, caller, indexes);
  const { ownerPath } = subroutineAddress(snapshot.pinned, caller);
  const raw = current.scope.kind === "workflow"
    ? node.id === "subroutine"
      ? { kind: "subroutine_call" as const, operation: { target: current.scope.workflow.subroutine } }
      : undefined
    : subroutineIn(snapshot, caller)?.nodes?.find((candidate) => candidate?.id === node.id);
  const key = raw === undefined ? undefined : callDefinitionKey(snapshot, caller, raw, visible, indexes.get(ownerPath ?? ""));
  const definition = definitions.find((item) => item.key === key);
  return definition === undefined || definition.ambiguous === true
    ? undefined
    : definitionEntry(snapshot, visible, definitions, new Map(), definition);
}

function definitionForImpact(
  snapshot: ProjectSnapshot,
  ownerPath: string | undefined,
  impact: RemovalImpact,
): DefinitionItem | undefined {
  if (impact.entity !== "subroutines" && impact.entity !== "workflows") return undefined;
  const kind = DEFINITION_KIND[impact.entity];
  const key = qualifiedKey(ownerPath, definitionKey(kind, graphId(impact.id)));
  return snapshotDefinitions(snapshot).find((item) => item.key === key);
}

/** A removal-review identity resolved back to the graph and declaration it came from. */
export function removalNavigationEntry(
  snapshot: ProjectSnapshot,
  originSubroutine: string,
  impact: RemovalImpact,
): NavigationEntry {
  const workflow = impact.workflow;
  const { ownerPath } = subroutineAddress(snapshot.pinned, originSubroutine);
  const project = projectIn(snapshot, originSubroutine).project;
  const workflowKey = workflow === undefined
    ? undefined
    : qualifiedKey(ownerPath, definitionKey("workflow", workflow));
  const workflowContext = workflowKey === undefined
    ? undefined
    : workflowCanvas(snapshot, workflowKey);
  const workflowResource = workflowContext !== undefined &&
    (impact.entity === "profiles" || impact.entity === "sessions");
  const localOwner = impact.scope.at(-1);
  const ownerSubroutine = localOwner === undefined
    ? originSubroutine
    : qualifiedKey(ownerPath, String(localOwner));
  const definition = definitionForImpact(snapshot, ownerPath, impact);
  const documented = impact.entity !== "subroutines" && impact.entity !== "workflows"
    ? impact.entity as DocumentedEntity
    : undefined;
  const declaration = definition === undefined
    ? documented === undefined
      ? undefined
      : entityDeclaration(
          snapshot,
          workflowResource ? workflowKey! : ownerSubroutine,
          documented,
          impact.id,
        )
    : declarationOf(definition.documents);
  const target = impact.entity === "edges" || impact.entity === "nodes"
    ? {
        selection: impact.entity === "edges"
          ? { entity: "edges" as const, id: edgeId(impact.id) }
          : { entity: "nodes" as const, id: nodeId(impact.id) },
        scope: ownerSubroutine,
      }
    : definition === undefined && documented === undefined
      ? undefined
      : {
          inspection: inspection(
            impact.entity,
            impact.id,
            definition?.ownerGraph ??
              (workflowResource ? workflowContext.ownerGraph : ownerSubroutine),
            workflowResource ? workflow : undefined,
          ),
          scope: workflowResource
            ? workflowKey!
            : definition?.scope ?? definition?.target ?? ownerSubroutine,
          ...(workflowResource
            ? { selection: { entity: "nodes" as const, id: nodeId("subroutine") } }
            : {}),
        };
  const owner = ownerFolder(ownerPath, project.package);
  return {
    children: [],
    ...(declaration === undefined ? {} : { declaration }),
    entity: impact.entity,
    id: impact.id,
    key: `${workflowResource ? workflowKey : ownerSubroutine}/${impact.entity}:${impact.id}`,
    meta: impact.reasons.map((reason) => reason.replaceAll("_", " ")),
    scope: workflowResource
      ? workflowContext.scope
      : [owner, ...impact.scope.map((id) => String(graphLeaf(id)))],
    ...(target === undefined ? {} : { target }),
  };
}
