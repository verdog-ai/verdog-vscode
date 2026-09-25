// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
export type CatalogueTargetFacts = {
  accessAllowsWrite: boolean;
  hasProject: boolean;
  isPreview: boolean;
  writable: boolean;
};

/** The target picker must never offer another immutable inspection checkout. */
export function catalogueTargetEligible(facts: CatalogueTargetFacts): boolean {
  return facts.hasProject && !facts.isPreview && facts.writable && facts.accessAllowsWrite;
}
