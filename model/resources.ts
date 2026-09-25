// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Resource contracts shared by entity property pages and the mutation boundary. */

import { agentProfiles, agentSessions, type AgentSession } from "./agents";
import {
  agentProfileId,
  agentSessionId,
  type AgentProfileId,
  type AgentSessionId,
} from "./identifiers";
import type {
  LocalWorkflowDefinition,
  SubroutineCallArguments,
  SubroutineDefinition,
} from "./project";
import {
  subroutineCallTarget,
  subroutineIn,
  type ProjectGraphs,
} from "./snapshot";
import { entries, object, text } from "./reading";

export type ResourceField = {
  label: string;
  options: string[];
  parameter?: string;
  resource: "profile" | "session";
  value: string;
};

export type ResourceSelection = Pick<ResourceField, "parameter" | "resource" | "value">;

export type NodeResourceUpdate =
  | { kind: "agent"; profile: AgentProfileId; session: AgentSessionId }
  | { arguments: SubroutineCallArguments; kind: "subroutine_call" };

const resourceKey = (field: Pick<ResourceField, "parameter" | "resource">): string =>
  `${field.resource}:${field.parameter ?? ""}`;

const callResourceFields = (
  target: SubroutineDefinition | undefined,
  arguments_: SubroutineCallArguments,
  profiles: readonly string[],
  sessions: readonly AgentSession[],
): ResourceField[] => {
  if (target === undefined) {
    return [
      ...Object.entries(object(arguments_.profile_arguments)).sort().map(([parameter, value]) => ({
        label: `profile ${parameter}`,
        options: [],
        parameter,
        resource: "profile" as const,
        value: text(value),
      })),
      ...Object.entries(object(arguments_.session_arguments)).sort().map(([parameter, value]) => ({
        label: `session ${parameter}`,
        options: [],
        parameter,
        resource: "session" as const,
        value: text(value),
      })),
    ];
  }
  return [
    ...entries(target.profile_parameters).filter((parameter) => text(parameter.id)).map((parameter) => ({
      label: `profile ${parameter.id}`,
      options: [...profiles],
      parameter: text(parameter.id),
      resource: "profile" as const,
      value: text(object(arguments_.profile_arguments)[text(parameter.id)]),
    })),
    ...entries(target.session_parameters).filter((parameter) => text(parameter.id)).map((parameter) => ({
      label: `session ${parameter.id}`,
      options: sessions.map(({ id }) => id),
      parameter: text(parameter.id),
      resource: "session" as const,
      value: text(object(arguments_.session_arguments)[text(parameter.id)]),
    })),
  ];
};

/** Resources explicitly owned by a workflow boundary. */
export function workflowBoundaryResources(
  workflow: LocalWorkflowDefinition,
): { profiles: string[]; sessions: AgentSession[] } {
  return {
    profiles: agentProfiles(workflow).map(({ id }) => id),
    sessions: agentSessions(workflow),
  };
}

/** Resource selectors for a workflow boundary's sole subroutine call. */
export function workflowResourceFields(
  target: SubroutineDefinition,
  workflow: LocalWorkflowDefinition,
): ResourceField[] {
  const boundary = workflowBoundaryResources(workflow);
  return callResourceFields(target, workflow, boundary.profiles, boundary.sessions);
}

/** Resource selectors for an agent or bindings passed into an in-process call. */
export function nodeResourceFields(
  snapshot: ProjectGraphs,
  subroutineId: string,
  id: string,
): ResourceField[] {
  const graph = subroutineIn(snapshot, subroutineId);
  const node = Array.isArray(graph?.nodes)
    ? graph.nodes.find((candidate) => candidate?.id === id)
    : undefined;
  if (node?.kind === "agent") {
    return [
      {
        label: "profile",
        options: agentProfiles(graph).map(({ id }) => id),
        resource: "profile",
        value: node.operation?.profile ?? "",
      },
      {
        label: "session",
        options: agentSessions(graph).map(({ id }) => id),
        resource: "session",
        value: node.operation?.session ?? "",
      },
    ];
  }
  if (node?.kind !== "subroutine_call") return [];
  const target = subroutineCallTarget(snapshot, subroutineId, node.operation?.target ?? "");
  const profiles = agentProfiles(graph).map(({ id }) => id);
  const sessions = agentSessions(graph);
  return callResourceFields(target, node.operation ?? { profile_arguments: {}, session_arguments: {} }, profiles, sessions);
}

function normalizedSelections(
  fields: readonly ResourceField[],
  submitted: readonly ResourceSelection[],
): Map<string, ResourceSelection> {
  const expected = new Map(fields.map((field) => [resourceKey(field), field]));
  if (expected.size !== fields.length) throw new Error("this node has duplicate resource fields");

  const selected = new Map<string, ResourceSelection>();
  for (const resource of submitted) {
    const key = resourceKey(resource);
    if (selected.has(key)) throw new Error(`resource ${key} was submitted more than once`);
    const field = expected.get(key);
    if (field === undefined) throw new Error(`resource ${key} is not required by this node`);
    if (!field.options.includes(resource.value)) {
      throw new Error(`${resource.value} is not valid for resource ${key}`);
    }
    selected.set(key, resource);
  }
  if (selected.size !== expected.size) throw new Error("not every required resource was submitted");
  return selected;
}

function callArguments(selected: ReadonlyMap<string, ResourceSelection>): SubroutineCallArguments {
  const arguments_: SubroutineCallArguments = { profile_arguments: {}, session_arguments: {} };
  for (const resource of selected.values()) {
    if (resource.parameter === undefined) throw new Error("a call binding needs a parameter");
    if (resource.resource === "profile") {
      arguments_.profile_arguments[agentProfileId(resource.parameter)] =
        agentProfileId(resource.value);
    } else {
      arguments_.session_arguments[agentSessionId(resource.parameter)] =
        agentSessionId(resource.value);
    }
  }
  return arguments_;
}

/** Validate one complete update to a workflow boundary. */
export function normalizeWorkflowResources(
  target: SubroutineDefinition,
  workflow: LocalWorkflowDefinition,
  submitted: readonly ResourceSelection[],
): SubroutineCallArguments {
  return callArguments(normalizedSelections(workflowResourceFields(target, workflow), submitted));
}

/** Validate and normalize one complete atomic resource update. */
export function normalizeNodeResources(
  snapshot: ProjectGraphs,
  subroutineId: string,
  id: string,
  submitted: readonly ResourceSelection[],
): NodeResourceUpdate {
  const graph = subroutineIn(snapshot, subroutineId);
  const node = Array.isArray(graph?.nodes)
    ? graph.nodes.find((candidate) => candidate?.id === id)
    : undefined;
  if (node?.kind !== "agent" && node?.kind !== "subroutine_call") {
    throw new Error(`${id} does not have resource bindings`);
  }
  const fields = nodeResourceFields(snapshot, subroutineId, id);
  const selected = normalizedSelections(fields, submitted);

  if (node?.kind === "agent") {
    return {
      kind: "agent",
      profile: agentProfileId(selected.get("profile:")!.value),
      session: agentSessionId(selected.get("session:")!.value),
    };
  }
  return { arguments: callArguments(selected), kind: "subroutine_call" };
}
