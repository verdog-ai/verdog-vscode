/** Where a profile or session parameter ends up: the concrete resources bound to it. */

import type { AgentProfileId, AgentSessionId, GraphId } from "./identifiers";
import { isAgentProvider } from "./agents";
import {
  definitionIndex,
  resolveCall,
  type AgentInvokerOptions,
  type AgentProvider,
  type SubroutineDefinition,
} from "./project";
import { entries, object } from "./reading";

export type ResourceKind = "profile" | "session";

/** The definition that declares a concrete profile or session. */
export type BindingOwner =
  | { kind: "workflow"; id: GraphId; declaredIn?: GraphId }
  | { kind: "subroutine"; id: GraphId };

export type ResolvedBinding = {
  /** The concrete resource's identifier in its owner. */
  id: string;
  owner: BindingOwner;
  /** Persistence, for a session. */
  persistent?: boolean;
  /** Provider settings, for a profile. */
  profile?: { options: AgentInvokerOptions; provider: AgentProvider };
  resource: ResourceKind;
};

const COLLECTIONS = {
  profile: { arguments: "profile_arguments", locals: "profiles", parameters: "profile_parameters" },
  session: { arguments: "session_arguments", locals: "sessions", parameters: "session_parameters" },
} as const;

const concrete = (
  resource: ResourceKind,
  owner: BindingOwner,
  raw: Record<string, unknown>,
): ResolvedBinding => {
  const id = String(raw.id);
  if (resource === "session") {
    return {
      id,
      owner,
      resource,
      ...(typeof raw.persistent === "boolean" ? { persistent: raw.persistent } : {}),
    };
  }
  const options = object(raw.options);
  return {
    id,
    owner,
    resource,
    ...(isAgentProvider(raw.provider)
      ? {
          profile: {
            provider: raw.provider,
            options: {
              model: typeof options.model === "string" ? options.model : null,
              reasoning_effort: typeof options.reasoning_effort === "string"
                ? options.reasoning_effort
                : null,
              extra_args: Array.isArray(options.extra_args)
                ? options.extra_args.map(String)
                : [],
              ...(options.web_search === true ? { web_search: true } : {}),
            },
          },
        }
      : {}),
  };
};

const declares = (graph: SubroutineDefinition | undefined, collection: string, id: string): boolean =>
  entries(object(graph)[collection]).some((item) => item.id === id);

/**
 * Every concrete resource a parameter resolves to through the call paths inside this project.
 *
 * A workflow entry binds the parameter to one of the workflow's own resources. A subroutine
 * call binds it to the caller's local resource, or passes one of the caller's own parameters
 * on, in which case resolution continues at that parameter. Callers outside this project are
 * not visible, so a parameter bound only by them resolves to nothing.
 */
export function resolveParameter(
  project: unknown,
  graph: GraphId,
  resource: ResourceKind,
  parameter: AgentProfileId | AgentSessionId | string,
  index = definitionIndex(project),
): ResolvedBinding[] {
  const names = COLLECTIONS[resource];
  const found: ResolvedBinding[] = [];
  const visited = new Set<string>();
  const add = (binding: ResolvedBinding) => {
    if (!found.some((item) =>
      item.owner.kind === binding.owner.kind && item.owner.id === binding.owner.id && item.id === binding.id
    )) found.push(binding);
  };
  const resolve = (target: GraphId, id: string) => {
    if (!visited.add(`${target}\0${id}`)) return;
    for (const definition of index.definitions.values()) {
      if (definition.kind !== "workflow" || definition.workflow === undefined || definition.target !== target) continue;
      const bound = object(definition.workflow[names.arguments])[id];
      if (typeof bound !== "string") continue;
      const raw = entries(definition.workflow[names.locals]).find((item) => item.id === bound);
      if (raw !== undefined) {
        add(concrete(resource, {
          kind: "workflow",
          id: definition.id,
          ...(definition.declaredIn === undefined ? {} : { declaredIn: definition.declaredIn }),
        }, raw));
      }
    }
    for (const [callerId, caller] of index.subroutines) {
      for (const node of entries(caller.nodes)) {
        if (node.kind !== "subroutine_call") continue;
        const operation = object(node.operation);
        const called = resolveCall(project, callerId, { kind: "subroutine_call", operation }, index);
        if (called?.id !== target) continue;
        const bound = object(operation[names.arguments])[id];
        if (typeof bound !== "string") continue;
        const local = entries(caller[names.locals]).find((item) => item.id === bound);
        if (local !== undefined) {
          add(concrete(resource, { kind: "subroutine", id: callerId }, local));
        } else if (declares(caller, names.parameters, bound)) {
          resolve(callerId, bound);
        }
      }
    }
  };
  resolve(graph, String(parameter));
  return found;
}

/** One line a person can read: what the bound resource is configured as. */
export function bindingSummary(binding: ResolvedBinding): string {
  const where = `${binding.owner.kind} ${binding.owner.id} → ${binding.id}`;
  if (binding.resource === "session") {
    return binding.persistent === undefined
      ? where
      : `${where} (${binding.persistent ? "persistent" : "fresh"})`;
  }
  if (binding.profile === undefined) return where;
  const { provider, options } = binding.profile;
  const settings = [
    provider,
    options.model ?? undefined,
    options.reasoning_effort ?? undefined,
    options.web_search === true ? "web search" : undefined,
  ].filter((item): item is string => item !== undefined);
  return `${where} (${settings.join(" · ")})`;
}
