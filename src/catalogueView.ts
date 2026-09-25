/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as path from 'node:path';
import {constants as fsConstants} from 'node:fs';
import {access as accessFile} from 'node:fs/promises';

import * as vscode from 'vscode';

import {
  checkoutRoot,
  configurePreviewWorkspace,
  lockPreview,
  materialise,
  preparePreviewEnvironment,
  openPreviewWorkspace,
  readInspectionState,
  readMarker,
  previewWorkspace,
  writeInspectionState,
} from './checkout';
import {fetchCatalogueReadme} from './catalogueMetadata';
import {
  catalogueImportReceiptMatches,
  decodeCatalogueImportReceipt,
} from './catalogueReceipt';
import {
  catalogueSyncPaths,
  decodeCatalogueSyncReceipt,
} from './catalogueSyncReceipt';
import {catalogueTargetEligible} from './catalogueTargets';
import type {Outcome} from './cli';
import {backendCommand as verdog} from './verdogCommand';
import {
  chooseSubroutineIn,
  cliCommand,
  isEditable,
  refresh,
  runVerb,
  type HostState,
  type OpenHost,
} from './projectHost';
import {webviewHtml} from './webviewHtml';
import {
  catalogueMetadataDifferences,
  catalogueMetadataKey,
  decodeCatalogueDescriptor,
  decodeCatalogueDetail,
  decodeCatalogueListing,
  type CatalogueDetail,
  type CatalogueInspection,
  type CatalogueListing,
  type CatalogueRecord,
  type CatalogueRelease,
  type CatalogueSummary,
} from '../model/catalogue';
import {packageProblem} from '../model/names';
import type {CatalogueToHost, HostToCatalogue} from '../model/protocol';

const REFUSED = [
  'verdog.check',
  'verdog.access',
  'verdog.addNode',
  'verdog.addDefinition',
  'verdog.addCall',
  'verdog.addFeature',
  'verdog.addProfile',
  'verdog.addSession',
  'verdog.deleteEntity',
  'verdog.connect',
  'verdog.constrain',
];

interface CatalogueQuery {
  cursor?: string;
  query?: string;
  visibility?: 'all' | 'mine' | 'public' | 'restricted';
}

interface CliFailure {
  code?: string;
  message: string;
}

function cliFailure(outcome: Outcome): CliFailure {
  for (const candidate of [outcome.stdout, outcome.stderr]) {
    try {
      const raw = JSON.parse(candidate) as Record<string, unknown>;
      const error = raw.error;
      if (
        error !== null &&
        typeof error === 'object' &&
        !Array.isArray(error)
      ) {
        const item = error as Record<string, unknown>;
        if (typeof item.message === 'string') {
          return {
            ...(typeof item.code === 'string' ? {code: item.code} : {}),
            message: item.message,
          };
        }
      }
    } catch {
      // Human-mode and legacy commands are reported from their final non-empty line below.
    }
  }
  const last = outcome.combined.trim().split('\n').filter(Boolean).at(-1);
  return {message: last ?? 'The command produced no diagnostic.'};
}

function authenticationFailure(code: string | undefined): boolean {
  return (
    code !== undefined &&
    /(?:auth|login|credential|token|principal)/i.test(code)
  );
}

async function catalogueOutcome(
  root: string,
  query: CatalogueQuery,
  interactive: boolean,
): Promise<Outcome> {
  const args = ['catalogue', '--json'];
  if (query.query) {
    args.push('--query', query.query);
  }
  if (query.visibility && query.visibility !== 'all') {
    args.push('--visibility', query.visibility);
  }
  if (query.cursor) {
    args.push('--cursor', query.cursor);
  }
  if (args.length > 2) {
    args.push('--limit', '50');
  }
  return verdog(root, args, {command: cliCommand(), interactive});
}

async function readCatalogue(
  host: HostState,
  query: CatalogueQuery = {},
  interactive = true,
): Promise<CatalogueListing> {
  const root =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const listed = await catalogueOutcome(root, query, interactive);
  if (listed.code !== 0) {
    const failure = cliFailure(listed);
    host.output.appendLine(
      listed.combined.trim() || 'verdog catalogue produced no output.',
    );
    return {
      detail: failure.message,
      entries: [],
      state:
        listed.code === 127
          ? 'unavailable'
          : authenticationFailure(failure.code)
            ? 'unauthenticated'
            : 'unavailable',
    };
  }
  try {
    const {entries, login, next_cursor, rejected} = decodeCatalogueListing(
      JSON.parse(listed.stdout),
    );
    for (const problem of rejected) {
      host.output.appendLine(`catalogue ignored ${problem}`);
    }
    return {
      entries,
      ...(login === undefined ? {} : {login}),
      ...(next_cursor === undefined ? {} : {next_cursor}),
      state: entries.length === 0 ? 'empty' : 'listed',
    };
  } catch (error) {
    host.output.appendLine(
      `verdog catalogue returned unreadable JSON: ${String(error)}`,
    );
    return {
      detail: 'The installed CLI returned an unsupported catalogue response.',
      entries: [],
      state: 'unavailable',
    };
  }
}

async function readEntry(
  host: HostState,
  id: string,
): Promise<CatalogueDetail | undefined> {
  const root =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const result = await verdog(root, ['catalogue', '--entry', id, '--json'], {
    command: cliCommand(),
  });
  if (result.code !== 0) {
    const failure = cliFailure(result);
    host.output.appendLine(`catalogue entry ${id} failed: ${failure.message}`);
    return undefined;
  }
  try {
    return decodeCatalogueDetail(JSON.parse(result.stdout));
  } catch (error) {
    host.output.appendLine(
      `catalogue entry ${id} was invalid: ${String(error)}`,
    );
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file));
    return true;
  } catch {
    return false;
  }
}

async function availableInterpreter(
  root: string,
  workflow: string,
): Promise<string | undefined> {
  const candidate = catalogueSyncPaths(root, workflow).interpreter;
  return (await exists(candidate)) ? candidate : undefined;
}

function previewOf(host: HostState, detail: CatalogueDetail) {
  const origin = host.preview === undefined ? host.root : host.preview.origin;
  return {
    commit: detail.commit,
    ...(origin === undefined ? {} : {origin}),
    repository: detail.repository,
    workflow: detail.workflow_id,
  };
}

class CatalogueRecordPanel {
  private panel: vscode.WebviewPanel | undefined;
  private record: CatalogueRecord = {
    documentation: {state: 'loading'},
    inspection: {state: 'idle'},
    requested: '',
    state: 'loading',
  };
  private releases: CatalogueRelease[] = [];
  private revision = 0;
  private readmeAbort: AbortController | undefined;
  private inspectionAbort: AbortController | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: HostState,
  ) {}

  async open(summary: CatalogueSummary): Promise<void> {
    this.releases = summary.releases;
    this.ensurePanel(summary.display_name);
    await this.select(summary.id);
  }

  private ensurePanel(title: string): vscode.WebviewPanel {
    if (this.panel !== undefined) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'verdog.catalogueRecord',
      title,
      {preserveFocus: false, viewColumn: vscode.ViewColumn.Active},
      {
        enableFindWidget: true,
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    panel.webview.html = webviewHtml(
      panel.webview,
      this.context.extensionUri,
      'catalogue',
    );
    panel.onDidDispose(() => {
      if (this.panel !== panel) {
        return;
      }
      this.panel = undefined;
      this.readmeAbort?.abort();
      this.inspectionAbort?.abort();
    });
    panel.webview.onDidReceiveMessage(
      (message: CatalogueToHost) => void this.receive(message),
    );
    return panel;
  }

  private post(): void {
    void this.panel?.webview.postMessage({
      kind: 'record',
      record: this.record,
    } satisfies HostToCatalogue);
  }

  private async cachedInspection(
    detail: CatalogueDetail,
  ): Promise<CatalogueInspection> {
    const preview = previewOf(this.host, detail);
    const cached = checkoutRoot(
      this.context.globalStorageUri.fsPath,
      preview.repository,
      preview.commit,
      preview.workflow,
    );
    const state = await readInspectionState(cached, preview);
    if (state === undefined) {
      return {state: 'idle'};
    }
    if (state.catalogue !== catalogueMetadataKey(detail)) {
      return {
        detail:
          'Catalogue metadata changed after this cached inspection; inspect the release again.',
        folder: cached,
        state: 'incomplete',
      };
    }
    if (state.metadata === 'mismatch') {
      return {
        detail: 'Published metadata does not match the exact source.',
        folder: cached,
        state: 'mismatch',
      };
    }
    if (
      state.dependencies === 'ready' &&
      state.metadata === 'ready' &&
      state.environment === 'ready' &&
      (await availableInterpreter(cached, detail.workflow_id)) !== undefined
    ) {
      return {folder: cached, state: 'ready'};
    }
    return {
      detail: 'Inspection was interrupted or the environment is incomplete.',
      folder: cached,
      state: 'incomplete',
    };
  }

  private async select(id: string): Promise<void> {
    const revision = ++this.revision;
    this.readmeAbort?.abort();
    this.inspectionAbort?.abort();
    this.record = {
      documentation: {state: 'loading'},
      inspection: {state: 'idle'},
      requested: id,
      state: 'loading',
    };
    this.post();
    const detail = await readEntry(this.host, id);
    if (revision !== this.revision) {
      return;
    }
    if (detail === undefined) {
      this.record = {
        documentation: {
          detail: 'Documentation was not requested.',
          state: 'unavailable',
        },
        inspection: {state: 'idle'},
        message:
          'This exact catalogue release is unavailable or no longer visible.',
        requested: id,
        state: 'unavailable',
      };
      this.post();
      return;
    }
    const merged = new Map(this.releases.map(release => [release.id, release]));
    for (const release of detail.releases) {
      merged.set(release.id, release);
    }
    this.releases = [...merged.values()].sort(
      (left, right) =>
        Date.parse(right.published_at) - Date.parse(left.published_at),
    );
    detail.releases = this.releases;
    this.panel!.title = detail.display_name;
    this.record = {
      detail,
      documentation: {state: 'loading'},
      inspection: await this.cachedInspection(detail),
      requested: id,
      state: 'ready',
    };
    this.post();
    await this.loadReadme(revision);
  }

  private async loadReadme(revision = this.revision): Promise<void> {
    const detail = this.record.detail;
    if (detail === undefined) {
      return;
    }
    this.readmeAbort?.abort();
    const controller = new AbortController();
    this.readmeAbort = controller;
    this.record = {...this.record, documentation: {state: 'loading'}};
    this.post();
    const documentation = await fetchCatalogueReadme(
      this.context.globalStorageUri,
      detail,
      controller.signal,
      line => this.host.output.appendLine(line),
    );
    if (revision !== this.revision || controller.signal.aborted) {
      return;
    }
    this.record = {...this.record, documentation};
    this.post();
  }

  private updateInspection(inspection: CatalogueInspection): void {
    this.record = {...this.record, inspection};
    this.post();
  }

  private async inspect(): Promise<void> {
    const detail = this.record.detail;
    if (detail === undefined || this.record.inspection.state === 'running') {
      return;
    }
    const revision = this.revision;
    const preview = previewOf(this.host, detail);
    this.inspectionAbort?.abort();
    const controller = new AbortController();
    this.inspectionAbort = controller;
    await vscode.window.withProgress(
      {
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: `Inspecting ${detail.repository}@${detail.commit.slice(0, 12)}`,
      },
      async (progress, token) => {
        const cancellation = token.onCancellationRequested(() =>
          controller.abort(),
        );
        const phase = (label: string): void => {
          progress.report({message: label});
          if (revision === this.revision) {
            this.updateInspection({
              detail: label,
              phase: label,
              state: 'running',
            });
          }
        };
        let root: string | undefined;
        try {
          const checkout = await materialise(
            this.context.globalStorageUri,
            preview,
            line => this.host.output.appendLine(line),
            {phase, signal: controller.signal},
          );
          if (revision !== this.revision) {
            return;
          }
          if (checkout === undefined) {
            this.updateInspection({
              detail: controller.signal.aborted
                ? 'Inspection was cancelled.'
                : 'The exact source could not be fetched. See the Verdog output.',
              state: 'incomplete',
            });
            return;
          }
          root = checkout.folder.fsPath;
          if (checkout.dependencies !== 'ready') {
            await this.finishIncomplete(
              root,
              preview,
              'Pinned dependencies could not all be fetched.',
              'unchecked',
            );
            return;
          }

          phase('Verifying published metadata');
          const described = await verdog(
            root,
            ['describe', detail.workflow_id, '--json'],
            {
              command: cliCommand(),
              onLine: line => this.host.output.appendLine(line),
              signal: controller.signal,
            },
          );
          if (described.code !== 0) {
            await this.finishIncomplete(
              root,
              preview,
              controller.signal.aborted
                ? 'Inspection was cancelled.'
                : `Source metadata could not be verified: ${cliFailure(described).message}`,
              'unchecked',
            );
            return;
          }
          let differences: string[];
          try {
            differences = catalogueMetadataDifferences(
              detail,
              decodeCatalogueDescriptor(JSON.parse(described.stdout)),
            );
          } catch (error) {
            await this.finishIncomplete(
              root,
              preview,
              `Source metadata was unreadable: ${String(error)}`,
              'unchecked',
            );
            return;
          }
          if (differences.length > 0) {
            await writeInspectionState(root, {
              catalogue: catalogueMetadataKey(detail),
              dependencies: 'ready',
              environment: 'incomplete',
              metadata: 'mismatch',
              preview,
              source: 'ready',
              version: 1,
            });
            await lockPreview(root, line => this.host.output.appendLine(line));
            await configurePreviewWorkspace(
              this.context.globalStorageUri,
              root,
              preview,
              undefined,
            );
            this.updateInspection({
              detail: `Published metadata differs from source: ${differences.join(', ')}.`,
              folder: root,
              state: 'mismatch',
            });
            return;
          }

          phase('Preparing the selected workflow environment');
          const environmentWritable = await preparePreviewEnvironment(
            root,
            line => this.host.output.appendLine(line),
            controller.signal,
          );
          if (!environmentWritable) {
            await this.finishIncomplete(
              root,
              preview,
              controller.signal.aborted
                ? 'Inspection was cancelled.'
                : 'The managed editor environment could not be prepared safely. See the Verdog output.',
              'ready',
            );
            return;
          }
          const synced = await verdog(
            root,
            ['sync', detail.workflow_id, '--only-binary', '--json'],
            {
              command: cliCommand(),
              onLine: line => this.host.output.appendLine(line),
              signal: controller.signal,
            },
          );
          const receipt =
            synced.code === 0
              ? decodeCatalogueSyncReceipt(synced.stdout, {
                  checkout: root,
                  workflow: detail.workflow_id,
                })
              : undefined;
          const interpreter =
            receipt !== undefined && (await exists(receipt.interpreter))
              ? receipt.interpreter
              : undefined;
          if (synced.code !== 0 || interpreter === undefined) {
            const why = controller.signal.aborted
              ? 'Inspection was cancelled.'
              : synced.code === 0
                ? receipt === undefined
                  ? 'The CLI returned an invalid selected-workflow environment receipt.'
                  : 'The selected workflow environment contains no Python interpreter.'
                : `The wheel-only environment could not be prepared: ${cliFailure(synced).message}`;
            await this.finishIncomplete(root, preview, why, 'ready');
            return;
          }
          await writeInspectionState(root, {
            catalogue: catalogueMetadataKey(detail),
            dependencies: 'ready',
            environment: 'ready',
            metadata: 'ready',
            preview,
            source: 'ready',
            version: 1,
          });
          await configurePreviewWorkspace(
            this.context.globalStorageUri,
            root,
            preview,
            interpreter,
          );
          await lockPreview(root, line => this.host.output.appendLine(line));
          if (revision !== this.revision) {
            return;
          }
          this.updateInspection({folder: root, state: 'ready'});
          await this.openSource();
        } finally {
          cancellation.dispose();
          if (root !== undefined) {
            await lockPreview(root, line => this.host.output.appendLine(line));
          }
          if (this.inspectionAbort === controller) {
            this.inspectionAbort = undefined;
          }
        }
      },
    );
  }

  private async finishIncomplete(
    root: string,
    preview: ReturnType<typeof previewOf>,
    detail: string,
    metadata: 'ready' | 'unchecked',
  ): Promise<void> {
    this.host.output.appendLine(`inspection incomplete: ${detail}`);
    const previous = await readInspectionState(root, preview);
    await writeInspectionState(root, {
      ...(this.record.detail === undefined
        ? {}
        : {catalogue: catalogueMetadataKey(this.record.detail)}),
      dependencies: previous?.dependencies ?? 'incomplete',
      environment: 'incomplete',
      metadata,
      preview,
      source: 'ready',
      version: 1,
    });
    await configurePreviewWorkspace(
      this.context.globalStorageUri,
      root,
      preview,
      undefined,
    );
    this.updateInspection({detail, folder: root, state: 'incomplete'});
  }

  private async openSource(): Promise<void> {
    const detail = this.record.detail;
    const folder =
      'folder' in this.record.inspection
        ? this.record.inspection.folder
        : undefined;
    if (detail === undefined || folder === undefined) {
      return;
    }
    const preview = previewOf(this.host, detail);
    const interpreter =
      this.record.inspection.state === 'ready'
        ? await availableInterpreter(folder, detail.workflow_id)
        : undefined;
    const workspace = await configurePreviewWorkspace(
      this.context.globalStorageUri,
      folder,
      preview,
      interpreter,
    );
    this.host.output.appendLine(
      `opening inspected release from ${workspace.fsPath}`,
    );
    try {
      await openPreviewWorkspace(this.context, workspace, folder);
    } catch (error) {
      this.host.output.appendLine(
        `opening the inspected workspace failed: ${String(error)}`,
      );
      const answer = await vscode.window.showErrorMessage(
        'Could not open the inspected source in another window.',
        'Copy path',
      );
      if (answer === 'Copy path') {
        await vscode.env.clipboard.writeText(folder);
      }
    }
  }

  private async import(): Promise<void> {
    const detail = this.record.detail;
    if (detail === undefined || this.record.inspection.state !== 'ready') {
      void vscode.window.showInformationMessage(
        'Inspect this exact release successfully before importing it.',
      );
      return;
    }
    const root = await chooseTargetProject(this.host);
    if (root === undefined) {
      return;
    }
    if (root === this.host.root && !isEditable(this.host)) {
      void vscode.window.showWarningMessage(
        'Verdog: this project is read-only.',
      );
      return;
    }
    const into = await chooseSubroutineIn(root);
    if (into === undefined) {
      return;
    }
    const suggested =
      detail.package ?? detail.repository.replace('/', '.').toLowerCase();
    const alias = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: 'Local package alias for this pinned workflow',
      title: 'Import exact catalogue release',
      validateInput: value => packageProblem(value),
      value: suggested,
    });
    if (alias === undefined) {
      return;
    }
    const existing = await existingAlias(root, alias);
    const closure =
      detail.closure.length === 0
        ? 'No repository dependencies'
        : detail.closure
            .map(pin => `${pin.repository}@${pin.commit}`)
            .join('\n');
    const answer = await vscode.window.showWarningMessage(
      `Import ${detail.display_name} into ${path.basename(root)}?`,
      {
        detail:
          `Repository: ${detail.repository}\nWorkflow: ${detail.workflow_id}\n` +
          `Commit: ${detail.commit}\nAlias: ${alias}\nSubroutine: ${into}\n\n` +
          `Dependency closure:\n${closure}\n\n` +
          (existing
            ? `The alias ${alias} is already pinned; the CLI will refuse to overwrite it.\n\n`
            : '') +
          'This is the first step that changes your project.',
        modal: true,
      },
      'Import exact release',
    );
    if (answer !== 'Import exact release') {
      return;
    }
    this.host.output.show(true);
    const args = [
      'import',
      `${detail.repository}@${detail.commit}`,
      detail.workflow_id,
      '--into',
      into,
      '--alias',
      alias,
      '--json',
    ];
    this.host.output.appendLine(`\n$ verdog ${args.join(' ')}  (${root})`);
    const result = await verdog(root, args, {
      command: cliCommand(),
      onLine: line => this.host.output.appendLine(line),
    });
    const imported = decodeCatalogueImportReceipt(result.stdout);
    if (imported === undefined) {
      if (root === this.host.root && this.host.preview === undefined) {
        await refresh(this.host as OpenHost);
      }
      const message =
        result.code === 0
          ? 'Verdog import completed without a valid machine-readable receipt. Inspect the project and Verdog output before retrying.'
          : `Verdog import failed: ${cliFailure(result).message}`;
      void vscode.window.showWarningMessage(message);
      return;
    }
    if (
      detail.package === null ||
      !catalogueImportReceiptMatches(imported, {
        alias,
        commit: detail.commit,
        into,
        package: detail.package,
        repository: detail.repository,
        workflow_id: detail.workflow_id,
      })
    ) {
      if (root === this.host.root && this.host.preview === undefined) {
        await refresh(this.host as OpenHost);
      }
      void vscode.window.showWarningMessage(
        'Verdog import returned a receipt for an unexpected release. Inspect the project and Verdog output before continuing.',
      );
      return;
    }
    if (root === this.host.root && this.host.preview === undefined) {
      await refresh(this.host as OpenHost);
    }
    const generationFailed =
      result.code !== 0 || imported.generated_status !== 0;
    this.record = {
      ...this.record,
      message: generationFailed
        ? `Imported ${detail.workflow_id} as ${imported.alias}, but generated validation reported problems.`
        : `Imported ${detail.workflow_id} as ${imported.alias} into ${into}.`,
    };
    this.post();
    const actions =
      root === this.host.root
        ? ['Reveal binding', 'Add workflow call', 'Sync environment']
        : ['Reveal binding', 'Sync environment'];
    const next = generationFailed
      ? await vscode.window.showWarningMessage(
          `Imported ${detail.workflow_id} as ${imported.alias}, but generation reported problems. See the Verdog output.`,
          ...actions,
        )
      : await vscode.window.showInformationMessage(
          `Imported ${detail.workflow_id} as ${imported.alias}.`,
          ...actions,
        );
    if (next === 'Reveal binding') {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(root, 'project.json')),
      );
      await vscode.window.showTextDocument(document);
    } else if (next === 'Add workflow call') {
      await vscode.commands.executeCommand('verdog.addCall');
    } else if (next === 'Sync environment') {
      await syncTarget(root, this.host);
    }
  }

  private async receive(message: CatalogueToHost): Promise<void> {
    switch (message.kind) {
      case 'ready':
        this.post();
        return;
      case 'select-release':
        await this.select(message.entry);
        return;
      case 'retry-readme':
        await this.loadReadme();
        return;
      case 'inspect':
        await this.inspect();
        return;
      case 'open-source':
        await this.openSource();
        return;
      case 'show-output':
        this.host.output.show(true);
        return;
      case 'import':
        await this.import();
        return;
      case 'copy-reference': {
        const detail = this.record.detail;
        if (detail !== undefined) {
          await vscode.env.clipboard.writeText(
            `verdog import ${detail.repository}@${detail.commit} ${detail.workflow_id}`,
          );
        }
        return;
      }
      case 'open-external':
        await openExternal(message.href);
        return;
      case 'load-more':
      case 'open-record':
      case 'refresh':
      case 'search':
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }
}

async function existingAlias(root: string, alias: string): Promise<boolean> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(root, 'project.json')),
    );
    const project = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<
      string,
      unknown
    >;
    return (
      Array.isArray(project.externals) &&
      project.externals.some(
        item =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).alias === alias,
      )
    );
  } catch {
    return false;
  }
}

async function projectAt(root: string): Promise<boolean> {
  return exists(path.join(root, 'project.json'));
}

async function writableProjectAt(root: string): Promise<boolean> {
  try {
    const required = [
      root,
      path.join(root, 'project.json'),
      path.join(root, '.git'),
    ];
    const modules = path.join(root, '.gitmodules');
    if (await exists(modules)) {
      required.push(modules);
    }
    await Promise.all(
      required.map(candidate => accessFile(candidate, fsConstants.W_OK)),
    );
    return true;
  } catch {
    return false;
  }
}

async function importTarget(root: string): Promise<boolean> {
  const hasProject = await projectAt(root);
  const isPreview = hasProject && (await readMarker(root)) !== undefined;
  const writable = hasProject && (await writableProjectAt(root));
  return catalogueTargetEligible({
    hasProject,
    isPreview,
    writable,
  });
}

async function chooseTargetProject(
  host: HostState,
): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await importTarget(folder.uri.fsPath)) {
      candidates.add(folder.uri.fsPath);
    }
  }
  if (
    host.preview?.origin !== undefined &&
    (await importTarget(host.preview.origin))
  ) {
    candidates.add(host.preview.origin);
  }
  if (
    host.preview === undefined &&
    host.root !== undefined &&
    (await importTarget(host.root))
  ) {
    candidates.add(host.root);
  }
  const roots = [...candidates];
  if (roots.length === 0) {
    void vscode.window.showInformationMessage(
      'Open an editable, writable Verdog project (not an inspection preview) before importing this workflow.',
    );
    return undefined;
  }
  if (roots.length === 1) {
    return roots[0];
  }
  return (
    await vscode.window.showQuickPick(
      roots.map(root => ({
        description: root,
        label: path.basename(root),
        root,
      })),
      {title: 'Import into which Verdog project?'},
    )
  )?.root;
}

async function syncTarget(root: string, host: HostState): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'The workflow was imported, but Workspace Trust is required before Verdog installs ' +
        'its dependencies.',
    );
    return;
  }
  host.output.show(true);
  host.output.appendLine(`\n$ verdog sync  (${root})`);
  const result = await verdog(root, ['sync'], {
    command: cliCommand(),
    onLine: line => host.output.appendLine(line),
  });
  if (result.code !== 0) {
    void vscode.window.showWarningMessage(
      `Verdog sync failed: ${cliFailure(result).message}`,
    );
  }
}

async function openExternal(href: string): Promise<void> {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'https:') {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
  } catch {
    // The webview never receives command/file URI authority from an invalid link.
  }
}

class CatalogueView implements vscode.WebviewViewProvider {
  private entries: CatalogueSummary[] = [];
  private query: CatalogueQuery = {};
  private revision = 0;
  private view: vscode.WebviewView | undefined;
  private readonly record: CatalogueRecordPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: HostState,
  ) {
    this.record = new CatalogueRecordPanel(context, host);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };
    view.webview.html = webviewHtml(
      view.webview,
      this.context.extensionUri,
      'catalogue',
    );
    view.webview.onDidReceiveMessage(
      (message: CatalogueToHost) => void this.receive(message),
    );
  }

  private post(listing: CatalogueListing): void {
    void this.view?.webview.postMessage({
      kind: 'listing',
      listing,
    } satisfies HostToCatalogue);
  }

  private async load(
    query: CatalogueQuery = this.query,
    append = false,
    interactive = true,
  ): Promise<void> {
    const revision = ++this.revision;
    if (!append) {
      this.post({entries: [], state: 'loading'});
    }
    const listing = await readCatalogue(this.host, query, interactive);
    if (revision !== this.revision) {
      return;
    }
    this.query = {query: query.query, visibility: query.visibility};
    if (
      append &&
      listing.state !== 'unavailable' &&
      listing.state !== 'unauthenticated'
    ) {
      const merged = new Map(this.entries.map(entry => [entry.id, entry]));
      for (const entry of listing.entries) {
        merged.set(entry.id, entry);
      }
      this.entries = [...merged.values()];
      this.post({
        ...listing,
        entries: this.entries,
        state: this.entries.length === 0 ? 'empty' : 'listed',
      });
      return;
    }
    this.entries = listing.entries;
    this.post(listing);
  }

  private async receive(message: CatalogueToHost): Promise<void> {
    switch (message.kind) {
      case 'ready':
        await this.load(this.query, false, false);
        return;
      case 'refresh':
        await this.load();
        return;
      case 'search':
        await this.load({
          query: message.query.trim(),
          visibility: message.visibility,
        });
        return;
      case 'load-more':
        if (message.cursor) {
          await this.load({...this.query, cursor: message.cursor}, true);
        }
        return;
      case 'open-record': {
        const summary =
          this.entries.find(entry => entry.id === message.entry) ??
          this.entries.find(entry =>
            entry.releases.some(release => release.id === message.entry),
          );
        if (summary !== undefined) {
          await this.record.open(summary);
        }
        return;
      }
      case 'copy-reference':
      case 'import':
      case 'inspect':
      case 'open-external':
      case 'open-source':
      case 'retry-readme':
      case 'select-release':
      case 'show-output':
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }
}

async function folderSize(uri: vscode.Uri): Promise<number> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.File) {
      return stat.size;
    }
    const children = await vscode.workspace.fs.readDirectory(uri);
    return (
      await Promise.all(
        children.map(([name]) => folderSize(vscode.Uri.joinPath(uri, name))),
      )
    ).reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function manageCache(context: vscode.ExtensionContext): Promise<void> {
  const previewRoot = vscode.Uri.joinPath(context.globalStorageUri, 'preview');
  const choices: Array<{
    description: string;
    label: string;
    target?: vscode.Uri;
    workspace?: vscode.Uri;
  }> = [];
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(
      previewRoot,
    )) {
      if (!(type & vscode.FileType.Directory)) {
        continue;
      }
      const target = vscode.Uri.joinPath(previewRoot, name);
      const marker = await readMarker(target.fsPath);
      if (marker === undefined) {
        continue;
      }
      choices.push({
        description: `${formatBytes(await folderSize(target))} · ${marker.commit.slice(0, 12)} · ${marker.workflow}`,
        label: marker.repository,
        target,
        workspace: vscode.Uri.file(
          previewWorkspace(
            context.globalStorageUri.fsPath,
            marker.repository,
            marker.commit,
            marker.workflow,
          ),
        ),
      });
    }
  } catch {
    // No preview directory is an empty cache.
  }
  const roots = [
    previewRoot,
    vscode.Uri.joinPath(context.globalStorageUri, 'preview-workspaces'),
    vscode.Uri.joinPath(context.globalStorageUri, 'catalogue-metadata'),
  ];
  const total = (await Promise.all(roots.map(folderSize))).reduce(
    (sum, size) => sum + size,
    0,
  );
  choices.unshift({
    description: `${formatBytes(total)} total`,
    label: 'Remove all catalogue caches',
  });
  const selected = await vscode.window.showQuickPick(choices, {
    placeHolder:
      choices.length === 1 ? 'The catalogue cache is empty' : undefined,
    title: `Verdog catalogue cache · ${formatBytes(total)}`,
  });
  if (selected === undefined) {
    return;
  }
  const all = selected.target === undefined;
  const answer = await vscode.window.showWarningMessage(
    all
      ? 'Remove all Verdog catalogue caches?'
      : `Remove cached inspection of ${selected.label}?`,
    {modal: true},
    'Remove',
  );
  if (answer !== 'Remove') {
    return;
  }
  if (all) {
    for (const root of roots) {
      await deleteCache(root);
    }
  } else {
    await deleteCache(selected.target!);
    if (selected.workspace !== undefined) {
      await deleteCache(selected.workspace);
    }
  }
}

async function deleteCache(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, {recursive: true, useTrash: false});
  } catch {
    // Concurrent cleanup and never-created cache roots are already the requested outcome.
  }
}

export function registerCatalogue(
  context: vscode.ExtensionContext,
  host: HostState,
): vscode.Disposable[] {
  return [
    vscode.window.registerWebviewViewProvider(
      'verdog.catalogue',
      new CatalogueView(context, host),
      {webviewOptions: {retainContextWhenHidden: true}},
    ),
    vscode.commands.registerCommand('verdog.catalogue', () =>
      vscode.commands.executeCommand(
        'workbench.view.extension.verdogCatalogue',
      ),
    ),
    vscode.commands.registerCommand('verdog.manageCatalogueCache', () =>
      manageCache(context),
    ),
    vscode.commands.registerCommand('verdog.closePreview', () =>
      vscode.commands.executeCommand('workbench.action.closeWindow'),
    ),
  ];
}

async function runPreviewed(host: OpenHost): Promise<void> {
  const whose = host.preview?.repository ?? 'this workflow';
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      `Trust this preview before running code from ${whose}. Read-only inspection remains ` +
        'available in Restricted Mode.',
    );
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `Run code from ${whose}?`,
    {
      detail:
        `This executes ${host.preview?.workflow} from ${whose} at ` +
        `${host.preview?.commit.slice(0, 12)} with your files and network access. Inspection ` +
        'did not execute workflow code.',
      modal: true,
    },
    'Run anyway',
  );
  if (answer === 'Run anyway') {
    await runVerb(
      host,
      host.root,
      'run',
      host.preview?.workflow ? [host.preview.workflow] : [],
    );
  }
}

export function registerPreviewCommands(host: OpenHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('verdog.run', () => runPreviewed(host)),
    ...REFUSED.map(id =>
      vscode.commands.registerCommand(id, () => {
        void vscode.window.showInformationMessage(
          `This window is a read-only inspection of ${host.preview?.repository} at ` +
            `${host.preview?.commit.slice(0, 12)}. Work in your own project's window.`,
        );
      }),
    ),
  ];
}
