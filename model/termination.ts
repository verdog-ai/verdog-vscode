/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Advisory native analysis; separate from compiler diagnostics and execution. */
export type TerminationStatus = 'certified' | 'not_certified' | 'unavailable';
export type TerminationEdgeStatus = 'cleared' | 'remaining' | 'unreachable';

export interface TerminationCycleStep {
  node: string;
  values: string[];
  edge: string;
}

export interface TerminationWitness {
  feature: string;
  expression: string;
  edges: string[];
  opposing_edges: string[];
}

export interface TerminationRegion {
  id: string;
  nodes: string[];
  edges: string[];
  witnesses: TerminationWitness[];
  cycle: TerminationCycleStep[];
}

export interface DefinitionTermination {
  status: TerminationStatus;
  local_status: TerminationStatus;
  reason: string;
  memory_states: number;
  rules: number;
  dependencies: Array<{scope: string; node: string}>;
  edges: Record<string, TerminationEdgeStatus>;
  regions: TerminationRegion[];
}

export interface TerminationReport {
  projects: Record<string, string>;
  definitions: Record<string, DefinitionTermination>;
}

export type TerminationState =
  | {status: 'checking'}
  | {status: 'unavailable'; reason: string}
  | {status: 'ready'; report: TerminationReport};

export type DefinitionTerminationState =
  | Exclude<TerminationState, {status: 'ready'}>
  | {status: 'ready'; definition: DefinitionTermination; revision: string};

export function terminationRevision(report: TerminationReport): string {
  return JSON.stringify(
    Object.entries(report.projects).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function terminationFor(
  state: TerminationState | undefined,
  scope: string,
): DefinitionTerminationState {
  if (state === undefined) {
    return {status: 'unavailable', reason: 'Analysis has not run yet.'};
  }
  if (state.status !== 'ready') {
    return state;
  }
  const definition = state.report.definitions[scope];
  return definition === undefined
    ? {
        status: 'unavailable',
        reason: 'Analysis is unavailable for this definition.',
      }
    : {
        status: 'ready',
        definition,
        revision: terminationRevision(state.report),
      };
}

export const TERMINATION_LABEL = {
  certified: 'Certified',
  checking: 'Checking',
  not_certified: 'Not certified',
  unavailable: 'Unavailable',
} as const;

export function terminationStatus(state: DefinitionTerminationState) {
  return state.status === 'ready' ? state.definition.status : state.status;
}

export type EdgeTerminationDisplayStatus =
  TerminationEdgeStatus | 'checking' | 'unavailable';

/** Call-closure failures do not invalidate a completed local edge analysis. */
export function edgeTerminationStatus(
  state: DefinitionTerminationState | undefined,
  edge: string,
): EdgeTerminationDisplayStatus {
  if (state?.status === 'checking') {
    return 'checking';
  }
  if (
    state?.status !== 'ready' ||
    state.definition.local_status === 'unavailable'
  ) {
    return 'unavailable';
  }
  return state.definition.edges[edge] ?? 'unavailable';
}

export interface TerminationHighlight {
  scope: string;
  region: string | null;
  revision: string;
}

/** Highlights are presentation only, and never survive a change of graph or revision. */
export function highlightedTerminationRegion(
  state: TerminationState | undefined,
  scope: string,
  highlight: TerminationHighlight | undefined,
): TerminationRegion | undefined {
  if (
    state?.status !== 'ready' ||
    highlight?.scope !== scope ||
    highlight.revision !== terminationRevision(state.report)
  ) {
    return undefined;
  }
  return state.report.definitions[scope]?.regions.find(
    ({id}) => id === highlight.region,
  );
}
