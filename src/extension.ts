/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as vscode from 'vscode';

import {registerCanvas, showCanvas} from './canvasView';
import {initializeBackend} from './backend';
import {registerCatalogue, registerPreviewCommands} from './catalogueView';
import {readPreview} from './checkout';
import {REVEAL_CANVAS, newProject} from './newProject';
import {registerProjectCommands} from './projectActions';
import {registerRunHistory} from './runHistoryView';
import {definitionIndex, definitionKey} from '../model/project';
import {
  cliCommand,
  findClone,
  hasProject,
  refresh,
  selectWorkflowEnvironment,
  syncActiveEditorReadonly,
  type HostState,
} from './projectHost';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  initializeBackend(context);
  const output = vscode.window.createOutputChannel('Verdog');
  const problems = vscode.languages.createDiagnosticCollection('verdog');
  context.subscriptions.push(output, problems);

  context.subscriptions.push(
    vscode.commands.registerCommand('verdog.newProject', () =>
      newProject(context, cliCommand()),
    ),
  );

  const root = await findClone();
  const preview =
    root === undefined
      ? undefined
      : await readPreview(
          root,
          context.globalStorageUri,
          vscode.workspace.workspaceFile,
        );
  const host: HostState = {
    access: undefined,
    canvasNavigationVersion: 0,
    canvasReady: false,
    extension: context.extensionUri,
    navigationRevision: 0,
    refreshRevision: 0,
    output,
    pendingReveal: undefined,
    preview,
    problems,
    protectedDocuments: new Set(),
    root,
    showingSubroutine: undefined,
    workflowEnvironmentSelection: Promise.resolve(),
    snapshot: undefined,
    verdict: undefined,
    view: undefined,
  };
  context.subscriptions.push({dispose: () => host.termination?.dispose()});

  await vscode.commands.executeCommand(
    'setContext',
    'verdog.preview',
    preview !== undefined,
  );
  context.subscriptions.push(
    ...registerCatalogue(context, host),
    ...registerCanvas(host, context.extensionUri),
    ...registerRunHistory(host),
  );

  if (context.globalState.get(REVEAL_CANVAS)) {
    await context.globalState.update(REVEAL_CANVAS, false);
    void showCanvas(host);
  }

  if (!hasProject(host)) {
    return;
  }
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => void refresh(host)),
  );
  if (host.preview !== undefined) {
    await refresh(host);
    await showCanvas(host);
    context.subscriptions.push(...registerPreviewCommands(host));
    return;
  }

  const snapshot = await refresh(host);
  const rootWorkflow =
    snapshot === undefined
      ? undefined
      : definitionIndex(snapshot.project).rootWorkflow;
  if (snapshot !== undefined && rootWorkflow !== undefined) {
    await selectWorkflowEnvironment(host, {
      id: rootWorkflow,
      ownerGraph: snapshot.project.subroutine.id,
      scope: definitionKey('workflow', rootWorkflow),
    });
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(
      () => void syncActiveEditorReadonly(host),
    ),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      host.root,
      '{project.json,external/**/project.json}',
    ),
  );
  watcher.onDidChange(() => void refresh(host));
  watcher.onDidCreate(() => void refresh(host));
  watcher.onDidDelete(() => void refresh(host));
  context.subscriptions.push(watcher, ...registerProjectCommands(host));

  for (const entry of (process.env.VERDOG_COMMANDS ?? '')
    .split(';')
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    const argument =
      separator < 0 ? undefined : entry.slice(separator + 1).trim();
    await vscode.commands.executeCommand(
      id,
      argument ? (JSON.parse(argument) as unknown) : undefined,
    );
  }
}

export function deactivate(): void {}
