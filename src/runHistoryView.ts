/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as vscode from 'vscode';
import * as path from 'node:path';

import {RunTrace} from './runTrace';

import type {Outcome} from './cli';
import type {HostState} from './projectHost';
import {runVerdogCommand} from './verdogCommand';
import {
  boundaryLabel,
  buildRunTrees,
  forkCliArguments,
  isIncompleteInvocationError,
  parseCheckpointsEnvelope,
  parseErrorEnvelope,
  parseOperationEnvelope,
  parseBriefRunsEnvelope,
  parseWorkflowArguments,
  restartCliArguments,
  resumeCliArguments,
  type CheckpointSummary,
  type ErrorEnvelope,
  type OperationEnvelope,
  type RunBranch,
  type RunHeader,
  type SessionPolicy,
} from './runHistory';

type WorkflowTreeItem = vscode.TreeItem & {
  readonly kind: 'workflow';
  readonly children: RunTreeItem[];
};

type RunTreeItem = vscode.TreeItem & {
  readonly kind: 'run';
  readonly run: RunHeader;
  readonly children: RunTreeItem[];
};

type HistoryTreeItem = WorkflowTreeItem | RunTreeItem;

export interface RunCommandRequest {
  run?: string;
  sessions?: SessionPolicy;
  checkpoint?: number | 'latest';
  arguments?: string[];
  retryIncomplete?: boolean;
}

interface OperationResult {
  outcome: Outcome;
  operation?: OperationEnvelope;
  error?: ErrorEnvelope;
}

function statusIcon(status: RunHeader['status']): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('loading~spin');
    case 'interrupted':
      return new vscode.ThemeIcon('debug-pause');
    case 'failed':
      return new vscode.ThemeIcon(
        'error',
        new vscode.ThemeColor('testing.iconFailed'),
      );
    case 'succeeded':
      return new vscode.ThemeIcon(
        'pass-filled',
        new vscode.ThemeColor('testing.iconPassed'),
      );
    default: {
      const unsupported: never = status;
      throw new Error(`Unsupported run status: ${String(unsupported)}`);
    }
  }
}

function shownArguments(args: readonly string[]): string {
  return args.length === 0 ? '[]' : JSON.stringify(args);
}

function runTooltip(run: RunHeader): string {
  const parent =
    run.parent === null
      ? 'none'
      : `${run.parent.operation} of ${run.parent.run_id}` +
        (run.parent.checkpoint === null
          ? ''
          : ` at checkpoint ${run.parent.checkpoint}`);
  return [
    `Workflow: ${run.workflow.id}`,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Updated: ${run.updated_at}`,
    `Parent: ${parent}`,
    'Checkpoint details are loaded when resuming or forking.',
    `Arguments: ${shownArguments(run.launch.workflow_arguments)}`,
    `Output: ${run.output_dir}`,
  ].join('\n');
}

function makeRunItem(
  branch: RunBranch,
  activity: ReadonlyMap<string, string>,
): RunTreeItem {
  const children = branch.children.map(child => makeRunItem(child, activity));
  const item = new vscode.TreeItem(
    branch.run.directory_name,
    children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  ) as RunTreeItem;
  Object.defineProperties(item, {
    kind: {value: 'run', enumerable: true},
    run: {value: branch.run, enumerable: true},
    children: {value: children, enumerable: true},
  });
  item.description = branch.run.status;
  const latest = activity.get(branch.run.output_dir);
  item.tooltip =
    runTooltip(branch.run) +
    (latest === undefined ? '' : `\nLatest activity: ${latest}`);
  item.iconPath = statusIcon(branch.run.status);
  item.contextValue = [
    'verdogRun',
    ...(branch.run.status !== 'succeeded' &&
    branch.run.status !== 'running' &&
    branch.run.launch.checkpointing !== 'off'
      ? ['resume']
      : []),
    ...(branch.run.launch.checkpointing !== 'off' ? ['fork'] : []),
  ].join('.');
  item.command = {
    command: 'verdog.openRunOutput',
    title: 'Open Run Output',
    arguments: [item],
  };
  item.accessibilityInformation = {
    label: `${branch.run.workflow.id} run ${branch.run.directory_name}, ${branch.run.status}`,
  };
  return item;
}

function makeWorkflowItem(
  workflow: ReturnType<typeof buildRunTrees>[number],
  activity: ReadonlyMap<string, string>,
): WorkflowTreeItem {
  const children = workflow.roots.map(branch => makeRunItem(branch, activity));
  const item = new vscode.TreeItem(
    workflow.workflow.id,
    vscode.TreeItemCollapsibleState.Expanded,
  ) as WorkflowTreeItem;
  Object.defineProperties(item, {
    kind: {value: 'workflow', enumerable: true},
    children: {value: children, enumerable: true},
  });
  item.description = `${workflow.count} run${workflow.count === 1 ? '' : 's'}`;
  item.tooltip = `${workflow.workflow.definition_id}\n${workflow.workflow.module}`;
  item.iconPath = new vscode.ThemeIcon('workflow');
  item.contextValue = 'verdogWorkflow';
  return item;
}

function commandRequest(value: unknown): RunCommandRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'run') {
    return undefined;
  }
  const run = typeof candidate.run === 'string' ? candidate.run : undefined;
  const sessions =
    candidate.sessions === 'branch' || candidate.sessions === 'fresh'
      ? candidate.sessions
      : undefined;
  const checkpoint =
    candidate.checkpoint === 'latest' ||
    (Number.isSafeInteger(candidate.checkpoint) &&
      (candidate.checkpoint as number) > 0)
      ? (candidate.checkpoint as number | 'latest')
      : undefined;
  const args =
    Array.isArray(candidate.arguments) &&
    candidate.arguments.every(item => typeof item === 'string')
      ? candidate.arguments
      : undefined;
  return {
    ...(run === undefined ? {} : {run}),
    ...(sessions === undefined ? {} : {sessions}),
    ...(checkpoint === undefined ? {} : {checkpoint}),
    ...(args === undefined ? {} : {arguments: args}),
    ...(candidate.retryIncomplete === true ? {retryIncomplete: true} : {}),
  };
}

function isRunItem(value: unknown): value is RunTreeItem {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as {kind?: unknown}).kind === 'run' &&
    (value as {run?: unknown}).run !== undefined
  );
}

function referencedRun(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isRunItem(value)) {
    return value.run.id;
  }
  return commandRequest(value)?.run;
}

class RunHistoryProvider
  implements vscode.TreeDataProvider<HistoryTreeItem>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    HistoryTreeItem | undefined | void
  >();
  private items: WorkflowTreeItem[] = [];
  private runs: RunHeader[] = [];
  private initialized = false;
  private refreshInFlight: Promise<void> | undefined;
  private refreshAbort: AbortController | undefined;
  private view: vscode.TreeView<HistoryTreeItem> | undefined;
  private disposed = false;
  private revision = 0;
  private monitoringSupported = true;
  private pendingRefresh = false;
  private readonly pendingOutputs = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private registryWatcher: vscode.FileSystemWatcher | undefined;
  private readonly runWatchers = new Map<string, vscode.Disposable[]>();
  private readonly traces = new Map<string, RunTrace>();
  private readonly activity = new Map<string, string>();
  private readonly pendingTraces = new Set<string>();
  private traceRead: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private traceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: HostState) {}

  attach(view: vscode.TreeView<HistoryTreeItem>): void {
    this.view = view;
    this.subscriptions.push(
      view.onDidChangeVisibility(() => this.visibilityChanged()),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused && this.canMonitor()) {
          void this.refresh(false);
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.visibilityChanged()),
    );
    this.visibilityChanged();
  }

  private canRead(): boolean {
    return (
      !this.disposed &&
      this.host.root !== undefined &&
      this.host.preview === undefined &&
      vscode.workspace.isTrusted
    );
  }

  private canMonitor(): boolean {
    return this.canRead() && this.view?.visible === true;
  }

  private visibilityChanged(): void {
    ++this.revision;
    this.refreshAbort?.abort();
    this.stopWatching();
    if (this.canMonitor()) {
      this.registryWatcher = this.watch(
        path.join(this.host.root!, '.verdog'),
        'run-registry.json',
        () => this.scheduleRefresh(),
      );
      void this.refresh(false);
    }
  }

  private stopWatching(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.traceTimer);
    clearTimeout(this.pollTimer);
    this.refreshTimer = undefined;
    this.traceTimer = undefined;
    this.pollTimer = undefined;
    this.traces.clear();
    this.pendingRefresh = false;
    this.pendingOutputs.clear();
    this.pendingTraces.clear();
    this.registryWatcher?.dispose();
    this.registryWatcher = undefined;
    for (const watchers of this.runWatchers.values()) {
      watchers.forEach(watcher => watcher.dispose());
    }
    this.runWatchers.clear();
  }

  dispose(): void {
    this.disposed = true;
    ++this.revision;
    this.refreshAbort?.abort();
    this.stopWatching();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.changed.dispose();
  }

  getTreeItem(item: HistoryTreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: HistoryTreeItem): Promise<HistoryTreeItem[]> {
    if (!this.initialized) {
      await (this.refreshInFlight ?? this.refresh(false));
    }
    return item === undefined ? this.items : item.children;
  }

  private publish(): void {
    this.items = buildRunTrees(this.runs).map(workflow =>
      makeWorkflowItem(workflow, this.activity),
    );
    this.changed.fire();
  }

  private watch(
    directory: string,
    filename: string,
    changed: () => void,
  ): vscode.FileSystemWatcher {
    // No slash or ** in the pattern: excluded generated directories need only
    // an exact, nonrecursive parent watch, never an artifact-tree watch.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directory, filename),
    );
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    return watcher;
  }

  private syncRunWatchers(): void {
    if (!this.canMonitor()) {
      return;
    }
    const outputs = new Set(this.runs.map(run => run.output_dir));
    for (const [output, watchers] of this.runWatchers) {
      if (!outputs.has(output)) {
        watchers.forEach(watcher => watcher.dispose());
        this.runWatchers.delete(output);
        this.traces.delete(output);
        this.activity.delete(output);
      }
    }
    for (const output of outputs) {
      if (this.runWatchers.has(output)) {
        continue;
      }
      this.runWatchers.set(output, [
        this.watch(output, '{trace,trace.log}', () =>
          this.scheduleTrace(output),
        ),
        this.watch(path.join(output, '.verdog'), 'run.json', () =>
          this.scheduleRefresh(output),
        ),
      ]);
      this.scheduleTrace(output);
    }
  }

  private scheduleRefresh(output?: string): void {
    if (!this.canMonitor() || !this.monitoringSupported) {
      return;
    }
    if (output === undefined) {
      this.pendingRefresh = true;
    } else {
      this.pendingOutputs.add(output);
    }
    // A fixed debounce deadline cannot be postponed forever by a busy run.
    if (this.refreshTimer === undefined) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        if (this.canMonitor()) {
          void this.refresh(
            false,
            this.pendingRefresh ? undefined : [...this.pendingOutputs],
          );
        }
      }, 250);
    }
  }

  private scheduleTrace(output: string): void {
    if (!this.canMonitor()) {
      return;
    }
    this.pendingTraces.add(output);
    if (this.traceTimer === undefined) {
      this.traceTimer = setTimeout(() => {
        this.traceTimer = undefined;
        void this.readTraces();
      }, 250);
    }
  }

  private async readTraces(): Promise<void> {
    if (this.traceRead !== undefined) {
      return this.traceRead;
    }
    const revision = this.revision;
    const read = async () => {
      while (
        this.canMonitor() &&
        revision === this.revision &&
        this.pendingTraces.size > 0
      ) {
        const outputs = [...this.pendingTraces];
        this.pendingTraces.clear();
        for (const output of outputs) {
          const trace = this.traces.get(output) ?? new RunTrace(output);
          this.traces.set(output, trace);
          try {
            const line = await trace.read();
            if (
              !this.canMonitor() ||
              revision !== this.revision ||
              !this.runWatchers.has(output)
            ) {
              return;
            }
            // Registration precedes lease acquisition. The first trace line
            // may be our first observation after that run actually starts.
            if (
              line !== undefined &&
              line !== this.activity.get(output) &&
              this.runs.some(
                run =>
                  run.output_dir === output && run.status === 'interrupted',
              )
            ) {
              this.scheduleRefresh(output);
            }
            if (line === undefined) {
              this.activity.delete(output);
            } else {
              this.activity.set(output, line);
            }
          } catch (error) {
            this.host.output.appendLine(
              `reading run trace failed: ${String(error)}`,
            );
          }
        }
        if (this.canMonitor() && revision === this.revision) {
          this.publish();
        }
      }
    };
    this.traceRead = read().finally(() => {
      this.traceRead = undefined;
      if (this.canMonitor() && this.pendingTraces.size > 0) {
        this.scheduleTrace(this.pendingTraces.values().next().value!);
      }
    });
    return this.traceRead;
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (
      !this.canMonitor() ||
      !this.monitoringSupported ||
      !this.runs.some(run => run.status === 'running')
    ) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.canMonitor()) {
        const outputs = this.runs
          .filter(run => run.status === 'running')
          .map(run => run.output_dir);
        if (outputs.length > 0) {
          void this.refresh(false, outputs);
        }
      }
    }, 5000);
  }

  async refresh(
    reportFailure = true,
    outputs?: readonly string[],
  ): Promise<void> {
    if (!this.canRead()) {
      this.runs = [];
      this.initialized = true;
      if (this.view !== undefined) {
        this.view.message =
          this.host.root === undefined
            ? 'Open a Verdog project to see its runs.'
            : this.host.preview !== undefined
              ? 'Import into a trusted project to run this workflow.'
              : 'Trust this workspace to read local runs.';
      }
      if (!this.disposed) {
        this.publish();
      }
      return;
    }
    if (outputs === undefined) {
      this.pendingRefresh = true;
    } else {
      outputs.forEach(output => this.pendingOutputs.add(output));
    }
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const update = async () => {
      while (
        this.canRead() &&
        (this.pendingRefresh || this.pendingOutputs.size > 0)
      ) {
        const selected = this.pendingRefresh
          ? undefined
          : [...this.pendingOutputs];
        this.pendingRefresh = false;
        this.pendingOutputs.clear();
        await this.readHeaders(selected, reportFailure);
      }
    };
    this.refreshInFlight = update().finally(() => {
      this.refreshInFlight = undefined;
      this.schedulePoll();
    });
    return this.refreshInFlight;
  }

  private async readHeaders(
    outputs: readonly string[] | undefined,
    reportFailure: boolean,
  ): Promise<void> {
    const root = this.host.root!;
    const revision = this.revision;
    const abort = new AbortController();
    this.refreshAbort = abort;
    try {
      const result = await runVerdogCommand(
        root,
        [
          'runs',
          '--brief',
          '--json',
          ...(outputs ?? []).flatMap(output => ['--output', output]),
        ],
        {
          announce: false,
          output: this.host.output,
          streamOutput: false,
          structured: true,
          trust: 'caller-verified',
          signal: abort.signal,
        },
      );
      if (
        abort.signal.aborted ||
        !this.canRead() ||
        revision !== this.revision ||
        root !== this.host.root
      ) {
        return;
      }
      const envelope =
        result.code === 0 ? parseBriefRunsEnvelope(result.stdout) : undefined;
      if (envelope === undefined) {
        const problem =
          parseErrorEnvelope(result.stdout)?.error.message ??
          (result.stderr.trim() ||
            'verdog runs --brief produced invalid JSON.');
        this.monitoringSupported =
          !/unrecognized arguments|unrecognized option|upgrade verdog|brief.*unavailable/i.test(
            problem,
          );
        this.reportRefreshFailure(
          this.monitoringSupported
            ? problem
            : 'Upgrade verdog-cli with `uv tool upgrade verdog-cli` to enable lightweight run monitoring.',
          reportFailure,
        );
        return;
      }
      if (
        envelope.runs.some(run => !path.isAbsolute(run.output_dir)) ||
        (outputs !== undefined &&
          envelope.runs.some(run => !outputs.includes(run.output_dir)))
      ) {
        this.reportRefreshFailure(
          'The CLI returned an unexpected run output directory.',
          reportFailure,
        );
        return;
      }
      this.monitoringSupported = true;
      this.runs =
        outputs === undefined
          ? envelope.runs
          : [
              ...this.runs.filter(run => !outputs.includes(run.output_dir)),
              ...envelope.runs,
            ];
      this.initialized = true;
      if (this.view !== undefined) {
        this.view.message =
          this.runs.length === 0 ? 'No local workflow runs yet.' : undefined;
      }
      this.syncRunWatchers();
      this.publish();
    } catch (error) {
      if (
        !abort.signal.aborted &&
        this.canRead() &&
        revision === this.revision
      ) {
        this.reportRefreshFailure(String(error), reportFailure);
      }
    } finally {
      if (this.refreshAbort === abort) {
        this.refreshAbort = undefined;
      }
    }
  }

  private reportRefreshFailure(problem: string, reportFailure: boolean): void {
    this.host.output.appendLine(`run history refresh failed: ${problem}`);
    if (this.view !== undefined) {
      this.view.message = problem;
    }
    if (reportFailure) {
      void vscode.window.showWarningMessage(
        `Verdog run history could not be refreshed: ${problem}`,
      );
    }
    this.initialized = true;
  }

  private runById(reference: string): RunHeader | undefined {
    const matches = this.runs.filter(
      run =>
        run.id === reference ||
        run.id.startsWith(reference) ||
        run.directory_name === reference,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  async chooseRun(
    value: unknown,
    title: string,
  ): Promise<RunHeader | undefined> {
    if (!this.initialized) {
      await this.refresh();
    }
    const reference = referencedRun(value);
    if (reference !== undefined) {
      const selected = this.runById(reference);
      if (selected === undefined) {
        void vscode.window.showWarningMessage(
          `Verdog run ${reference} is not in the current run list.`,
        );
      }
      return selected;
    }
    return (
      await vscode.window.showQuickPick(
        this.runs.map(run => ({
          label: run.directory_name,
          description: `${run.workflow.id} · ${run.status}`,
          detail: run.output_dir,
          run,
        })),
        {placeHolder: 'Select a local workflow run', title},
      )
    )?.run;
  }

  async checkpoints(
    run: RunHeader,
  ): Promise<ReturnType<typeof parseCheckpointsEnvelope>> {
    const root = this.host.root;
    if (root === undefined) {
      return undefined;
    }
    const result = await this.runCli(
      ['checkpoints', run.output_dir, '--json'],
      `Reading checkpoints for ${run.directory_name}`,
      false,
    );
    const envelope =
      result.code === 0 ? parseCheckpointsEnvelope(result.stdout) : undefined;
    if (envelope !== undefined) {
      return envelope;
    }
    const problem =
      parseErrorEnvelope(result.stdout)?.error.message ??
      (result.stderr.trim() || 'verdog checkpoints produced invalid JSON.');
    this.host.output.appendLine(`checkpoint inspection failed: ${problem}`);
    void vscode.window.showWarningMessage(
      `Could not read checkpoints: ${problem}`,
    );
    return undefined;
  }

  async runOperation(args: string[], title: string): Promise<OperationResult> {
    const outcome = await this.runCli(args, title, true);
    const operation = parseOperationEnvelope(outcome.stdout);
    const error =
      operation === undefined ? parseErrorEnvelope(outcome.stdout) : undefined;
    if (
      outcome.code !== 130 &&
      operation === undefined &&
      error === undefined
    ) {
      this.host.output.appendLine(
        outcome.combined.trim() ||
          `${args[0]} produced no machine-readable result.`,
      );
    }
    return {
      outcome,
      ...(operation === undefined ? {} : {operation}),
      ...(error === undefined ? {} : {error}),
    };
  }

  async showOperationResult(
    result: OperationResult,
    title: string,
  ): Promise<void> {
    await this.refresh(false);
    if (result.outcome.code === 130) {
      void vscode.window.showInformationMessage(
        `${title} was cancelled. The run is recoverable.`,
      );
      return;
    }
    if (result.operation !== undefined) {
      const message =
        `${title} ${result.operation.status}: ${result.operation.run.directory_name}` +
        (result.operation.error === undefined
          ? ''
          : ` — ${result.operation.error.message}`);
      if (
        result.operation.status === 'succeeded' &&
        result.outcome.code === 0
      ) {
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
      return;
    }
    const problem =
      result.error?.error.message ?? 'The CLI returned an invalid response.';
    void vscode.window.showWarningMessage(`${title} failed: ${problem}`);
  }

  private async runCli(
    args: string[],
    title: string,
    cancellable: boolean,
  ): Promise<Outcome> {
    const root = this.host.root;
    if (root === undefined || this.host.preview !== undefined) {
      return {code: 1, combined: '', stderr: '', stdout: ''};
    }
    return runVerdogCommand(root, args, {
      output: this.host.output,
      progress: {
        cancellable,
        location: vscode.ProgressLocation.Notification,
        reportStderr: true,
        title,
      },
      structured: true,
      trust: 'caller-verified',
    });
  }
}

function trusted(host: HostState, verb: string): boolean {
  if (
    host.root !== undefined &&
    host.preview === undefined &&
    vscode.workspace.isTrusted
  ) {
    return true;
  }
  void vscode.window.showWarningMessage(
    host.preview !== undefined
      ? 'Import into a trusted project to run this workflow.'
      : host.root === undefined
        ? 'Open a Verdog project first.'
        : `Trust this workspace before running \`verdog ${verb}\`.`,
  );
  return false;
}

async function sessionPolicy(
  requested: SessionPolicy | undefined,
  branchAvailable: boolean,
  persistent: number,
  title: string,
): Promise<SessionPolicy | undefined> {
  if (requested !== undefined) {
    if (requested === 'branch' && !branchAvailable) {
      void vscode.window.showWarningMessage(
        'Conversation branching is unavailable for this selection.',
      );
      return undefined;
    }
    return requested;
  }
  if (persistent === 0) {
    return branchAvailable ? 'branch' : 'fresh';
  }
  const items = [
    ...(branchAvailable
      ? [
          {
            label: 'Branch conversations',
            description: 'recommended',
            detail:
              'Continue independently from the committed conversation anchors.',
            policy: 'branch' as const,
          },
        ]
      : []),
    {
      label: 'Start fresh conversations',
      description: branchAvailable
        ? 'discard conversation context'
        : 'branching unavailable',
      detail: 'Keep workflow state but create new provider conversations.',
      policy: 'fresh' as const,
    },
  ];
  return (await vscode.window.showQuickPick(items, {title}))?.policy;
}

async function replacementArguments(
  run: RunHeader,
  request: RunCommandRequest | undefined,
): Promise<readonly string[] | undefined | false> {
  if (
    request !== undefined &&
    Object.prototype.hasOwnProperty.call(request, 'arguments')
  ) {
    return request.arguments ?? [];
  }
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Reuse recorded arguments',
        description: shownArguments(run.launch.workflow_arguments),
        reuse: true,
      },
      {
        label: 'Override arguments',
        description: 'enter a JSON string array',
        reuse: false,
      },
    ],
    {title: 'Restart workflow arguments'},
  );
  if (choice === undefined) {
    return false;
  }
  if (choice.reuse) {
    return undefined;
  }
  const typed = await vscode.window.showInputBox({
    prompt: 'Enter the complete workflow argv as a JSON array of strings.',
    title: 'Override workflow arguments',
    value: JSON.stringify(run.launch.workflow_arguments),
    validateInput: value =>
      parseWorkflowArguments(value) === undefined
        ? 'Use a JSON array containing only strings.'
        : undefined,
  });
  if (typed === undefined) {
    return false;
  }
  return parseWorkflowArguments(typed) ?? false;
}

async function selectedCheckpoint(
  checkpoints: readonly CheckpointSummary[],
  requested: number | 'latest' | undefined,
): Promise<CheckpointSummary | undefined> {
  const available = checkpoints
    .filter(
      checkpoint =>
        checkpoint.fork_with_branch_available ||
        checkpoint.fork_with_fresh_available,
    )
    .sort((left, right) => right.sequence - left.sequence);
  if (available.length === 0) {
    void vscode.window.showWarningMessage(
      'This run has no checkpoint available for forking.',
    );
    return undefined;
  }
  if (requested !== undefined) {
    const sequence = requested === 'latest' ? available[0].sequence : requested;
    const checkpoint = available.find(
      candidate => candidate.sequence === sequence,
    );
    if (checkpoint === undefined) {
      void vscode.window.showWarningMessage(
        `Checkpoint ${sequence} is not available for forking.`,
      );
    }
    return checkpoint;
  }
  return (
    await vscode.window.showQuickPick(
      available.map((checkpoint, index) => ({
        label: `Checkpoint ${checkpoint.sequence}${index === 0 ? ' (latest)' : ''}`,
        description: checkpoint.kind,
        detail: `Next: ${boundaryLabel(checkpoint.next)} · ${checkpoint.created_at}`,
        checkpoint,
      })),
      {
        placeHolder: 'Select a committed checkpoint',
        title: 'Fork workflow run',
      },
    )
  )?.checkpoint;
}

export function registerRunHistory(host: HostState): vscode.Disposable[] {
  const provider = new RunHistoryProvider(host);
  const view = vscode.window.createTreeView('verdog.runs', {
    showCollapseAll: true,
    treeDataProvider: provider,
  });
  provider.attach(view);

  const refresh = vscode.commands.registerCommand('verdog.refreshRuns', () =>
    provider.refresh(),
  );
  const resume = vscode.commands.registerCommand(
    'verdog.resumeRun',
    async (given?: unknown) => {
      if (!trusted(host, 'resume')) {
        return;
      }
      const run = await provider.chooseRun(given, 'Resume workflow run');
      if (run === undefined) {
        return;
      }
      const inspected = await provider.checkpoints(run);
      if (inspected === undefined) {
        return;
      }
      const current = inspected.run;
      const checkpoint = inspected.checkpoints.find(
        ({sequence}) => sequence === current.checkpoints.latest_completed,
      );
      if (current.status === 'succeeded') {
        void vscode.window.showWarningMessage(
          'A succeeded run cannot be resumed; restart it or fork one of its checkpoints.',
        );
        return;
      }
      if (!current.checkpoints.resume_available || checkpoint === undefined) {
        void vscode.window.showWarningMessage(
          current.checkpoints.unavailable_reason ??
            'The latest checkpoint cannot be resumed exactly.',
        );
        return;
      }
      const confirmed = await vscode.window.showInformationMessage(
        `Resume ${current.directory_name}?`,
        {
          modal: true,
          detail:
            `Checkpoint ${checkpoint.sequence}\nNext: ${boundaryLabel(checkpoint.next)}\n` +
            `${current.sessions.persistent} persistent conversation(s) will be restored.`,
        },
        'Resume',
      );
      if (confirmed !== 'Resume') {
        return;
      }
      const request = commandRequest(given);
      let result = await provider.runOperation(
        resumeCliArguments(current.output_dir, request?.retryIncomplete),
        'Resuming workflow',
      );
      const operationError = result.operation?.error ?? result.error?.error;
      if (
        !request?.retryIncomplete &&
        isIncompleteInvocationError(operationError)
      ) {
        const retry = await vscode.window.showWarningMessage(
          'The interrupted provider invocation has an ambiguous result. Retry it? This may repeat provider cost.',
          {modal: true},
          'Retry incomplete invocation',
        );
        if (retry === 'Retry incomplete invocation') {
          result = await provider.runOperation(
            resumeCliArguments(current.output_dir, true),
            'Resuming workflow',
          );
        }
      }
      await provider.showOperationResult(result, 'Resume');
    },
  );

  const restart = vscode.commands.registerCommand(
    'verdog.restartRun',
    async (given?: unknown) => {
      if (!trusted(host, 'restart')) {
        return;
      }
      const run = await provider.chooseRun(given, 'Restart workflow run');
      if (run === undefined) {
        return;
      }
      const request = commandRequest(given);
      let current = run;
      let branchAvailable = false;
      let persistent = 0;
      if (request?.sessions !== 'fresh') {
        const inspected = await provider.checkpoints(run);
        if (inspected === undefined) {
          return;
        }
        current = inspected.run;
        persistent = inspected.run.sessions.persistent;
        branchAvailable = inspected.checkpoints.some(
          checkpoint => checkpoint.fork_with_branch_available,
        );
      }
      const sessions = await sessionPolicy(
        request?.sessions,
        branchAvailable,
        persistent,
        'Restart conversations',
      );
      if (sessions === undefined) {
        return;
      }
      const args = await replacementArguments(current, request);
      if (args === false) {
        return;
      }
      const confirmed = await vscode.window.showInformationMessage(
        `Restart ${current.directory_name} from workflow entry?`,
        {
          modal: true,
          detail:
            `${sessions === 'branch' ? 'Branch' : 'Reset'} persistent conversations. ` +
            (args === undefined
              ? `Reuse ${shownArguments(current.launch.workflow_arguments)}.`
              : `Use ${shownArguments(args)}.`),
        },
        'Restart',
      );
      if (confirmed !== 'Restart') {
        return;
      }
      const result = await provider.runOperation(
        restartCliArguments(
          current.output_dir,
          sessions,
          args === undefined ? undefined : [...args],
        ),
        'Restarting workflow',
      );
      await provider.showOperationResult(result, 'Restart');
    },
  );

  const fork = vscode.commands.registerCommand(
    'verdog.forkRun',
    async (given?: unknown) => {
      if (!trusted(host, 'fork')) {
        return;
      }
      const run = await provider.chooseRun(given, 'Fork workflow run');
      if (run === undefined) {
        return;
      }
      const inspected = await provider.checkpoints(run);
      if (inspected === undefined) {
        return;
      }
      const request = commandRequest(given);
      const checkpoint = await selectedCheckpoint(
        inspected.checkpoints,
        request?.checkpoint,
      );
      if (checkpoint === undefined) {
        return;
      }
      const sessions = await sessionPolicy(
        request?.sessions,
        checkpoint.fork_with_branch_available,
        inspected.run.sessions.persistent,
        `Checkpoint ${checkpoint.sequence} conversations`,
      );
      if (sessions === undefined) {
        return;
      }
      if (sessions === 'fresh' && !checkpoint.fork_with_fresh_available) {
        void vscode.window.showWarningMessage(
          'Fresh-session forking is unavailable at this checkpoint.',
        );
        return;
      }
      const confirmed = await vscode.window.showInformationMessage(
        `Fork ${run.directory_name} at checkpoint ${checkpoint.sequence}?`,
        {
          modal: true,
          detail:
            `Next: ${boundaryLabel(checkpoint.next)}\n` +
            `${sessions === 'branch' ? 'Branch' : 'Reset'} persistent conversations.`,
        },
        'Fork',
      );
      if (confirmed !== 'Fork') {
        return;
      }
      const result = await provider.runOperation(
        forkCliArguments(run.output_dir, checkpoint.sequence, sessions),
        'Forking workflow',
      );
      await provider.showOperationResult(result, 'Fork');
    },
  );

  const open = vscode.commands.registerCommand(
    'verdog.openRunOutput',
    async (given?: unknown) => {
      const run = await provider.chooseRun(given, 'Open workflow run output');
      if (run === undefined) {
        return;
      }
      const uri = vscode.Uri.file(run.output_dir);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand('revealFileInOS', uri);
      } catch (error) {
        host.output.appendLine(`opening run output failed: ${String(error)}`);
        void vscode.window.showWarningMessage(
          `Run output is unavailable: ${run.output_dir}`,
        );
      }
    },
  );

  const disposables: vscode.Disposable[] = [
    view,
    provider,
    refresh,
    resume,
    restart,
    fork,
    open,
  ];
  return disposables;
}
