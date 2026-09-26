/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {CatalogueInspection} from '../model/catalogue';

/** Keep the exact current inspection outcome visible beside its action. */
export function inspectionFooterText(inspection: CatalogueInspection): string {
  switch (inspection.state) {
    case 'idle':
      return 'Metadata and README only. No worktree, environment, dependency, or workflow code has been created or executed.';
    case 'ready':
      return 'Exact source and metadata verified. Import into a trusted project to install dependencies and run code.';
    case 'running':
    case 'incomplete':
    case 'mismatch':
      return inspection.detail;
    default: {
      const unsupported: never = inspection;
      throw new Error(`Unsupported inspection state: ${String(unsupported)}`);
    }
  }
}
