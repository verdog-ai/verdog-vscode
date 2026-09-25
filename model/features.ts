/** The feature vocabulary shared by authoring, snapshots, and the canvas. */

import type { FeatureId } from "./identifiers";

export const FEATURE_KINDS = ["integer", "boolean", "float", "enum"] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export const FEATURE_KIND_DESCRIPTIONS = {
  boolean: "a flag updated by feature nodes",
  enum: "one value from a declared finite set",
  float: "a quantity with a fractional part",
  integer:
    "a non-negative count; a verified decrease can prove a loop terminates",
} as const satisfies Record<FeatureKind, string>;

/** What feature pickers and references need from a declaration. */
type FeatureBase = {
  id: FeatureId;
  label: string;
};

export type Feature =
  | (FeatureBase & { kind: Exclude<FeatureKind, "enum">; values?: never })
  | (FeatureBase & { kind: "enum"; values: readonly string[] });

/** The complete feature stored in a subroutine. */
export type FeatureDefinition = Feature & {
  description: string;
};

export const isFeatureKind = (value: unknown): value is FeatureKind =>
  typeof value === "string" && FEATURE_KINDS.some((kind) => kind === value);

export const CONDITIONS = {
  boolean: ["positive", "negative"],
  enum: ["equal"],
  float: ["equal_zero", "greater_zero"],
  integer: ["equal_zero", "greater_zero"],
} as const satisfies Record<FeatureKind, readonly string[]>;

export const EFFECTS = {
  boolean: ["positive", "negative", "unchanged", "unconstrained"],
  enum: ["equal", "unconstrained"],
  float: ["increases", "decreases", "unchanged", "unconstrained"],
  integer: ["increases", "decreases", "unchanged", "unconstrained"],
} as const satisfies Record<FeatureKind, readonly string[]>;

const OBSERVATIONS = { conditions: CONDITIONS, effects: EFFECTS } as const;
export type ObservationCollection = keyof typeof OBSERVATIONS;
export type Observation =
  (typeof OBSERVATIONS)[ObservationCollection][FeatureKind][number];

export function observationsFor(
  collection: ObservationCollection,
  kind?: FeatureKind,
): readonly Observation[] {
  const table = OBSERVATIONS[collection];
  return kind === undefined ? [...new Set(Object.values(table).flat())] : table[kind];
}

export const EXPLANATIONS: Readonly<Record<string, string>> = {
  decreases:
    "The candidate value is lower than the pre-node value. On a bounded feature, this can prove a loop terminates.",
  equal: "The enum has the selected value.",
  equal_zero: "The feature is exactly zero.",
  greater_zero: "The feature is above zero \u2014 the usual guard on a countdown.",
  increases: "The candidate value is higher than the pre-node value.",
  negative: "The flag is false.",
  positive: "The flag is true.",
  unchanged:
    "The candidate equals the pre-node value. Stronger than `unconstrained`: it is a promise.",
  unconstrained:
    "Nothing is claimed. Costs you any termination proof that depended on this feature.",
} satisfies Record<Observation, string>;
