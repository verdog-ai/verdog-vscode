import * as vscode from "vscode";

import type { Outcome } from "./cli";
import type { HostState } from "./projectHost";
import { runVerdogCommand } from "./verdogCommand";
import {
  boundaryLabel,
  buildRunTrees,
  forkCliArguments,
  isIncompleteInvocationError,
  parseCheckpointsEnvelope,
  parseErrorEnvelope,
  parseOperationEnvelope,
  parseRunsEnvelope,
  parseWorkflowArguments,
  restartCliArguments,
  resumeCliArguments,
  type CheckpointSummary,
  type ErrorEnvelope,
  type OperationEnvelope,
  type RunBranch,
  type RunSummary,
  type SessionPolicy,
} from "./runHistory";

type WorkflowTreeItem = vscode.TreeItem & {
  readonly kind: "workflow";
  readonly children: RunTreeItem[];
};

type RunTreeItem = vscode.TreeItem & {
  readonly kind: "run";
  readonly run: RunSummary;
  readonly children: RunTreeItem[];
};

type HistoryTreeItem = WorkflowTreeItem | RunTreeItem;

export type RunCommandRequest = {
  run?: string;
  sessions?: SessionPolicy;
  checkpoint?: number | "latest";
  arguments?: string[];
  retryIncomplete?: boolean;
};

type OperationResult = {
  outcome: Outcome;
  operation?: OperationEnvelope;
  error?: ErrorEnvelope;
};

const statusIcon = (status: RunSummary["status"]): vscode.ThemeIcon => {
  switch (status) {
    case "running": return new vscode.ThemeIcon("loading~spin");
    case "interrupted": return new vscode.ThemeIcon("debug-pause");
    case "failed": return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "succeeded": return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
  }
};

const shownArguments = (arguments_: readonly string[]): string =>
  arguments_.length === 0 ? "[]" : JSON.stringify(arguments_);

function runTooltip(run: RunSummary): string {
  const parent = run.parent === null
    ? "none"
    : `${run.parent.operation} of ${run.parent.run_id}` +
      (run.parent.checkpoint === null ? "" : ` at checkpoint ${run.parent.checkpoint}`);
  const resume = run.checkpoints.resume_available
    ? `checkpoint ${run.checkpoints.latest_completed}`
    : run.checkpoints.unavailable_reason ?? "unavailable";
  return [
    `Workflow: ${run.workflow.id}`,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Updated: ${run.updated_at}`,
    `Parent: ${parent}`,
    `Resume: ${resume}`,
    `Persistent conversations: ${run.sessions.persistent}`,
    `Arguments: ${shownArguments(run.launch.workflow_arguments)}`,
    `Output: ${run.output_dir}`,
  ].join("\n");
}

function makeRunItem(branch: RunBranch): RunTreeItem {
  const children = branch.children.map(makeRunItem);
  const item = new vscode.TreeItem(
    branch.run.directory_name,
    children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  ) as RunTreeItem;
  Object.defineProperties(item, {
    kind: { value: "run", enumerable: true },
    run: { value: branch.run, enumerable: true },
    children: { value: children, enumerable: true },
  });
  item.description = `${branch.run.status} · checkpoint ${branch.run.checkpoints.latest_completed ?? "none"}`;
  item.tooltip = runTooltip(branch.run);
  item.iconPath = statusIcon(branch.run.status);
  item.contextValue = [
    "verdogRun",
    ...(branch.run.status !== "succeeded" && branch.run.checkpoints.resume_available
      ? ["resume"]
      : []),
    ...(branch.run.checkpoints.count > 0 ? ["fork"] : []),
  ].join(".");
  item.command = {
    command: "verdog.openRunOutput",
    title: "Open Run Output",
    arguments: [item],
  };
  item.accessibilityInformation = {
    label: `${branch.run.workflow.id} run ${branch.run.directory_name}, ${branch.run.status}`,
  };
  return item;
}

function makeWorkflowItem(
  workflow: ReturnType<typeof buildRunTrees>[number],
): WorkflowTreeItem {
  const children = workflow.roots.map(makeRunItem);
  const item = new vscode.TreeItem(
    workflow.workflow.id,
    vscode.TreeItemCollapsibleState.Expanded,
  ) as WorkflowTreeItem;
  Object.defineProperties(item, {
    kind: { value: "workflow", enumerable: true },
    children: { value: children, enumerable: true },
  });
  item.description = `${workflow.count} run${workflow.count === 1 ? "" : "s"}`;
  item.tooltip = `${workflow.workflow.definition_id}\n${workflow.workflow.module}`;
  item.iconPath = new vscode.ThemeIcon("workflow");
  item.contextValue = "verdogWorkflow";
  return item;
}

const commandRequest = (value: unknown): RunCommandRequest | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "run") return undefined;
  const run = typeof candidate.run === "string" ? candidate.run : undefined;
  const sessions = candidate.sessions === "branch" || candidate.sessions === "fresh"
    ? candidate.sessions
    : undefined;
  const checkpoint = candidate.checkpoint === "latest" ||
    (Number.isSafeInteger(candidate.checkpoint) && (candidate.checkpoint as number) > 0)
    ? candidate.checkpoint as number | "latest"
    : undefined;
  const arguments_ = Array.isArray(candidate.arguments) &&
    candidate.arguments.every((item) => typeof item === "string")
    ? candidate.arguments as string[]
    : undefined;
  return {
    ...(run === undefined ? {} : { run }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
    ...(candidate.retryIncomplete === true ? { retryIncomplete: true } : {}),
  };
};

const isRunItem = (value: unknown): value is RunTreeItem =>
  value !== null && typeof value === "object" &&
  (value as { kind?: unknown }).kind === "run" &&
  (value as { run?: unknown }).run !== undefined;

const referencedRun = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (isRunItem(value)) return value.run.id;
  return commandRequest(value)?.run;
};

class RunHistoryProvider implements vscode.TreeDataProvider<HistoryTreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryTreeItem | undefined | void>();
  private items: WorkflowTreeItem[] = [];
  private runs: RunSummary[] = [];
  private initialized = false;
  private refreshInFlight: Promise<void> | undefined;
  private view: vscode.TreeView<HistoryTreeItem> | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: HostState) {}

  attach(view: vscode.TreeView<HistoryTreeItem>): void {
    this.view = view;
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(item: HistoryTreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: HistoryTreeItem): Promise<HistoryTreeItem[]> {
    if (!this.initialized) await this.refresh(false);
    return item === undefined ? this.items : item.children;
  }

  async refresh(reportFailure = true): Promise<void> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    const update = async () => {
      const root = this.host.root;
      if (root === undefined) {
        this.items = [];
        this.runs = [];
        this.initialized = true;
        if (this.view !== undefined) this.view.message = "Open a Verdog project to see its runs.";
        this.changed.fire();
        return;
      }
      if (!vscode.workspace.isTrusted) {
        this.items = [];
        this.runs = [];
        this.initialized = true;
        if (this.view !== undefined) this.view.message = "Trust this workspace to read local runs.";
        this.changed.fire();
        return;
      }
      const result = await runVerdogCommand(root, ["runs", "--json"], {
        announce: false,
        output: this.host.output,
        streamOutput: false,
        structured: true,
        trust: "caller-verified",
      });
      const envelope = result.code === 0 ? parseRunsEnvelope(result.stdout) : undefined;
      if (envelope === undefined) {
        const problem = parseErrorEnvelope(result.stdout)?.error.message ??
          (result.stderr.trim() || "verdog runs produced invalid JSON.");
        this.host.output.appendLine(`run history refresh failed: ${problem}`);
        if (this.view !== undefined) {
          this.view.message = this.initialized
            ? "Refresh failed; showing the last valid run list."
            : "Run history could not be loaded. See the Verdog output.";
        }
        if (reportFailure) {
          void vscode.window.showWarningMessage(
            "Verdog run history could not be refreshed. See the Verdog output.",
          );
        }
        this.initialized = true;
        return;
      }
      this.runs = envelope.runs;
      this.items = buildRunTrees(this.runs).map(makeWorkflowItem);
      this.initialized = true;
      if (this.view !== undefined) {
        this.view.message = this.runs.length === 0 ? "No local workflow runs yet." : undefined;
      }
      this.changed.fire();
    };
    this.refreshInFlight = update().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private runById(reference: string): RunSummary | undefined {
    const matches = this.runs.filter((run) =>
      run.id === reference || run.id.startsWith(reference) || run.directory_name === reference
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  async chooseRun(value: unknown, title: string): Promise<RunSummary | undefined> {
    if (!this.initialized) await this.refresh();
    const reference = referencedRun(value);
    if (reference !== undefined) {
      const selected = this.runById(reference);
      if (selected === undefined) {
        void vscode.window.showWarningMessage(`Verdog run ${reference} is not in the current run list.`);
      }
      return selected;
    }
    return (await vscode.window.showQuickPick(
      this.runs.map((run) => ({
        label: run.directory_name,
        description: `${run.workflow.id} · ${run.status}`,
        detail: run.output_dir,
        run,
      })),
      { placeHolder: "Select a local workflow run", title },
    ))?.run;
  }

  async checkpoints(run: RunSummary): Promise<ReturnType<typeof parseCheckpointsEnvelope>> {
    const root = this.host.root;
    if (root === undefined) return undefined;
    const result = await this.runCli(
      ["checkpoints", run.id, "--json"],
      `Reading checkpoints for ${run.directory_name}`,
      false,
    );
    const envelope = result.code === 0 ? parseCheckpointsEnvelope(result.stdout) : undefined;
    if (envelope !== undefined) return envelope;
    const problem = parseErrorEnvelope(result.stdout)?.error.message ??
      (result.stderr.trim() || "verdog checkpoints produced invalid JSON.");
    this.host.output.appendLine(`checkpoint inspection failed: ${problem}`);
    void vscode.window.showWarningMessage(`Could not read checkpoints: ${problem}`);
    return undefined;
  }

  async runOperation(arguments_: string[], title: string): Promise<OperationResult> {
    const outcome = await this.runCli(arguments_, title, true);
    const operation = parseOperationEnvelope(outcome.stdout);
    const error = operation === undefined ? parseErrorEnvelope(outcome.stdout) : undefined;
    if (outcome.code !== 130 && operation === undefined && error === undefined) {
      this.host.output.appendLine(
        outcome.combined.trim() || `${arguments_[0]} produced no machine-readable result.`,
      );
    }
    return { outcome, ...(operation === undefined ? {} : { operation }), ...(error === undefined ? {} : { error }) };
  }

  async showOperationResult(result: OperationResult, title: string): Promise<void> {
    await this.refresh(false);
    if (result.outcome.code === 130) {
      void vscode.window.showInformationMessage(`${title} was cancelled. The run is recoverable.`);
      return;
    }
    if (result.operation !== undefined) {
      const message = `${title} ${result.operation.status}: ${result.operation.run.directory_name}` +
        (result.operation.error === undefined ? "" : ` — ${result.operation.error.message}`);
      if (result.operation.status === "succeeded" && result.outcome.code === 0) {
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
      return;
    }
    const problem = result.error?.error.message ?? "The CLI returned an invalid response.";
    void vscode.window.showWarningMessage(`${title} failed: ${problem}`);
  }

  private async runCli(
    arguments_: string[],
    title: string,
    cancellable: boolean,
  ): Promise<Outcome> {
    const root = this.host.root;
    if (root === undefined) return { code: 1, combined: "", stderr: "", stdout: "" };
    return runVerdogCommand(root, arguments_, {
      output: this.host.output,
      progress: {
        cancellable,
        location: vscode.ProgressLocation.Notification,
        reportStderr: true,
        title,
      },
      structured: true,
      trust: "caller-verified",
    });
  }
}

function trusted(host: HostState, verb: string): boolean {
  if (host.root !== undefined && vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage(
    host.root === undefined
      ? "Open a Verdog project first."
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
    if (requested === "branch" && !branchAvailable) {
      void vscode.window.showWarningMessage("Conversation branching is unavailable for this selection.");
      return undefined;
    }
    return requested;
  }
  if (persistent === 0) return branchAvailable ? "branch" : "fresh";
  const items = [
    ...(branchAvailable ? [{
      label: "Branch conversations",
      description: "recommended",
      detail: "Continue independently from the committed conversation anchors.",
      policy: "branch" as const,
    }] : []),
    {
      label: "Start fresh conversations",
      description: branchAvailable ? "discard conversation context" : "branching unavailable",
      detail: "Keep workflow state but create new provider conversations.",
      policy: "fresh" as const,
    },
  ];
  return (await vscode.window.showQuickPick(items, { title }))?.policy;
}

async function replacementArguments(
  run: RunSummary,
  request: RunCommandRequest | undefined,
): Promise<readonly string[] | undefined | false> {
  if (request !== undefined && Object.prototype.hasOwnProperty.call(request, "arguments")) {
    return request.arguments ?? [];
  }
  const choice = await vscode.window.showQuickPick([
    {
      label: "Reuse recorded arguments",
      description: shownArguments(run.launch.workflow_arguments),
      reuse: true,
    },
    {
      label: "Override arguments",
      description: "enter a JSON string array",
      reuse: false,
    },
  ], { title: "Restart workflow arguments" });
  if (choice === undefined) return false;
  if (choice.reuse) return undefined;
  const typed = await vscode.window.showInputBox({
    prompt: "Enter the complete workflow argv as a JSON array of strings.",
    title: "Override workflow arguments",
    value: JSON.stringify(run.launch.workflow_arguments),
    validateInput: (value) => parseWorkflowArguments(value) === undefined
      ? "Use a JSON array containing only strings."
      : undefined,
  });
  if (typed === undefined) return false;
  return parseWorkflowArguments(typed) ?? false;
}

async function selectedCheckpoint(
  checkpoints: readonly CheckpointSummary[],
  requested: number | "latest" | undefined,
): Promise<CheckpointSummary | undefined> {
  const available = checkpoints
    .filter((checkpoint) =>
      checkpoint.fork_with_branch_available || checkpoint.fork_with_fresh_available
    )
    .sort((left, right) => right.sequence - left.sequence);
  if (available.length === 0) {
    void vscode.window.showWarningMessage("This run has no checkpoint available for forking.");
    return undefined;
  }
  if (requested !== undefined) {
    const sequence = requested === "latest" ? available[0]!.sequence : requested;
    const checkpoint = available.find((candidate) => candidate.sequence === sequence);
    if (checkpoint === undefined) {
      void vscode.window.showWarningMessage(`Checkpoint ${sequence} is not available for forking.`);
    }
    return checkpoint;
  }
  return (await vscode.window.showQuickPick(
    available.map((checkpoint, index) => ({
      label: `Checkpoint ${checkpoint.sequence}${index === 0 ? " (latest)" : ""}`,
      description: checkpoint.kind,
      detail: `Next: ${boundaryLabel(checkpoint.next)} · ${checkpoint.created_at}`,
      checkpoint,
    })),
    { placeHolder: "Select a committed checkpoint", title: "Fork workflow run" },
  ))?.checkpoint;
}

export function registerRunHistory(host: HostState): vscode.Disposable[] {
  const provider = new RunHistoryProvider(host);
  const view = vscode.window.createTreeView("verdog.runs", {
    showCollapseAll: true,
    treeDataProvider: provider,
  });
  provider.attach(view);

  const refresh = vscode.commands.registerCommand("verdog.refreshRuns", () => provider.refresh());
  const resume = vscode.commands.registerCommand("verdog.resumeRun", async (given?: unknown) => {
    if (!trusted(host, "resume")) return;
    const run = await provider.chooseRun(given, "Resume workflow run");
    if (run === undefined) return;
    const inspected = await provider.checkpoints(run);
    if (inspected === undefined) return;
    const current = inspected.run;
    const checkpoint = inspected.checkpoints.find(
      ({ sequence }) => sequence === current.checkpoints.latest_completed,
    );
    if (current.status === "succeeded") {
      void vscode.window.showWarningMessage(
        "A succeeded run cannot be resumed; restart it or fork one of its checkpoints.",
      );
      return;
    }
    if (!current.checkpoints.resume_available || checkpoint === undefined) {
      void vscode.window.showWarningMessage(
        current.checkpoints.unavailable_reason ?? "The latest checkpoint cannot be resumed exactly.",
      );
      return;
    }
    const confirmed = await vscode.window.showInformationMessage(
      `Resume ${current.directory_name}?`,
      {
        modal: true,
        detail: `Checkpoint ${checkpoint.sequence}\nNext: ${boundaryLabel(checkpoint.next)}\n` +
          `${current.sessions.persistent} persistent conversation(s) will be restored.`,
      },
      "Resume",
    );
    if (confirmed !== "Resume") return;
    const request = commandRequest(given);
    let result = await provider.runOperation(
      resumeCliArguments(current.id, request?.retryIncomplete),
      "Resuming workflow",
    );
    const operationError = result.operation?.error ?? result.error?.error;
    if (!request?.retryIncomplete && isIncompleteInvocationError(operationError)) {
      const retry = await vscode.window.showWarningMessage(
        "The interrupted provider invocation has an ambiguous result. Retry it? This may repeat provider cost.",
        { modal: true },
        "Retry incomplete invocation",
      );
      if (retry === "Retry incomplete invocation") {
        result = await provider.runOperation(
          resumeCliArguments(current.id, true),
          "Resuming workflow",
        );
      }
    }
    await provider.showOperationResult(result, "Resume");
  });

  const restart = vscode.commands.registerCommand("verdog.restartRun", async (given?: unknown) => {
    if (!trusted(host, "restart")) return;
    const run = await provider.chooseRun(given, "Restart workflow run");
    if (run === undefined) return;
    const request = commandRequest(given);
    let current = run;
    let branchAvailable = false;
    if (request?.sessions !== "fresh") {
      const inspected = await provider.checkpoints(run);
      if (inspected !== undefined) {
        current = inspected.run;
        branchAvailable = inspected.checkpoints.some(
          (checkpoint) => checkpoint.fork_with_branch_available,
        );
      }
    }
    const sessions = await sessionPolicy(
      request?.sessions,
      branchAvailable,
      current.sessions.persistent,
      "Restart conversations",
    );
    if (sessions === undefined) return;
    const arguments_ = await replacementArguments(current, request);
    if (arguments_ === false) return;
    const confirmed = await vscode.window.showInformationMessage(
      `Restart ${current.directory_name} from workflow entry?`,
      {
        modal: true,
        detail: `${sessions === "branch" ? "Branch" : "Reset"} persistent conversations. ` +
          (arguments_ === undefined
            ? `Reuse ${shownArguments(current.launch.workflow_arguments)}.`
            : `Use ${shownArguments(arguments_)}.`),
      },
      "Restart",
    );
    if (confirmed !== "Restart") return;
    const result = await provider.runOperation(
      restartCliArguments(current.id, sessions, arguments_ === undefined ? undefined : [...arguments_]),
      "Restarting workflow",
    );
    await provider.showOperationResult(result, "Restart");
  });

  const fork = vscode.commands.registerCommand("verdog.forkRun", async (given?: unknown) => {
    if (!trusted(host, "fork")) return;
    const run = await provider.chooseRun(given, "Fork workflow run");
    if (run === undefined) return;
    const inspected = await provider.checkpoints(run);
    if (inspected === undefined) return;
    const request = commandRequest(given);
    const checkpoint = await selectedCheckpoint(inspected.checkpoints, request?.checkpoint);
    if (checkpoint === undefined) return;
    const sessions = await sessionPolicy(
      request?.sessions,
      checkpoint.fork_with_branch_available,
      inspected.run.sessions.persistent,
      `Checkpoint ${checkpoint.sequence} conversations`,
    );
    if (sessions === undefined) return;
    if (sessions === "fresh" && !checkpoint.fork_with_fresh_available) {
      void vscode.window.showWarningMessage("Fresh-session forking is unavailable at this checkpoint.");
      return;
    }
    const confirmed = await vscode.window.showInformationMessage(
      `Fork ${run.directory_name} at checkpoint ${checkpoint.sequence}?`,
      {
        modal: true,
        detail: `Next: ${boundaryLabel(checkpoint.next)}\n` +
          `${sessions === "branch" ? "Branch" : "Reset"} persistent conversations.`,
      },
      "Fork",
    );
    if (confirmed !== "Fork") return;
    const result = await provider.runOperation(
      forkCliArguments(run.id, checkpoint.sequence, sessions),
      "Forking workflow",
    );
    await provider.showOperationResult(result, "Fork");
  });

  const open = vscode.commands.registerCommand("verdog.openRunOutput", async (given?: unknown) => {
    const run = await provider.chooseRun(given, "Open workflow run output");
    if (run === undefined) return;
    const uri = vscode.Uri.file(run.output_dir);
    try {
      await vscode.workspace.fs.stat(uri);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    } catch (error) {
      host.output.appendLine(`opening run output failed: ${String(error)}`);
      void vscode.window.showWarningMessage(`Run output is unavailable: ${run.output_dir}`);
    }
  });

  const disposables: vscode.Disposable[] = [view, provider, refresh, resume, restart, fork, open];
  if (host.root !== undefined) {
    const watchers = [
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(host.root, ".verdog/runs/**/.verdog/run.json"),
      ),
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(host.root, ".verdog/runs/**/.verdog/checkpoints/*"),
      ),
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(host.root, ".verdog/runs/**/.verdog/checkpoints/*/manifest.json"),
      ),
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(host.root, ".verdog/run-registry.json"),
      ),
    ];
    let scheduled: NodeJS.Timeout | undefined;
    const schedule = () => {
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void provider.refresh(false);
      }, 250);
    };
    for (const watcher of watchers) {
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      disposables.push(watcher);
    }
    disposables.push({ dispose: () => {
      if (scheduled !== undefined) clearTimeout(scheduled);
    } });
  }
  return disposables;
}
