/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Versioned, platform-neutral contracts for local run history. */

import Ajv from 'ajv';

import runHistorySchema from '../schemas/run-history.schema.json';

/** The JSON Schema is the runtime authority for the editor/CLI wire contract. */
export const RUN_HISTORY_SCHEMA_VERSION: 1 = runHistorySchema.definitions
  .schemaVersion.const as 1;

export type RunStatus = 'running' | 'interrupted' | 'failed' | 'succeeded';
export type CheckpointPolicy = 'auto' | 'required' | 'off';
export type SessionPolicy = 'branch' | 'fresh';

export interface WorkflowIdentity {
  id: string;
  definition_id: string;
  module: string;
}

export interface RunParent {
  run_id: string;
  operation: 'restart' | 'fork';
  checkpoint: number | null;
  arguments: 'reused' | 'overridden' | 'checkpoint';
}

export interface RunSummary {
  id: string;
  directory_name: string;
  workflow: WorkflowIdentity;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  output_dir: string;
  launch: {
    workflow_arguments: string[];
    checkpointing: CheckpointPolicy;
  };
  parent: RunParent | null;
  checkpoints: {
    count: number;
    latest_completed: number | null;
    latest_restorable: number | null;
    resume_available: boolean;
    unavailable_code: string | null;
    unavailable_reason: string | null;
  };
  sessions: {
    persistent: number;
    model: 'copy-on-write' | 'legacy';
    branch_available: boolean;
    issues: Array<{
      address: string;
      provider: string;
      code: string;
      message: string;
    }>;
  };
}

export interface BoundarySummary {
  project_path: string;
  graph: string;
  node: string;
  visit: number;
  call_path: string;
}

export interface CheckpointSummary {
  sequence: number;
  created_at: string;
  kind: string;
  completed: BoundarySummary | null;
  next: BoundarySummary | null;
  restore_available: boolean;
  fork_with_branch_available: boolean;
  fork_with_fresh_available: boolean;
  unavailable_code: string | null;
  unavailable_reason: string | null;
}

export interface RunsEnvelope {
  schema_version: typeof RUN_HISTORY_SCHEMA_VERSION;
  operation: 'runs';
  project: string;
  runs: RunSummary[];
}

export interface CheckpointsEnvelope {
  schema_version: typeof RUN_HISTORY_SCHEMA_VERSION;
  operation: 'checkpoints';
  run: RunSummary;
  checkpoints: CheckpointSummary[];
}

export type OperationName = 'resume' | 'restart' | 'fork';

export interface OperationEnvelope {
  schema_version: typeof RUN_HISTORY_SCHEMA_VERSION;
  operation: OperationName;
  status: 'succeeded' | 'failed' | 'interrupted';
  source_run_id: string;
  source_checkpoint: number | null;
  sessions: 'restore' | SessionPolicy;
  arguments: 'checkpoint' | 'reused' | 'overridden';
  run: RunSummary;
  error?: OperationError;
}

export interface OperationError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  schema_version?: typeof RUN_HISTORY_SCHEMA_VERSION;
  operation?: string;
  status: 'error';
  error: OperationError;
}

type OperationWireEnvelope = Omit<OperationEnvelope, 'error'> & {
  error?: OperationError | null;
};
type RunHistoryEnvelope =
  RunsEnvelope | CheckpointsEnvelope | OperationWireEnvelope | ErrorEnvelope;

const validateEnvelope = new Ajv({strict: true}).compile<RunHistoryEnvelope>(
  runHistorySchema,
);

function validated(stdout: string): RunHistoryEnvelope | undefined {
  try {
    const value = JSON.parse(stdout) as unknown;
    return validateEnvelope(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

/** Invalid or unsupported CLI output is not partially accepted. */
export function parseRunsEnvelope(stdout: string): RunsEnvelope | undefined {
  const value = validated(stdout);
  if (value?.operation !== 'runs' || 'status' in value) {
    return undefined;
  }
  return unique(value.runs.map(({id}) => id)) ? value : undefined;
}

export function parseCheckpointsEnvelope(
  stdout: string,
): CheckpointsEnvelope | undefined {
  const value = validated(stdout);
  if (value?.operation !== 'checkpoints' || 'status' in value) {
    return undefined;
  }
  return unique(value.checkpoints.map(({sequence}) => sequence))
    ? value
    : undefined;
}

export function parseErrorEnvelope(stdout: string): ErrorEnvelope | undefined {
  const value = validated(stdout);
  return value !== undefined && 'status' in value && value.status === 'error'
    ? value
    : undefined;
}

export function parseOperationEnvelope(
  stdout: string,
): OperationEnvelope | undefined {
  const value = validated(stdout);
  if (value === undefined || !('status' in value) || value.status === 'error') {
    return undefined;
  }
  const {error, ...result} = value;
  return error === undefined || error === null ? result : {...result, error};
}

/** Errors for which retrying requires an explicit acknowledgement of provider side effects. */
export function isIncompleteInvocationError(
  error: OperationError | undefined,
): boolean {
  const code = error?.code ?? '';
  return (
    code === 'invocation.ambiguous' ||
    code.includes('incomplete') ||
    code.includes('confirmation_required')
  );
}

export interface RunTree {
  workflow: WorkflowIdentity;
  roots: RunBranch[];
  count: number;
}

export interface RunBranch {
  run: RunSummary;
  children: RunBranch[];
}

function newestFirst(left: RunSummary, right: RunSummary): number {
  return (
    right.updated_at.localeCompare(left.updated_at) ||
    right.id.localeCompare(left.id)
  );
}

/** Build a deterministic lineage forest without trusting malformed parent cycles. */
export function buildRunTrees(runs: readonly RunSummary[]): RunTree[] {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const existing = groups.get(run.workflow.definition_id) ?? [];
    existing.push(run);
    groups.set(run.workflow.definition_id, existing);
  }
  return [...groups.values()]
    .map((workflowRuns): RunTree => {
      workflowRuns.sort(newestFirst);
      const branches = new Map(
        workflowRuns.map(run => [run.id, {run, children: [] as RunBranch[]}]),
      );
      const roots: RunBranch[] = [];
      for (const run of workflowRuns) {
        const branch = branches.get(run.id)!;
        const parentId = run.parent?.run_id;
        const parent =
          parentId === undefined ? undefined : branches.get(parentId);
        let ancestor = parent;
        let cyclic = false;
        const seen = new Set([run.id]);
        while (ancestor !== undefined) {
          if (seen.has(ancestor.run.id)) {
            cyclic = true;
            break;
          }
          seen.add(ancestor.run.id);
          const next = ancestor.run.parent?.run_id;
          ancestor = next === undefined ? undefined : branches.get(next);
        }
        if (parent === undefined || cyclic) {
          roots.push(branch);
        } else {
          parent.children.push(branch);
        }
      }
      for (const branch of branches.values()) {
        branch.children.sort((a, b) => newestFirst(a.run, b.run));
      }
      roots.sort((a, b) => newestFirst(a.run, b.run));
      return {
        workflow: workflowRuns[0].workflow,
        roots,
        count: workflowRuns.length,
      };
    })
    .sort((left, right) => left.workflow.id.localeCompare(right.workflow.id));
}

export function boundaryLabel(boundary: BoundarySummary | null): string {
  if (boundary === null) {
    return 'workflow completion';
  }
  const call =
    boundary.call_path === '' || boundary.call_path === '.'
      ? ''
      : `${boundary.call_path}:`;
  return `${call}${boundary.graph}/${boundary.node} #${boundary.visit}`;
}

export function parseWorkflowArguments(value: string): string[] | undefined {
  try {
    const decodedArguments = JSON.parse(value) as unknown;
    return Array.isArray(decodedArguments) &&
      decodedArguments.every(item => typeof item === 'string')
      ? decodedArguments
      : undefined;
  } catch {
    return undefined;
  }
}

export function resumeCliArguments(
  runId: string,
  retryIncomplete = false,
): string[] {
  return [
    'resume',
    runId,
    '--json',
    ...(retryIncomplete ? ['--retry-incomplete'] : []),
  ];
}

export function restartCliArguments(
  runId: string,
  sessions: SessionPolicy,
  replacementArguments?: readonly string[],
): string[] {
  return [
    'restart',
    runId,
    '--sessions',
    sessions,
    '--json',
    ...(replacementArguments === undefined
      ? []
      : ['--', ...replacementArguments]),
  ];
}

export function forkCliArguments(
  runId: string,
  checkpoint: number,
  sessions: SessionPolicy,
): string[] {
  return [
    'fork',
    runId,
    '--checkpoint',
    String(checkpoint),
    '--sessions',
    sessions,
    '--json',
  ];
}
