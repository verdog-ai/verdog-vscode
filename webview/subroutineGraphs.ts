/** Turn the shared project snapshot into the graphs the canvas draws. */

import { definitionDocumentPaths, type DocumentLink } from "../model/documents";
import { edgeId, nodeId, parseQualifiedSubroutineTarget } from "../model/identifiers";
import { packageDirectory } from "../model/names";
import {
  definitionIn,
  definitionIndex,
  definitionKey,
  resolveCall,
  subroutinesIn,
  visibleDefinitions,
  isAddableNodeKind,
  type CanonicalProject,
  type Definition,
  type DefinitionIndex,
} from "../model/project";
import {
  externalSubroutineTargets,
  projectIn,
  qualifiedKey,
  sourceInOwner,
  subroutineAddress,
  subroutineIn,
  type ProjectGraphs,
} from "../model/snapshot";
import { array, entries, object, text } from "../model/reading";

import type {
  DefinitionRef,
  DefinitionItem,
  SubroutineEdge,
  SubroutineGraph,
  SubroutineMap,
  SubroutineNode,
} from "./subroutines";

function definitionRef(
  snapshot: ProjectGraphs,
  definition: Definition | undefined,
  ownerPath: string | undefined,
  indexes?: ReadonlyMap<string, DefinitionIndex>,
): DefinitionRef | undefined {
  if (definition === undefined) return undefined;
  if (definition.external === undefined) {
    if (definition.target === undefined) return undefined;
    return {
      graph: definition.target,
      ...(ownerPath === undefined ? {} : { ownerPath }),
      ...(definition.kind === "workflow"
        ? { scope: qualifiedKey(ownerPath, definitionKey("workflow", definition.id)) }
        : {}),
    };
  }
  const aliasPath = qualifiedKey(ownerPath, definition.external.alias);
  const pinned = snapshot.pinned[aliasPath];
  const target = pinned === undefined
    ? undefined
    : definitionIn(
        pinned,
        "workflow",
        definition.external.workflow,
        indexes?.get(aliasPath),
      )?.target;
  if (target === undefined) return undefined;
  return {
    graph: target,
    ...(ownerPath === undefined ? {} : { ownerPath }),
    alias: definition.external.alias,
    scope: qualifiedKey(
      aliasPath,
      definitionKey("workflow", definition.external.workflow),
    ),
  };
}

function externalSubroutineRef(
  snapshot: ProjectGraphs,
  target: string | undefined,
  ownerPath: string | undefined,
): DefinitionRef | undefined {
  if (target === undefined) return undefined;
  const external = parseQualifiedSubroutineTarget(target);
  if (external === undefined) return undefined;
  const { alias, subroutine: subroutineId } = external;
  const aliasPath = qualifiedKey(ownerPath, alias);
  if (definitionIndex(snapshot.pinned[aliasPath]).subroutines.get(subroutineId) === undefined) {
    return undefined;
  }
  return {
    alias,
    graph: subroutineId,
    ...(ownerPath === undefined ? {} : { ownerPath }),
  };
}

function targetOf(reference: DefinitionRef | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const owner = reference.alias
    ? qualifiedKey(reference.ownerPath, reference.alias)
    : reference.ownerPath;
  return qualifiedKey(owner, reference.graph);
}

function implementationOf(
  snapshot: ProjectGraphs,
  reference: DefinitionRef | undefined,
): string | undefined {
  if (reference === undefined) return undefined;
  const ownerPath = reference.alias
    ? qualifiedKey(reference.ownerPath, reference.alias)
    : reference.ownerPath;
  const project = ownerPath === undefined ? snapshot.project : snapshot.pinned[ownerPath];
  if (project === undefined) return undefined;
  const definition = definitionIn(project, "subroutine", reference.graph);
  if (definition?.path === undefined) return undefined;
  return sourceInOwner(
    [
      "src",
      packageDirectory(project.package),
      ...definition.path,
      "impl.py",
    ].join("/"),
    ownerPath,
  );
}

export function snapshotSubroutines(snapshot: ProjectGraphs): SubroutineMap {
  return Object.fromEntries([
    ...graphsOf(snapshot, snapshot.project, undefined),
    ...Object.entries(snapshot.pinned).flatMap(([pin, project]) =>
      graphsOf(snapshot, project, pin),
    ),
  ]);
}

/** Subroutine graphs plus each local workflow's one-call process boundary. */
export function snapshotCanvasGraphs(snapshot: ProjectGraphs): SubroutineMap {
  const subroutines = snapshotSubroutines(snapshot);
  const workflows = snapshotDefinitions(snapshot).flatMap((definition) => {
    if (
      definition.kind !== "workflow" ||
      definition.workflow === undefined ||
      definition.target === undefined
    ) return [];
    const target = subroutines[definition.target];
    if (target === undefined || target.scope.kind !== "subroutine") return [];
    const address = subroutineAddress(snapshot.pinned, definition.target);
    const project = projectIn(snapshot, definition.target).project;
    const body = subroutineIn(snapshot, definition.target);
    if (body === undefined) return [];
    const reference = definitionRef(
      snapshot,
      definitionIn(project, "subroutine", address.subroutine),
      address.ownerPath,
    );
    const graph: SubroutineGraph = {
      edges: [],
      id: definition.key,
      nodes: [{
        data: {
          ...(reference === undefined ? {} : { definition: reference }),
          kind: "subroutine_call",
          label: text(body.name) || definition.id,
        },
        id: nodeId("subroutine"),
      }],
      scope: {
        definition: definition.id,
        kind: "workflow",
        ownerGraph: definition.ownerGraph,
        target: body,
        workflow: definition.workflow,
      },
    };
    return [[
      definition.key,
      graph,
    ] as [string, SubroutineGraph]];
  });
  return { ...subroutines, ...Object.fromEntries(workflows) };
}

/** The process boundary governing the current point in canvas history. */
export function activeWorkflowScope(
  graphs: SubroutineMap,
  entries: readonly string[],
  cursor: number,
): {
  key: string;
  scope: Extract<SubroutineGraph["scope"], { kind: "workflow" }>;
} | undefined {
  for (; cursor >= 0; --cursor) {
    const key = entries[cursor] ?? "";
    const scope = graphs[key]?.scope;
    if (scope?.kind === "workflow") return { key, scope };
  }
  return undefined;
}

/** Every definition in the project and its pins, ready for the canvas navigator. */
export function snapshotDefinitions(
  snapshot: ProjectGraphs,
  indexes = snapshotDefinitionIndexes(snapshot),
): DefinitionItem[] {
  return [
    ...definitionsOf(snapshot, snapshot.project, undefined, indexes),
    ...Object.entries(snapshot.pinned).flatMap(([pin, project]) =>
      definitionsOf(snapshot, project, pin, indexes),
    ),
  ];
}

/** One tolerant definition index per project represented by this snapshot. */
export function snapshotDefinitionIndexes(
  snapshot: ProjectGraphs,
): ReadonlyMap<string, DefinitionIndex> {
  return new Map([
    ["", definitionIndex(snapshot.project)],
    ...Object.entries(snapshot.pinned).map(([ownerPath, project]) =>
      [ownerPath, definitionIndex(project)] as const
    ),
  ]);
}

/** Definitions callable from the currently shown lexical scope. */
export function visibleDefinitionKeys(
  snapshot: ProjectGraphs,
  current: string,
  indexes = snapshotDefinitionIndexes(snapshot),
): ReadonlySet<string> {
  const { ownerPath } = subroutineAddress(snapshot.pinned, current);
  const at = projectIn(snapshot, current);
  const index = indexes.get(ownerPath ?? "");
  const keys = new Set(
    visibleDefinitions(at.project, at.id, undefined, index)
      .filter((definition) =>
        !index?.duplicates.has(definitionKey(definition.kind, definition.id))
      )
      .map((definition) =>
        qualifiedKey(ownerPath, definitionKey(definition.kind, definition.id))
      ),
  );
  for (const target of externalSubroutineTargets(snapshot, current)) {
    const external = parseQualifiedSubroutineTarget(target.id);
    if (external === undefined) continue;
    const pin = qualifiedKey(ownerPath, external.alias);
    keys.add(qualifiedKey(pin, definitionKey("subroutine", external.subroutine)));
  }
  return keys;
}

function definitionDocuments(
  project: CanonicalProject,
  definition: Definition,
  ownerPath: string | undefined,
): DocumentLink[] {
  if (definition.path === undefined || definition.external !== undefined) return [];
  const base = ["src", packageDirectory(project.package), ...definition.path].join("/");
  const present = new Set(
    array(object(project).sources).map((source) => text(object(source).path)).filter(Boolean),
  );
  return definitionDocumentPaths(base, definition.kind).flatMap(({ label, path }) => {
    return present.has(path)
      ? [{ label, path: sourceInOwner(path, ownerPath) }]
      : [];
  });
}

function definitionsOf(
  snapshot: ProjectGraphs,
  project: CanonicalProject,
  ownerPath: string | undefined,
  indexes: ReadonlyMap<string, DefinitionIndex>,
): DefinitionItem[] {
  const index = indexes.get(ownerPath ?? "") ?? definitionIndex(project);
  return [...index.definitions.values()].map((definition) => {
    const localKey = definitionKey(definition.kind, definition.id);
    const reference = definitionRef(snapshot, definition, ownerPath, indexes);
    const target = targetOf(reference);
    const declaredIn = definition.declaredIn === undefined
      ? undefined
      : qualifiedKey(ownerPath, definition.declaredIn);
    const scope = definition.kind === "subroutine"
      ? target
      : definition.workflow !== undefined
        ? qualifiedKey(ownerPath, localKey)
        : definition.external === undefined || target === undefined
          ? undefined
          : qualifiedKey(
              qualifiedKey(ownerPath, definition.external.alias),
              definitionKey("workflow", definition.external.workflow),
            );
    return {
      ...(index.duplicates.has(localKey) ? { ambiguous: true as const } : {}),
      ...(declaredIn === undefined ? {} : { declaredIn }),
      documents: definitionDocuments(project, definition, ownerPath),
      id: definition.id,
      key: qualifiedKey(ownerPath, localKey),
      kind: definition.kind,
      ownerGraph: declaredIn ?? target ?? definition.id,
      ...(scope === undefined ? {} : { scope }),
      ...(target === undefined ? {} : { target }),
      ...(definition.workflow === undefined ? {} : { workflow: definition.workflow }),
    };
  });
}

function graphsOf(
  snapshot: ProjectGraphs,
  project: CanonicalProject,
  pinnedFrom: string | undefined,
): [string, SubroutineGraph][] {
  const key = (id: string) => qualifiedKey(pinnedFrom, id);

  return subroutinesIn(project).map((subroutine) => {
    const nodes = entries(subroutine.nodes).flatMap((node): SubroutineNode[] => {
      const kind = node.kind;
      if (typeof node.id !== "string" || !node.id || (
        !isAddableNodeKind(kind) && kind !== "enter" && kind !== "exit" && kind !== "failure"
      )) return [];
      const operation = object(node.operation);
      const definition =
        definitionRef(snapshot, resolveCall(project, subroutine.id, { kind, operation }), pinnedFrom) ??
        (kind === "subroutine_call"
          ? externalSubroutineRef(snapshot, text(operation.target), pinnedFrom)
          : undefined);
      const implementation = implementationOf(snapshot, definition);
      return [{
        data: {
          definition,
          kind,
          label: text(node.name) || node.id,
          ...(implementation === undefined ? {} : { implementation }),
        },
        id: nodeId(node.id),
      }];
    });
    const executableIds = new Set<string>(nodes.map(({ id }) => id));
    const edges: SubroutineEdge[] = entries(subroutine.edges)
      .filter((edge) => text(edge.id) && executableIds.has(text(edge.source)) && executableIds.has(text(edge.target)))
      .map((edge) => ({
        id: edgeId(text(edge.id)),
        source: nodeId(text(edge.source)),
        target: nodeId(text(edge.target)),
      }));
    return [
      key(subroutine.id),
      {
        edges,
        id: key(subroutine.id),
        nodes,
        scope: { kind: "subroutine", ownerGraph: key(subroutine.id) },
      },
    ];
  });
}
