// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Properties projected from the current graph. */

import { documentsOf, visitDocumentsOf } from "../model/documents";
import type { Entity } from "../model/editing";
import { isFeatureKind, type FeatureKind, type ObservationCollection } from "../model/features";
import { featureId, graphId } from "../model/identifiers";
import { isAgentProvider } from "../model/agents";
import { bindingSummary, resolveParameter } from "../model/bindings";
import type {
  CanvasSelection,
  EdgeConstraint,
  NavigationInspection,
  ProfileConfiguration,
  PropertyNavigationPage,
} from "../model/protocol";
import {
  DEFINITION_KIND,
  definitionIn,
  resolveCall,
  subroutineInProject,
  type ProjectNode,
  type LocalWorkflowDefinition,
} from "../model/project";
import { entityLabel } from "../model/names";
import { entries, object } from "../model/reading";
import { nodeResourceFields, workflowResourceFields } from "../model/resources";
import { projectIn, type ProjectSnapshot } from "../model/snapshot";
import {
  calledDefinitionEntry,
  definitionComponentEntries,
  resolvedBindingEntries,
  terminationNavigation,
} from "./navigation";
import { snapshotDefinitions } from "./subroutineGraphs";
import type { SubroutineGraph } from "./subroutines";

export type { EdgeConstraint, ProfileConfiguration };

export type Details = {
  /** Authored condition and effect rows; present only for edges. */
  constraints?: EdgeConstraint[];
  fields: { label: string; value: string }[];
  /** Whether this entity authors its own id rather than deriving it. */
  idEditable: boolean;
  /** The heading: a node's own kind, or just `edge`. */
  kind: string;
  /** The prose label. A feature keeps its in `label`; nodes and edges call it `name`. */
  name: string;
  /** Whether this entity authors its displayed name rather than deriving it. */
  nameEditable: boolean;
  /** Concrete provider settings; absent for an abstract profile parameter. */
  profile?: ProfileConfiguration;
  /** Session persistence, editable independently of profiles. */
  persistent?: boolean;
};

const profileConfiguration = (value: Record<string, unknown>): ProfileConfiguration | undefined => {
  const options = object(value.options);
  return isAgentProvider(value.provider) &&
      (typeof options.model === "string" || options.model === null) &&
      (typeof options.reasoning_effort === "string" || options.reasoning_effort === null) &&
      Array.isArray(options.extra_args) &&
      options.extra_args.every((item) => typeof item === "string")
    ? {
        provider: value.provider,
        options: {
          model: options.model,
          reasoning_effort: options.reasoning_effort,
          extra_args: options.extra_args,
          ...(options.web_search === true ? { web_search: true } : {}),
        },
      }
    : undefined;
};

const isParameterEntity = (kind: string): kind is "profile_parameters" | "session_parameters" =>
  kind === "profile_parameters" || kind === "session_parameters";

/** What a parameter resolves to inside this project, as readable rows. */
function resolutionFields(
  project: unknown,
  graphIdentifier: ReturnType<typeof graphId>,
  kind: "profile_parameters" | "session_parameters",
  id: string,
): { label: string; value: string }[] {
  const resource = kind === "profile_parameters" ? "profile" : "session";
  const bindings = resolveParameter(project, graphIdentifier, resource, id);
  return bindings.length === 0
    ? [{ label: "resolves to", value: "nothing in this project; a caller outside it binds this parameter" }]
    : bindings.map((binding) => ({ label: "resolves to", value: bindingSummary(binding) }));
}

/** Compact mathematical notation used by the language documentation. */
export function constraintNotation(
  collection: ObservationCollection,
  id: string,
  kind: FeatureKind,
  observation: string,
  value?: string,
): string {
  if (collection === "conditions") {
    if (observation === "positive") return id;
    if (observation === "negative") return `¬${id}`;
    if (observation === "equal_zero") return `${id}=0`;
    if (observation === "greater_zero") return `${id}>0`;
    if (observation === "equal") return `${id}=${value ?? "?"}`;
  } else {
    if (observation === "positive") return `${id}:=⊤`;
    if (observation === "negative") return `${id}:=⊥`;
    if (observation === "equal") return `${id}:=${value ?? "?"}`;
    if (observation === "increases") return `${id}↑`;
    if (observation === "decreases") return `${id}↓`;
    if (observation === "unchanged") return `${id}=`;
    if (observation === "unconstrained") return `${id}${kind === "boolean" ? ":?" : "?"}`;
  }
  return `${id} ${observation}${value === undefined ? "" : ` ${value}`}`;
}

function resourceDetails(
  kind: "profile_parameters" | "profiles" | "session_parameters" | "sessions",
  found: Record<string, unknown>,
  id: string,
  idEditable: boolean,
  fields: { label: string; value: string }[] = [],
): Details {
  const persistent = kind === "sessions" && typeof found.persistent === "boolean"
    ? found.persistent
    : undefined;
  const profile = kind === "profiles" ? profileConfiguration(found) : undefined;
  return {
    fields,
    idEditable,
    kind: entityLabel(kind),
    name: String(found.name ?? id),
    nameEditable: true,
    ...(profile === undefined ? {} : { profile }),
    ...(persistent === undefined ? {} : { persistent }),
  };
}

/** Properties for a resource owned by a workflow rather than its wrapped subroutine. */
export function workflowResourceDetails(
  workflow: LocalWorkflowDefinition,
  kind: "profiles" | "sessions",
  id: string,
): Details | undefined {
  const found = entries(workflow[kind]).find((item) => item.id === id);
  return found === undefined
    ? undefined
    : resourceDetails(kind, found, id, false);
}

/**
 * One entity's readable properties, from the graph.
 *
 * The page shows a node's kind and what its operation points at, and an edge's ends and what
 * it says about each feature. None of it needs the compiler: it is all in `project.json`, for
 * the same reason the feature list is.
 */
export function entityDetails(
  project: unknown,
  subroutineId: string,
  kind: Entity,
  id: string,
): Details | undefined {
  const graphIdentifier = graphId(subroutineId);
  const subroutine = subroutineInProject(project, graphIdentifier);
  if (subroutine === undefined) return undefined;
  const graph = object(subroutine);
  const fields: { label: string; value: string }[] = [];
  if (kind === "workflows" || kind === "subroutines") {
    const definitionKind = DEFINITION_KIND[kind];
    const definition = definitionIn(project, definitionKind, graphId(id));
    const root = definition?.declaredIn === undefined && definition?.id === graphIdentifier;
    if (definition?.declaredIn !== graphIdentifier && !root) return undefined;
    if (definition.external !== undefined) {
      fields.push({
        label: "external",
        value: `${definition.external.alias} / ${definition.external.workflow}`,
      });
    } else if (kind === "workflows" && definition.target !== undefined) {
      fields.push({ label: "subroutine", value: definition.target });
    }
    return {
      fields,
      idEditable:
        !root && (definition.kind === "subroutine" || definition.external !== undefined),
      kind: `${definitionKind} definition`,
      name: definition.name,
      nameEditable: definition.kind === "subroutine" || definition.external !== undefined,
    };
  }
  const found = entries(graph[kind]).find((item) => item.id === id);
  if (found === undefined) return undefined;
  if (kind === "nodes") {
    const operation = object(found.operation);
    if (typeof operation.target === "string") {
      fields.push({ label: "calls", value: operation.target });
      const target = resolveCall(project, graphIdentifier, found as ProjectNode);
      if (target?.external !== undefined) {
        fields.push({
          label: "external",
          value: `${target.external.alias} / ${target.external.workflow}`,
        });
      }
    }
    return {
      fields,
      idEditable: true,
      kind: String(found.kind ?? "node"),
      name: String(found.name ?? id),
      nameEditable: true,
    };
  }
  if (kind !== "edges") {
    if (isParameterEntity(kind)) {
      return resourceDetails(kind, found, id, true, resolutionFields(project, graphIdentifier, kind, id));
    }
    if (kind === "profiles" || kind === "sessions") return resourceDetails(kind, found, id, true);
    if (kind === "features") {
      if (typeof found.kind === "string") {
        fields.push({ label: "kind", value: found.kind });
      }
      if (typeof found.description === "string") {
        fields.push({ label: "description", value: found.description });
      }
      if (Array.isArray(found.values)) {
        fields.push({ label: "values", value: found.values.map(String).join(", ") });
      }
    }
    return {
      fields,
      idEditable: true,
      kind: entityLabel(kind),
      name: String((kind === "features" ? found.label : found.name) ?? id),
      nameEditable: true,
    };
  }
  fields.push({ label: "source", value: String(found.source ?? "") });
  fields.push({ label: "target", value: String(found.target ?? "") });
  const features = entries(graph.features);
  const constraints = (["conditions", "effects"] as const).flatMap((collection) =>
    entries(found[collection]).flatMap((item): EdgeConstraint[] => {
      if (typeof item.feature_id !== "string" || typeof item.observation !== "string") return [];
      const feature = features.find((candidate) => candidate.id === item.feature_id);
      if (feature === undefined || !isFeatureKind(feature.kind)) return [];
      const identifier = featureId(item.feature_id);
      return [{
        collection,
        expression: constraintNotation(
          collection,
          identifier,
          feature.kind,
          item.observation,
          typeof item.value === "string" ? item.value : undefined,
        ),
        feature: identifier,
      }];
    })
  );
  return {
    constraints,
    fields,
    idEditable: false,
    kind: "edge",
    name: String(found.name ?? id),
    nameEditable: true,
  };
}

const PROPERTY_TITLES: Record<Entity, string> = {
  edges: "Edge",
  features: "Feature",
  nodes: "Node",
  profile_parameters: "Profile",
  profiles: "Profile",
  session_parameters: "Session",
  sessions: "Session",
  subroutines: "Subroutine Definition",
  workflows: "Workflow Definition",
};

/** One serializable entity page, projected from the current canvas state. */
export function entityPropertyPage(
  snapshot: ProjectSnapshot,
  current: SubroutineGraph,
  inspection: NavigationInspection,
  context: string,
  selection?: CanvasSelection,
): PropertyNavigationPage | undefined {
  const workflowScope = current.scope.kind === "workflow" &&
      inspection.workflow === current.scope.definition
    ? current.scope
    : undefined;
  const workflowResource = workflowScope !== undefined &&
    (inspection.entity === "profiles" || inspection.entity === "sessions");
  const workflowCall = workflowScope !== undefined &&
    inspection.entity === "workflows" &&
    selection?.entity === "nodes" &&
    selection.id === "subroutine";
  const details = workflowScope !== undefined &&
      (inspection.entity === "profiles" || inspection.entity === "sessions")
    ? workflowResourceDetails(workflowScope.workflow, inspection.entity, inspection.id)
    : (() => {
        const at = projectIn(snapshot, inspection.subroutine);
        return entityDetails(at.project, at.id, inspection.entity, inspection.id);
      })();
  if (details === undefined) return undefined;

  const resources = workflowScope !== undefined && inspection.entity === "workflows"
    ? workflowResourceFields(workflowScope.target, workflowScope.workflow)
    : inspection.entity === "nodes"
      ? nodeResourceFields(snapshot, inspection.subroutine, inspection.id)
      : undefined;
  const documentOwner = workflowResource ? current.id : inspection.subroutine;
  const documentRefs = inspection.entity === "subroutines" || inspection.entity === "workflows"
    ? undefined
    : snapshot.entity_documents[inspection.entity][documentOwner]?.[inspection.id];
  const documents = inspection.entity === "subroutines" || inspection.entity === "workflows"
    ? snapshotDefinitions(snapshot).find((definition) =>
        definition.kind === DEFINITION_KIND[inspection.entity] &&
        definition.id === inspection.id &&
        definition.ownerGraph === inspection.subroutine
      )?.documents ?? []
    : (() => {
        const own = [
          ...documentsOf(documentRefs, inspection.entity),
          ...(inspection.entity === "edges" ? visitDocumentsOf(documentRefs) : []),
        ];
        if (inspection.entity !== "nodes") return own;
        const calledImplementation = current.nodes.find(
          ({ id }) => id === inspection.id,
        )?.data.implementation;
        const visits = current.edges
          .filter((edge) => edge.target === inspection.id)
          .flatMap((edge) =>
            visitDocumentsOf(
              snapshot.entity_documents.edges[inspection.subroutine]?.[edge.id],
            ).map((document) => ({
              ...document,
              label: `visit_${edge.id} ${document.label}`,
            }))
          );
        return [
          ...own,
          ...(calledImplementation === undefined
            ? []
            : [{ label: "called implementation", path: calledImplementation }]),
          ...visits,
        ].sort((left, right) => left.label.localeCompare(right.label));
      })();
  const title = workflowCall
    ? "Subroutine Call"
    : inspection.entity === "nodes"
    ? details.kind === "subroutine_call"
      ? "Subroutine Call"
      : details.kind === "workflow_call"
        ? "Workflow Call"
        : "Node"
    : PROPERTY_TITLES[inspection.entity];
  const callNode = current.nodes.find(({ id }) =>
    id === (workflowCall ? selection.id : inspection.entity === "nodes" ? inspection.id : undefined)
  );
  const callTarget = callNode !== undefined &&
      (callNode.data.kind === "subroutine_call" || callNode.data.kind === "workflow_call")
    ? calledDefinitionEntry(snapshot, current, callNode)
    : undefined;
  const callEntries = callTarget === undefined
    ? undefined
    : (() => {
        const { removal: _removal, ...entry } = callTarget;
        return [{ ...entry, children: [], meta: ["target", ...entry.meta], scope: [] }];
      })();

  return {
    category: "entity",
    constraintsWritable: snapshot.editable && inspection.entity === "edges",
    context,
    documents,
    entity: inspection.entity,
    entries: callEntries ??
      (workflowCall
        ? []
        : isParameterEntity(inspection.entity)
          ? resolvedBindingEntries(snapshot, inspection)
          : definitionComponentEntries(snapshot, current, inspection)),
    ...(details.constraints === undefined
      ? {}
      : { constraints: details.constraints }),
    fields: workflowCall
      ? details.fields.map((field) => field.label === "subroutine"
          ? { ...field, label: "calls" }
          : field)
      : details.fields,
    id: workflowCall ? selection.id : inspection.id,
    idWritable: !workflowCall && snapshot.editable && details.idEditable,
    kind: workflowCall ? "subroutine_call" : details.kind,
    name: workflowCall ? workflowScope.target.name : details.name,
    nameWritable: !workflowCall && snapshot.editable && details.nameEditable,
    ...(details.persistent === undefined ? {} : { persistent: details.persistent }),
    ...(details.profile === undefined ? {} : { profile: details.profile }),
    resources: resources ?? [],
    resourcesWritable: snapshot.editable && resources !== undefined,
    settingsWritable: snapshot.editable &&
      (details.profile !== undefined || details.persistent !== undefined),
    title,
    ...(!workflowCall && (inspection.entity === "subroutines" || inspection.entity === "workflows")
      ? { termination: terminationNavigation(snapshot, current.id) }
      : {}),
  };
}
