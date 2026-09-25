// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import type { CatalogueInspection } from "../model/catalogue";

/** Keep the exact current inspection outcome visible beside its action. */
export function inspectionFooterText(inspection: CatalogueInspection): string {
  switch (inspection.state) {
    case "idle":
      return "Metadata and README only. No worktree, environment, dependency, or workflow code has been created or executed.";
    case "ready":
      return "Source and wheel-only environment prepared in the Verdog cache. Workflow code has not been run.";
    case "running":
    case "incomplete":
    case "mismatch":
      return inspection.detail;
  }
}
