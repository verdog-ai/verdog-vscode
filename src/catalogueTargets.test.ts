import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogueTargetEligible, type CatalogueTargetFacts } from "./catalogueTargets";

const editable: CatalogueTargetFacts = {
  accessAllowsWrite: true,
  hasProject: true,
  isPreview: false,
  writable: true,
};

test("only an editable, writable, non-preview Verdog project is an import target", () => {
  assert.equal(catalogueTargetEligible(editable), true);
  for (const key of Object.keys(editable) as (keyof CatalogueTargetFacts)[]) {
    assert.equal(catalogueTargetEligible({ ...editable, [key]: !editable[key] }), false);
  }
});
