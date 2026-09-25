import { promises as fs } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  type CliDiagnostic,
  type Verdict,
  diagnosticRange,
  parseVerdict,
} from "./cli";
import { cliCommand, runVerdogCommand } from "./verdogCommand";
import { projectFileReadonly, readClone, subroutineFile } from "./clone";
import { graphHash } from "./graph";
import type { GraphId } from "../model/identifiers";
import { packageDirectory } from "../model/names";
import type { Preview } from "./preview";
import { directProjectPath } from "./projectPath";
import * as mutate from "../model/editing";
import { definitionIn, definitionKey, subroutinesIn } from "../model/project";
import type {
  HostToCanvas,
  NavigationCategory,
  NavigationEntry,
  NavigationTarget,
  WorkflowContext,
} from "../model/protocol";
import { snapshotCanvasGraphs } from "../webview/subroutineGraphs";
import { isStale, projectIn, subroutineIn, type ProjectSnapshot } from "../model/snapshot";
import { TerminationAnalysis } from "./terminationAnalysis";

export type Access = {
  installed: boolean;
  repository: string;
  seat: boolean;
  write: boolean;
};

export type HostState = {
  access: Access | undefined;
  canvasNavigationVersion: number;
  canvasReady: boolean;
  readonly extension: vscode.Uri;
  readonly output: vscode.OutputChannel;
  readonly preview: Preview | undefined;
  readonly problems: vscode.DiagnosticCollection;
  readonly protectedDocuments: Set<string>;
  navigationRevision: number;
  refreshRevision: number;
  pendingReveal: {
    readonly navigationVersion: number;
    readonly panel?: NavigationCategory | null;
    readonly restoration?: string;
    readonly revision: number;
    readonly target: NavigationTarget;
  } | undefined;
  readonly root: string | undefined;
  showingSubroutine: string | undefined;
  workflowEnvironmentSelection: Promise<void>;
  snapshot: ProjectSnapshot | undefined;
  termination?: TerminationAnalysis;
  snapshotChanged?: () => void;
  verdict: Verdict | undefined;
  view: vscode.WebviewView | undefined;
};

export type OpenHost = HostState & { readonly root: string };

export function hasProject(host: HostState): host is OpenHost {
  return host.root !== undefined;
}

export async function openProjectDocument(
  host: OpenHost,
  relative: string,
  options: vscode.TextDocumentShowOptions = {},
  current: () => boolean = () => true,
): Promise<boolean> {
  try {
    const file = vscode.Uri.file(await directProjectPath(host.root, relative));
    const document = await vscode.workspace.openTextDocument(file);
    if (!current()) return false;
    await vscode.window.showTextDocument(document, options);
    return true;
  } catch (error) {
    if (current()) {
      host.output.appendLine(`open ${relative} failed: ${String(error)}`);
      void vscode.window.showWarningMessage(`Could not open ${relative}: ${String(error)}`);
    }
    return false;
  }
}

export async function deliverPendingReveal(host: HostState): Promise<void> {
  const pending = host.pendingReveal;
  const view = host.view;
  if (pending === undefined || view === undefined || !host.canvasReady) return;

  host.pendingReveal = undefined;
  const delivered = await view.webview.postMessage(
    {
      kind: "reveal",
      navigationVersion: pending.navigationVersion,
      ...(pending.panel === undefined ? {} : { panel: pending.panel }),
      ...(pending.restoration === undefined ? {} : { restoration: pending.restoration }),
      target: pending.target,
    } satisfies HostToCanvas,
  );
  if (
    host.navigationRevision !== pending.revision ||
    host.pendingReveal !== undefined
  ) return;
  if (delivered && host.view === view) return;

  host.pendingReveal = pending;
  if (host.view !== view && host.canvasReady) await deliverPendingReveal(host);
}

export async function followNavigationTarget(
  host: HostState,
  target: NavigationTarget,
  panel?: NavigationCategory | null,
  restoration?: string,
): Promise<void> {
  host.pendingReveal = {
    navigationVersion: host.canvasNavigationVersion,
    ...(panel === undefined ? {} : { panel }),
    ...(restoration === undefined ? {} : { restoration }),
    revision: ++host.navigationRevision,
    target,
  };
  await vscode.commands.executeCommand("verdog.openCanvas");
  await deliverPendingReveal(host);
}

/** Follow a retained browser entry; webviews only return its opaque key. */
export async function followNavigation(
  host: OpenHost,
  entry: NavigationEntry,
  openDeclaration: boolean,
): Promise<void> {
  const revision = ++host.navigationRevision;
  host.pendingReveal = undefined;
  const target = entry.target;
  const graph = target === undefined || host.snapshot === undefined
    ? undefined
    : snapshotCanvasGraphs(host.snapshot)[target.scope];
  const selection = target?.selection;
  const body = graph?.scope.kind === "subroutine" && host.snapshot !== undefined
    ? subroutineIn(host.snapshot, graph.scope.ownerGraph)
    : undefined;
  const available = target === undefined || (
    graph !== undefined && (
      selection !== undefined
        ? graph[selection.entity].some(({ id }) => id === selection.id)
        : entry.entity === "subroutines" || entry.entity === "workflows"
          ? true
          : body?.[entry.entity].some(({ id }) => id === entry.id) === true
    )
  );
  if (!available) {
    void vscode.window.showInformationMessage(
      `Verdog: ${entry.entity.slice(0, -1)} ${entry.id} is no longer available.`,
    );
    return;
  }

  let followed = false;
  if (openDeclaration && entry.declaration !== undefined) {
    followed = await openProjectDocument(
      host,
      entry.declaration,
      {
        preserveFocus: true,
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      },
      () => host.navigationRevision === revision,
    );
    if (host.navigationRevision !== revision) return;
  }

  if (target !== undefined && graph !== undefined) {
    followed = true;
    await followNavigationTarget(host, target);
  }

  if (!followed) {
    void vscode.window.showInformationMessage(
      `Verdog: ${entry.entity.slice(0, -1)} ${entry.id} has no available declaration or canvas target.`,
    );
  }
}

export { cliCommand };

export async function findClone(): Promise<string | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    try {
      await fs.access(path.join(root, "project.json"));
      return root;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function isEditable(host: HostState): boolean {
  return (
    vscode.workspace.isTrusted &&
    host.preview === undefined &&
    (host.access === undefined || !host.access.installed || host.access.write)
  );
}

/** Apply Verdog's ownership boundary to whichever ordinary file editor is active. */
export async function syncActiveEditorReadonly(host: OpenHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (
    host.preview !== undefined ||
    host.snapshot === undefined ||
    editor === undefined ||
    editor.document.uri.scheme !== "file"
  ) return;

  const uri = editor.document.uri;
  const key = uri.toString();
  const readonly = projectFileReadonly(host.root, uri.fsPath, host.snapshot);
  if (readonly === undefined || (!readonly && !host.protectedDocuments.has(key))) return;

  const command = readonly
    ? "workbench.action.files.setActiveEditorReadonlyInSession"
    : "workbench.action.files.resetActiveEditorReadonlyInSession";
  try {
    await vscode.commands.executeCommand(command);
    if (readonly) host.protectedDocuments.add(key);
    else host.protectedDocuments.delete(key);
  } catch (error) {
    host.output.appendLine(`${command} failed for ${uri.fsPath}: ${String(error)}`);
  }
}

export function locate(
  host: OpenHost,
  subroutineId: string,
): { root: string; subroutine: GraphId } {
  return subroutineFile(host.root, subroutineId, host.snapshot?.pinned ?? {});
}

type PythonExtension = {
  environments: {
    updateActiveEnvironmentPath(environment: string, resource?: vscode.Uri): Promise<void>;
  };
};

/** Point editor analysis at the isolated environment of the active workflow. */
export async function selectWorkflowEnvironment(
  host: OpenHost,
  workflow: WorkflowContext,
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const owner = locate(host, workflow.ownerGraph).root;
  const select = async () => {
    let environment: string;
    try {
      environment = await directProjectPath(
        owner,
        `.verdog/environments/${workflow.id}`,
      );
      await Promise.all([
        fs.access(path.join(environment, ".verdog-environment.json")),
        fs.access(path.join(
          environment,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        )),
      ]);
    } catch (error) {
      host.output.appendLine(
        `workflow ${workflow.id} editor environment is unavailable: ${String(error)}; run verdog sync`,
      );
      return;
    }
    try {
      const extension = vscode.extensions.getExtension<PythonExtension>("ms-python.python");
      if (extension === undefined) return;
      const python = extension.isActive ? extension.exports : await extension.activate();
      await python.environments.updateActiveEnvironmentPath(
        environment,
        vscode.Uri.file(host.root),
      );
    } catch (error) {
      host.output.appendLine(
        `selecting workflow ${workflow.id} editor environment failed: ${String(error)}`,
      );
    }
  };
  host.workflowEnvironmentSelection = host.workflowEnvironmentSelection.then(select, select);
  await host.workflowEnvironmentSelection;
}

export async function editSubroutine(
  host: OpenHost,
  subroutineId: string,
  describe: string,
  change: (
    project: mutate.Project,
    subroutine: GraphId,
  ) =>
    | { files?: mutate.AuthoredFileEdit[]; project: mutate.Project; report?: string }
    | undefined
    | Promise<
      { files?: mutate.AuthoredFileEdit[]; project: mutate.Project; report?: string } | undefined
    >,
): Promise<boolean> {
  const at = locate(host, subroutineId);
  if (!isEditable(host)) {
    void vscode.window.showWarningMessage("Verdog: this project is read-only.");
    return false;
  }

  const file = vscode.Uri.file(path.join(at.root, "project.json"));
  const document = await vscode.workspace.openTextDocument(file);
  const originalText = document.getText();
  const originalVersion = document.version;
  let before: mutate.Project;
  let next: { files?: mutate.AuthoredFileEdit[]; project: mutate.Project; report?: string };
  try {
    before = JSON.parse(originalText) as mutate.Project;
    const changed = await change(before, at.subroutine);
    if (changed === undefined) return false;
    next = changed;
  } catch (error) {
    void vscode.window.showWarningMessage(`Verdog: ${String(error).replace(/^Error: /, "")}`);
    return false;
  }
  const authoredPaths = new Set<string>();
  for (const edit of next.files ?? []) {
    if (edit.kind === "rename") {
      authoredPaths.add(edit.from);
      authoredPaths.add(edit.to);
    } else {
      authoredPaths.add(edit.path);
    }
  }
  const resolvedPaths = new Map<string, string>();
  try {
    for (const relative of authoredPaths) {
      resolvedPaths.set(relative, await directProjectPath(at.root, relative));
    }
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Verdog: ${String(error).replace(/^Error: /, "")}. No files were changed.`,
    );
    return false;
  }
  const authoredUri = (relative: string): vscode.Uri => {
    const resolved = resolvedPaths.get(relative);
    if (resolved === undefined) throw new Error(`authored path was not preflighted: ${relative}`);
    return vscode.Uri.file(resolved);
  };
  const exists = async (relative: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(authoredUri(relative));
      return true;
    } catch {
      return false;
    }
  };
  for (const edit of next.files ?? []) {
    const destination = edit.kind === "require_absent"
      ? edit.path
      : edit.kind === "rename"
        ? edit.to
        : undefined;
    if (destination !== undefined && await exists(destination)) {
      void vscode.window.showWarningMessage(
        `Verdog: ${destination} already exists, so it was not overwritten.`,
      );
      return false;
    }
    if (edit.kind === "rename" && !(await exists(edit.from))) {
      void vscode.window.showWarningMessage(
        `Verdog: ${edit.from} is missing, so it could not be moved. Start fresh instead.`,
      );
      return false;
    }
  }
  const trashed: string[] = [];
  const dirtyWithin = (relative: string): vscode.TextDocument | undefined => {
    const target = authoredUri(relative).fsPath;
    return vscode.workspace.textDocuments.find((candidate) => {
      if (!candidate.isDirty || candidate.uri.scheme !== "file") return false;
      const within = path.relative(target, candidate.uri.fsPath);
      return within === "" || (
        !path.isAbsolute(within) && within !== ".." && !within.startsWith(`..${path.sep}`)
      );
    });
  };
  const stopIfDirty = (relative: string): boolean => {
    const dirty = dirtyWithin(relative);
    if (dirty === undefined) return false;
    const shown = path.relative(at.root, dirty.uri.fsPath);
    void vscode.window.showWarningMessage(
      `Verdog: ${shown} has unsaved changes, so deletion stopped before moving ${relative} ` +
        "to Trash. Save or discard those changes, then review the deletion again." +
        (trashed.length === 0
          ? ""
          : ` Recover already trashed paths first: ${trashed.join(", ")}.`),
    );
    return true;
  };
  for (const edit of next.files ?? []) {
    if (edit.kind === "delete" && stopIfDirty(edit.path)) return false;
  }
  const stopIfStale = (): boolean => {
    if (document.version === originalVersion && document.getText() === originalText) return false;
    void vscode.window.showWarningMessage(
      "Verdog: project.json changed after this edit was planned, so it was not overwritten. " +
        (trashed.length === 0
          ? "No files were moved to Trash; review the edit again."
          : `Recover ${trashed.join(", ")} from the OS trash before retrying.`),
    );
    return true;
  };
  for (const edit of next.files ?? []) {
    if (edit.kind !== "delete") continue;
    if (stopIfDirty(edit.path)) return false;
    if (stopIfStale()) return false;
    try {
      await vscode.workspace.fs.delete(
        authoredUri(edit.path),
        { recursive: true, useTrash: true },
      );
      trashed.push(edit.path);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") continue;
      void vscode.window.showWarningMessage(
        `Verdog: ${edit.path} could not be moved to the OS trash, so the graph was not edited. ` +
          (trashed.length === 0
            ? ""
            : `Already trashed paths are recoverable: ${trashed.join(", ")}. `) +
          String(error),
      );
      return false;
    }
  }
  if (stopIfStale()) return false;
  const recovery = trashed.length === 0
    ? ""
    : ` Recover ${trashed.join(", ")} from the OS trash before retrying.`;
  const edited = new vscode.WorkspaceEdit();
  edited.replace(
    file,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    mutate.serialize(next.project),
  );
  for (const edit of next.files ?? []) {
    if (edit.kind === "rename") {
      edited.renameFile(
        authoredUri(edit.from),
        authoredUri(edit.to),
        { overwrite: false },
      );
    }
  }
  if (!(await vscode.workspace.applyEdit(edited))) {
    void vscode.window.showErrorMessage(
      `Verdog: project.json could not be edited.${recovery}`,
    );
    return false;
  }
  if (!(await document.save())) {
    void vscode.window.showErrorMessage(
      `Verdog: project.json could not be saved.${recovery}`,
    );
    return false;
  }
  if (graphHash(before) !== graphHash(next.project)) await generate(host, at.root);
  await refresh(host);
  for (const edit of next.files ?? []) {
    if (edit.kind === "delete" && trashed.includes(edit.path)) {
      host.output.appendLine(`moved ${edit.path} to the OS trash`);
    }
    if (edit.kind === "rename") host.output.appendLine(`moved ${edit.from} → ${edit.to}`);
  }
  host.output.appendLine(`${describe}${next.report ? ` (${next.report})` : ""}`);
  return true;
}

/** Project graph edits locally; verification remains the explicit `check` command. */
export async function generate(host: OpenHost, root: string): Promise<boolean> {
  const result = await runVerdogCommand(root, ["generate"], {
    announce: false,
    output: host.output,
    streamOutput: false,
    trust: "caller-verified",
  });
  const output = result.combined.trim();
  if (output) host.output.appendLine(output);
  if (result.code !== 0) {
    void vscode.window.showWarningMessage(
      "Verdog: the graph was saved but its generated files could not be refreshed. " +
        "See the Verdog output.",
    );
  }
  return result.code === 0;
}

export async function readAccess(host: OpenHost): Promise<void> {
  const result = await runVerdogCommand(host.root, ["access", "--json"], {
    announce: false,
    output: host.output,
    streamOutput: false,
    structured: true,
    trust: "caller-verified",
  });
  if (result.code !== 0) {
    host.access = undefined;
    host.output.appendLine(
      "verdog access could not be asked, so the canvas stays editable and the push " +
        `decides: ${result.combined.trim()}`,
    );
    return;
  }
  try {
    const answer = JSON.parse(result.stdout) as {
      installed?: unknown;
      may_write?: unknown;
      repository?: unknown;
      seat?: unknown;
    };
    host.access = {
      installed: answer.installed !== false,
      repository: typeof answer.repository === "string" ? answer.repository : "",
      seat: answer.seat === true,
      write: answer.may_write === true,
    };
    if (!host.access.installed) {
      host.output.appendLine(
        `Verdog cannot see ${host.access.repository}, and does not need to: nothing is ` +
          "installed until you publish, and `check` needs no repository access at all.",
      );
    } else if (!host.access.write) {
      host.output.appendLine(
        `You have read access to ${host.access.repository}, so the canvas is read-only.`,
      );
    }
    if (!host.access.seat) {
      host.output.appendLine("This account has no Verdog seat, so `check` will be refused.");
    }
  } catch {
    host.access = undefined;
    host.output.appendLine("verdog access returned something unreadable; leaving the canvas editable.");
  }
}

function idsIn(project: unknown): GraphId[] {
  return subroutinesIn(project).map((body) => body.id);
}

export function subroutineIds(host: HostState): GraphId[] {
  return idsIn(host.snapshot?.project);
}

export async function chooseSubroutine(host: HostState): Promise<GraphId | undefined> {
  const found = subroutineIds(host);
  if (found.length <= 1) return found[0];
  return vscode.window.showQuickPick(found, { title: "Which subroutine?" });
}

export async function chooseSubroutineIn(root: string): Promise<GraphId | undefined> {
  let found: GraphId[];
  try {
    found = idsIn((await readClone(root)).project);
  } catch (error) {
    void vscode.window.showWarningMessage(`${root} could not be read: ${String(error)}`);
    return undefined;
  }
  if (found.length <= 1) return found[0];
  return vscode.window.showQuickPick(found, { title: `Which subroutine in ${path.basename(root)}?` });
}

export function projectOf(host: HostState, subroutineId: string): Record<string, unknown> {
  if (host.snapshot === undefined) return {};
  return projectIn(host.snapshot, subroutineId).project as unknown as Record<string, unknown>;
}

export function entities(
  host: OpenHost,
  subroutine: string,
  kind: mutate.Entity,
): Record<string, unknown>[] {
  const found =
    host.snapshot === undefined ? undefined : subroutineIn(host.snapshot, subroutine)?.[kind];
  return Array.isArray(found) ? (found as Record<string, unknown>[]) : [];
}

export async function refresh(host: OpenHost): Promise<ProjectSnapshot | undefined> {
  const revision = ++host.refreshRevision;
  host.termination?.suspend();
  let snapshot: ProjectSnapshot;
  try {
    snapshot = await readClone(host.root);
  } catch (error) {
    if (revision !== host.refreshRevision) return host.snapshot;
    host.termination?.unavailable("The saved project could not be read.");
    void vscode.window.showErrorMessage(
      `Verdog: project.json could not be read: ${String(error)}`,
    );
    return undefined;
  }
  if (revision !== host.refreshRevision) return host.snapshot;
  host.snapshot = snapshot;
  host.termination ??= new TerminationAnalysis(
    (signal) => runVerdogCommand(host.root, ["analyze", "--json"], {
      announce: false,
      output: host.output,
      signal,
      streamOutput: false,
      structured: true,
      trust: "caller-verified",
    }),
    (termination) => {
      if (host.snapshot === undefined) return;
      host.snapshot.termination = termination;
      publishSnapshot(host);
    },
  );
  const termination = host.termination.update(Object.fromEntries([
    ["", snapshot.graph_hash],
    ...Object.entries(snapshot.pinned).map(([owner, project]) => [owner, graphHash(project)]),
  ]));
  if (termination !== undefined) snapshot.termination = termination;
  if (host.preview !== undefined && host.preview.workflow) {
    const definition = definitionIn(host.snapshot.project, "workflow", host.preview.workflow);
    if (definition?.target !== undefined) {
      host.snapshot.initial_scope = definitionKey("workflow", definition.id);
    }
  }
  host.snapshot.editable = isEditable(host);
  if (host.verdict !== undefined && host.verdict.graphHash === host.snapshot.graph_hash) {
    host.snapshot.checked = true;
    host.snapshot.diagnostic_count = host.verdict.diagnostics.length;
  } else if (host.verdict !== undefined) {
    host.verdict = undefined;
    host.problems.clear();
  }
  publishSnapshot(host);
  if (host.view !== undefined) {
    host.view.description =
      host.preview === undefined
        ? `${packageDirectory(host.snapshot.project.package)} · ${host.snapshot.graph_hash.slice(0, 12)}${
            isStale(host.snapshot) ? " · stale" : ""
          }`
        : `${host.preview.repository} · ${host.preview.commit.slice(0, 12)} · read-only`;
  }
  await syncActiveEditorReadonly(host);
  return host.snapshot;
}

function publishSnapshot(host: HostState): void {
  if (host.snapshot === undefined) return;
  void host.view?.webview.postMessage({
    kind: "snapshot", navigationVersion: host.canvasNavigationVersion, snapshot: host.snapshot,
  } satisfies HostToCanvas);
  host.snapshotChanged?.();
}

function publish(host: HostState, root: string, diagnostics: CliDiagnostic[]): void {
  host.problems.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const item of diagnostics) {
    const file = item.file ?? path.join(root, "project.json");
    const entry = new vscode.Diagnostic(
      new vscode.Range(...diagnosticRange(item)),
      item.message,
      item.severity === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Error,
    );
    entry.source = "verdog";
    if (item.code) entry.code = item.code;
    const existing = byFile.get(file) ?? [];
    existing.push(entry);
    byFile.set(file, existing);
  }
  for (const [file, entries] of byFile) host.problems.set(vscode.Uri.file(file), entries);
}

export async function runVerb(
  host: OpenHost,
  root: string,
  verb: "check" | "run" | "sync",
  arguments_: readonly string[] = [],
): Promise<void> {
  const structured = verb === "check";
  const result = await runVerdogCommand(
    root,
    structured ? [verb, "--json"] : [verb, ...arguments_],
    {
      output: host.output,
      progress: { location: vscode.ProgressLocation.Window, title: `verdog ${verb}` },
      structured,
      trust: "required",
    },
  );
  if (result === undefined) return;

  if (structured) {
    const verdict = parseVerdict(result.stdout, root);
    // A pinned check populates Problems but cannot mark the parent snapshot as checked.
    host.verdict = root === host.root ? verdict : undefined;
    if (verdict === undefined) {
      host.output.appendLine(result.combined.trim() || "verdog check produced no output.");
    } else {
      host.output.appendLine(
        `${verdict.diagnostics.length} diagnostic(s) for graph ${verdict.graphHash.slice(0, 12)}.`,
      );
      publish(host, root, verdict.diagnostics);
      if (root === host.root && host.snapshot !== undefined) {
        host.snapshot.diagnostic_count = verdict.diagnostics.length;
        host.snapshot.checked = true;
        if (host.view !== undefined) {
          void host.view.webview.postMessage({
            kind: "snapshot",
            navigationVersion: host.canvasNavigationVersion,
            snapshot: host.snapshot,
          } satisfies HostToCanvas);
        }
      }
    }
  }
  if (verb === "check") {
    if (host.preview === undefined) await readAccess(host);
    await refresh(host);
  }
  if (result.code !== 0) {
    void vscode.window.showWarningMessage(
      `verdog ${verb} reported problems. See the Verdog output and the Problems panel.`,
    );
  }
}
