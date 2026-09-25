// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import type {
  AgentProfileId,
  AgentSessionId,
  EdgeId,
  NodeId,
} from "./identifiers";
import type { ProjectNode } from "./project";

const acceptsNode = (_id: NodeId): void => undefined;
const acceptsProfile = (_id: AgentProfileId): void => undefined;

declare const edge: EdgeId;
declare const session: AgentSessionId;

acceptsNode("node_from_json");

// @ts-expect-error An edge identifier cannot stand in for a node identifier.
acceptsNode(edge);
// @ts-expect-error A session identifier cannot stand in for a profile identifier.
acceptsProfile(session);

// @ts-expect-error A schema-valid agent operation must select a session as well as a profile.
const missingSession: ProjectNode = {
  id: "agent",
  kind: "agent",
  name: "Agent",
  operation: { profile: "default" },
};
void missingSession;
