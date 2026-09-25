// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogueInspection } from "../model/catalogue";
import { inspectionFooterText } from "./catalogueInspection";

test("the catalogue footer preserves exact inspection progress and failure details", () => {
  for (const inspection of [
    { detail: "Preparing the selected workflow environment", state: "running" },
    { detail: "The CLI returned an invalid selected-workflow environment receipt.", state: "incomplete" },
    { detail: "Published metadata differs from source: workflow structure.", state: "mismatch" },
  ] satisfies CatalogueInspection[]) {
    assert.equal(inspectionFooterText(inspection), inspection.detail);
  }
});

test("the catalogue footer retains its idle and ready explanations", () => {
  assert.equal(
    inspectionFooterText({ state: "idle" }),
    "Metadata and README only. No worktree, environment, dependency, or workflow code has been created or executed.",
  );
  assert.equal(
    inspectionFooterText({ folder: "/cache/exact-release", state: "ready" }),
    "Source and wheel-only environment prepared in the Verdog cache. Workflow code has not been run.",
  );
});
