import {
  agentProfileId,
  agentSessionId,
  type AgentProfileId,
  type AgentSessionId,
} from "./identifiers";
import {
  AGENT_PROVIDERS,
  type AgentInvokerOptions,
  type AgentProvider,
} from "./project";
import { entries, object } from "./reading";

export type AgentResourceOrigin = "parameter" | "local";

export type AgentProfile = {
  id: AgentProfileId;
  name: string;
  origin: AgentResourceOrigin;
  provider?: AgentProvider;
};

export type AgentSession =
  | { id: AgentSessionId; name: string; origin: "parameter" }
  | { id: AgentSessionId; name: string; origin: "local"; persistent: boolean };

export const isAgentProvider = (value: unknown): value is AgentProvider =>
  AGENT_PROVIDERS.some((provider) => provider === value);

export const defaultAgentInvokerOptions = (): AgentInvokerOptions => ({
  model: null,
  reasoning_effort: null,
  extra_args: [],
});

/** Complete profile declarations in this subroutine only; ancestor resources are not visible. */
export function agentProfiles(subroutine: unknown): AgentProfile[] {
  const graph = object(subroutine);
  return ([
    ["profile_parameters", "parameter"],
    ["profiles", "local"],
  ] as const).flatMap(([collection, origin]) =>
    entries(graph[collection]).flatMap((raw) =>
      typeof raw.id === "string" && raw.id !== "" &&
          typeof raw.name === "string" && raw.name !== ""
        ? [{
            id: agentProfileId(raw.id),
            name: raw.name,
            origin,
            ...(origin === "local" && isAgentProvider(raw.provider)
              ? { provider: raw.provider }
              : {}),
          }]
        : []
    )
  );
}

/** Complete session declarations in this subroutine only; ancestor resources are not visible. */
export function agentSessions(subroutine: unknown): AgentSession[] {
  const graph = object(subroutine);
  return ([
    ["session_parameters", "parameter"],
    ["sessions", "local"],
  ] as const).flatMap(([collection, origin]) =>
    entries(graph[collection]).flatMap<AgentSession>((raw) => {
      if (
        typeof raw.id !== "string" || raw.id === "" ||
        typeof raw.name !== "string" || raw.name === ""
      ) return [];
      if (origin === "parameter") {
        return [{ id: agentSessionId(raw.id), name: raw.name, origin }];
      }
      return typeof raw.persistent === "boolean"
        ? [{ id: agentSessionId(raw.id), name: raw.name, origin, persistent: raw.persistent }]
        : [];
    })
  );
}
