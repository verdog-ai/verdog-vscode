/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Nominal graph identifiers. JSON still carries ordinary strings. */

declare const identifierKind: unique symbol;

type Identifier<Kind extends string> = string & {
  readonly [identifierKind]?: Kind;
};

function identifier<Kind extends string>(value: string): Identifier<Kind> {
  return value;
}

export type NodeId = Identifier<'node'>;
export type EdgeId = Identifier<'edge'>;
export type FeatureId = Identifier<'feature'>;
export type GraphId = Identifier<'graph'>;
export type AgentProfileId = Identifier<'agent-profile'>;
export type AgentSessionId = Identifier<'agent-session'>;
export type QualifiedSubroutineTarget =
  Identifier<'qualified-subroutine-target'>;

export function nodeId(value: string): NodeId {
  return identifier<'node'>(value);
}
export function edgeId(value: string): EdgeId {
  return identifier<'edge'>(value);
}
export function featureId(value: string): FeatureId {
  return identifier<'feature'>(value);
}
export function graphId(value: string): GraphId {
  return identifier<'graph'>(value);
}
export function agentProfileId(value: string): AgentProfileId {
  return identifier<'agent-profile'>(value);
}
export function agentSessionId(value: string): AgentSessionId {
  return identifier<'agent-session'>(value);
}
export function qualifiedSubroutineTarget(
  value: string,
): QualifiedSubroutineTarget {
  return identifier<'qualified-subroutine-target'>(value);
}

/** Split the sole qualified call form: `<direct alias>/<subroutine>`. */
export function parseQualifiedSubroutineTarget(
  value: string,
): {alias: string; subroutine: GraphId} | undefined {
  const cut = value.indexOf('/');
  return cut < 1 || cut === value.length - 1 || value.indexOf('/', cut + 1) >= 0
    ? undefined
    : {alias: value.slice(0, cut), subroutine: graphId(value.slice(cut + 1))};
}
