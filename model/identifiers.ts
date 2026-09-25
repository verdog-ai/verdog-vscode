// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Nominal graph identifiers. JSON still carries ordinary strings. */

declare const identifierKind: unique symbol;

type Identifier<Kind extends string> = string & {
  readonly [identifierKind]?: Kind;
};

const identifier = <Kind extends string>(value: string): Identifier<Kind> =>
  value as Identifier<Kind>;

export type NodeId = Identifier<"node">;
export type EdgeId = Identifier<"edge">;
export type FeatureId = Identifier<"feature">;
export type GraphId = Identifier<"graph">;
export type AgentProfileId = Identifier<"agent-profile">;
export type AgentSessionId = Identifier<"agent-session">;
export type QualifiedSubroutineTarget = Identifier<"qualified-subroutine-target">;

export const nodeId = (value: string): NodeId => identifier<"node">(value);
export const edgeId = (value: string): EdgeId => identifier<"edge">(value);
export const featureId = (value: string): FeatureId => identifier<"feature">(value);
export const graphId = (value: string): GraphId => identifier<"graph">(value);
export const agentProfileId = (value: string): AgentProfileId =>
  identifier<"agent-profile">(value);
export const agentSessionId = (value: string): AgentSessionId =>
  identifier<"agent-session">(value);
export const qualifiedSubroutineTarget = (value: string): QualifiedSubroutineTarget =>
  identifier<"qualified-subroutine-target">(value);

/** Split the sole qualified call form: `<direct alias>/<subroutine>`. */
export function parseQualifiedSubroutineTarget(
  value: string,
): { alias: string; subroutine: GraphId } | undefined {
  const cut = value.indexOf("/");
  return cut < 1 || cut === value.length - 1 || value.indexOf("/", cut + 1) >= 0
    ? undefined
    : { alias: value.slice(0, cut), subroutine: graphId(value.slice(cut + 1)) };
}
