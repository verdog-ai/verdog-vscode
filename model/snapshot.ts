// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import type { EntityDocumentRefs } from "./documents";
import {
  graphId,
  parseQualifiedSubroutineTarget,
  qualifiedSubroutineTarget,
  type GraphId,
} from "./identifiers";
import { packageDirectory } from "./names";
import {
  definitionIn,
  subroutineInProject,
  subroutinesIn,
  type CallTarget,
  type CanonicalProject,
  type SubroutineDefinition,
} from "./project";
import { entries } from "./reading";
import type { TerminationState } from "./termination";

export type EntityDocuments = {
  [Collection in "edges" | "features" | "nodes" | "profile_parameters" | "profiles" |
    "session_parameters" | "sessions"]: Record<string, Record<string, EntityDocumentRefs>>;
};

/** The graph data shared by host-side edits and canvas-side reads. */
export type ProjectGraphs = {
  entity_documents: EntityDocuments;
  /** Each pinned dependency's graph, by owner-relative alias path. */
  pinned: Record<string, CanonicalProject>;
  project: CanonicalProject;
};

/** The complete snapshot sent from the extension host to the canvas. */
export type ProjectSnapshot = ProjectGraphs & {
  checked: boolean;
  diagnostic_count: number;
  editable: boolean;
  graph_hash: string;
  initial_scope: string;
  termination?: TerminationState;
};

export const isStale = (snapshot: ProjectSnapshot): boolean =>
  snapshot.project.generated_from !== snapshot.graph_hash;

export const qualifiedKey = (ownerPath: string | undefined, id: string): string =>
  ownerPath ? `${ownerPath}/${id}` : id;

/** A pin's project root, relative to the root clone that owns this snapshot. */
export const ownerRoot = (ownerPath: string): string =>
  ownerPath
    .split("/")
    .flatMap((alias) => ["external", packageDirectory(alias)])
    .join("/");

/** A path in one pin, made relative to the root clone that owns this snapshot. */
export const sourceInOwner = (source: string, ownerPath: string | undefined): string =>
  ownerPath === undefined ? source : `${ownerRoot(ownerPath)}/${source}`;

/** Split a subroutine key only when its prefix names a project in this snapshot. */
export function subroutineAddress(
  pinned: Readonly<Record<string, unknown>>,
  key: string,
): { ownerPath?: string; subroutine: GraphId } {
  const cut = key.lastIndexOf("/");
  if (cut < 0) return { subroutine: graphId(key) };
  const ownerPath = key.slice(0, cut);
  return pinned[ownerPath] === undefined
    ? { subroutine: graphId(key) }
    : { ownerPath, subroutine: graphId(key.slice(cut + 1)) };
}

/** The project a composite subroutine key belongs to, and its local subroutine id. */
export function projectIn(
  snapshot: ProjectGraphs,
  key: string,
): { id: GraphId; project: CanonicalProject } {
  const { ownerPath, subroutine } = subroutineAddress(snapshot.pinned, key);
  return ownerPath === undefined
    ? { id: subroutine, project: snapshot.project }
    : { id: subroutine, project: snapshot.pinned[ownerPath] };
}

/** The subroutine graph behind a local or owner-qualified key. */
export function subroutineIn(
  snapshot: ProjectGraphs,
  key: string,
): SubroutineDefinition | undefined {
  const { id, project } = projectIn(snapshot, key);
  return subroutineInProject(project, id);
}

/** The graph named by one local or qualified external in-process call. */
export function subroutineCallTarget(
  snapshot: ProjectGraphs,
  caller: string,
  target: string,
): SubroutineDefinition | undefined {
  const { ownerPath } = subroutineAddress(snapshot.pinned, caller);
  if (!target.includes("/")) {
    return definitionIn(projectIn(snapshot, caller).project, "subroutine", graphId(target))
      ?.subroutine;
  }
  const external = parseQualifiedSubroutineTarget(target);
  if (external === undefined) return undefined;
  const project = snapshot.pinned[qualifiedKey(ownerPath, external.alias)];
  return subroutineInProject(project, external.subroutine);
}

/** Every automatically importable subroutine in this clone's direct pins. */
export function externalSubroutineTargets(
  snapshot: ProjectGraphs,
  key: string,
): CallTarget[] {
  const { ownerPath } = subroutineAddress(snapshot.pinned, key);
  const owner = projectIn(snapshot, key).project;
  return entries(owner.externals).flatMap((raw) => {
    const alias = raw.alias;
    if (typeof alias !== "string") return [];
    const pinned = snapshot.pinned[qualifiedKey(ownerPath, alias)];
    return subroutinesIn(pinned).map((subroutine) => ({
      externalAlias: alias,
      id: qualifiedSubroutineTarget(`${alias}/${subroutine.id}`),
      kind: "subroutine" as const,
      name: subroutine.name,
    }));
  });
}
