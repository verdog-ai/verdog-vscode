/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as vscode from 'vscode';

import {handleCanvasAction} from './projectActions';
import {
  deliverPendingReveal,
  followNavigation,
  followNavigationTarget,
  hasProject,
  openProjectDocument,
  refresh,
  selectWorkflowEnvironment,
  type HostState,
} from './projectHost';
import {webviewHtml} from './webviewHtml';
import type {
  CanvasToHost,
  HostToCanvas,
  HostToNavigationBrowser,
  NavigationCategory,
  NavigationBrowserToHost,
  NavigationEntry,
  NavigationPage,
  NavigationPropertyEdit,
  NavigationTarget,
  PropertyRequest,
} from '../model/protocol';
import {
  definitionTarget,
  navigationContext,
  navigationPage,
} from '../webview/navigation';
import {entityPropertyPage} from '../webview/propertyData';
import {snapshotCanvasGraphs} from '../webview/subroutineGraphs';
import {startTraversal, visit, type Traversal} from '../webview/traversal';
import {terminationRevision} from '../model/termination';

const CANVAS_VIEW = 'verdog.canvas';

interface BrowserVisit {
  page: NavigationPage;
  panel?: NavigationCategory;
  target: NavigationTarget;
}

class CanvasView implements vscode.WebviewViewProvider {
  private browser: vscode.WebviewPanel | undefined;
  private readonly browserVisits = new Map<string, BrowserVisit>();
  private browserRestoring: string | undefined;
  private browserTraversal: Traversal = startTraversal();

  constructor(
    private readonly host: HostState,
    private readonly extension: vscode.Uri,
  ) {
    host.snapshotChanged = () => {
      if (this.freshCurrentVisit() !== undefined) {
        this.postBrowserPage();
      }
    };
  }

  private closeBrowser(): void {
    this.browser?.dispose();
  }

  private currentVisit(): BrowserVisit | undefined {
    const route = this.currentRoute();
    return route === undefined ? undefined : this.browserVisits.get(route);
  }

  private currentRoute(): string | undefined {
    return this.browserTraversal.entries[this.browserTraversal.cursor];
  }

  private freshCurrentVisit(): BrowserVisit | undefined {
    const route = this.currentRoute();
    const current = this.currentVisit();
    const fresh = current === undefined ? undefined : this.freshVisit(current);
    if (route !== undefined && fresh !== undefined) {
      this.browserVisits.set(route, fresh);
    }
    return fresh;
  }

  private freshVisit(visit: BrowserVisit): BrowserVisit | undefined {
    const snapshot = this.host.snapshot;
    if (snapshot === undefined) {
      return undefined;
    }
    const graphs = snapshotCanvasGraphs(snapshot);
    const current = graphs[visit.target.scope];
    if (
      current === undefined ||
      (visit.target.workflow !== undefined &&
        graphs[visit.target.workflow.scope] === undefined)
    ) {
      return undefined;
    }
    if (visit.page.category === 'entity') {
      const inspection = visit.target.inspection;
      if (inspection === undefined) {
        return undefined;
      }
      const page = entityPropertyPage(
        snapshot,
        current,
        inspection,
        navigationContext(snapshot, current.id),
        visit.target.selection,
      );
      return page === undefined ? undefined : {...visit, page};
    }
    return {
      ...visit,
      page: navigationPage(snapshot, current.id, visit.page.category),
    };
  }

  private nextVisit(
    direction: -1 | 1,
  ): {cursor: number; route: string; visit: BrowserVisit} | undefined {
    for (
      let cursor = this.browserTraversal.cursor + direction;
      cursor >= 0 && cursor < this.browserTraversal.entries.length;
      cursor += direction
    ) {
      const route = this.browserTraversal.entries[cursor];
      if (route === undefined) {
        continue;
      }
      const stored = this.browserVisits.get(route);
      const fresh = stored === undefined ? undefined : this.freshVisit(stored);
      if (fresh === undefined) {
        continue;
      }
      this.browserVisits.set(route, fresh);
      return {cursor, route, visit: fresh};
    }
    return undefined;
  }

  private static visitKey(
    page: NavigationPage,
    target: BrowserVisit['target'],
    panel?: NavigationCategory,
  ): string {
    const inspection = target.inspection;
    const selection = target.selection;
    return JSON.stringify(
      page.category === 'entity'
        ? [
            page.category,
            target.scope,
            page.entity,
            page.id,
            inspection?.subroutine,
            inspection?.workflow,
            selection?.entity,
            selection?.id,
            target.workflow?.scope,
            panel,
          ]
        : [page.category, target.scope, target.workflow?.scope],
    );
  }

  private entry(key: string): NavigationEntry | undefined {
    const page = this.freshCurrentVisit()?.page;
    if (page === undefined) {
      return undefined;
    }
    const find = (entries: NavigationEntry[]): NavigationEntry | undefined => {
      for (const entry of entries) {
        if (entry.key === key) {
          return entry;
        }
        const child = find(entry.children);
        if (child !== undefined) {
          return child;
        }
      }
      return undefined;
    };
    const termination =
      page.category === 'status' || page.category === 'entity'
        ? (page.termination?.entries ?? [])
        : [];
    return (
      find(termination) ??
      (page.category === 'status' ? undefined : find(page.entries))
    );
  }

  private postBrowserPage(): void {
    const current = this.currentVisit();
    const route = this.currentRoute();
    if (
      current === undefined ||
      route === undefined ||
      this.browser === undefined
    ) {
      return;
    }
    const availability = {
      canGoBack: this.nextVisit(-1) !== undefined,
      canGoForward: this.nextVisit(1) !== undefined,
    };
    void this.host.view?.webview.postMessage({
      ...availability,
      kind: 'navigation-state',
    } satisfies HostToCanvas);
    void this.browser.webview.postMessage({
      ...availability,
      kind: 'page',
      overview: this.overviewTarget(),
      page: current.page,
      retainedRoutes: this.browserTraversal.entries,
      route,
    } satisfies HostToNavigationBrowser);
  }

  private showBrowser(
    page: NavigationPage,
    target: BrowserVisit['target'],
    panel?: NavigationCategory,
    restoration?: string,
  ): void {
    const previous = this.currentVisit();
    const key = CanvasView.visitKey(page, target, panel);
    if (this.browserRestoring !== undefined || restoration !== undefined) {
      if (restoration !== this.browserRestoring) {
        return;
      }
      this.browserRestoring = undefined;
    }
    const routeChanged =
      this.browserTraversal.entries[this.browserTraversal.cursor] !== key;
    const next = {page, panel, target};
    this.browserVisits.set(key, next);
    this.browserTraversal = visit(this.browserTraversal, key);
    const retained = new Set(this.browserTraversal.entries);
    for (const route of this.browserVisits.keys()) {
      if (!retained.has(route)) {
        this.browserVisits.delete(route);
      }
    }
    const title =
      page.category === 'status' ? page.title : `Navigate: ${page.title}`;
    if (this.browser === undefined) {
      const panel = vscode.window.createWebviewPanel(
        'verdog.navigationBrowser',
        title,
        {preserveFocus: false, viewColumn: vscode.ViewColumn.Active},
        {
          enableFindWidget: true,
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extension, 'dist')],
          retainContextWhenHidden: true,
        },
      );
      this.browser = panel;
      panel.onDidDispose(() => {
        if (this.browser !== panel) {
          return;
        }
        this.browser = undefined;
        this.browserRestoring = undefined;
        this.browserVisits.clear();
        this.browserTraversal = startTraversal();
        this.host.pendingReveal = undefined;
        ++this.host.navigationRevision;
        void this.host.view?.webview.postMessage({
          kind: 'browser-closed',
        } satisfies HostToCanvas);
      });
      let propertyPending = false;
      panel.webview.onDidReceiveMessage(
        async (message: NavigationBrowserToHost) => {
          if (typeof message !== 'object' || message === null) {
            return;
          }
          if (this.browser !== panel) {
            return;
          }
          if (message.kind === 'property') {
            let saved = false;
            const accepted =
              !propertyPending && message.route === this.currentRoute();
            if (accepted) {
              propertyPending = true;
            }
            try {
              if (accepted) {
                saved = await this.editProperty(message.edit);
              }
            } catch (error) {
              void vscode.window.showErrorMessage(
                `Verdog: property could not be saved: ${String(error)}`,
              );
            } finally {
              if (accepted) {
                propertyPending = false;
              }
              this.postPropertyResult(panel, message, saved);
            }
            return;
          }
          if ('route' in message && message.route !== this.currentRoute()) {
            return;
          }
          if (message.kind === 'ready') {
            this.postBrowserPage();
          } else if (message.kind === 'close') {
            panel.dispose();
          } else if (message.kind === 'navigate') {
            await this.navigate(message.direction);
          } else if (message.kind === 'termination-highlight') {
            const current = this.freshCurrentVisit();
            const termination = this.host.snapshot?.termination;
            if (current === undefined || termination?.status !== 'ready') {
              return;
            }
            if (message.revision !== terminationRevision(termination.report)) {
              return;
            }
            const definition =
              termination.report.definitions[current.target.scope];
            if (definition === undefined) {
              return;
            }
            if (
              message.region !== null &&
              !definition.regions.some(({id}) => id === message.region)
            ) {
              return;
            }
            void this.host.view?.webview.postMessage({
              kind: 'termination-highlight',
              scope: current.target.scope,
              region: message.region,
              revision: message.revision,
            } satisfies HostToCanvas);
          } else if (message.kind === 'overview') {
            const target = this.overviewTarget();
            if (target !== undefined) {
              this.browserRestoring = undefined;
              await followNavigationTarget(this.host, target);
            }
          } else if (
            (message.kind === 'open' || message.kind === 'reveal') &&
            hasProject(this.host)
          ) {
            const entry = this.entry(message.key);
            if (entry !== undefined) {
              this.browserRestoring = undefined;
              await followNavigation(this.host, entry, message.kind === 'open');
            }
          } else if (
            message.kind === 'open-document' &&
            hasProject(this.host)
          ) {
            const page = this.freshCurrentVisit()?.page;
            if (
              page?.category === 'entity' &&
              page.documents.some(({path}) => path === message.path)
            ) {
              await openProjectDocument(this.host, message.path);
            }
          } else if (message.kind === 'remove' && hasProject(this.host)) {
            const removal = this.entry(message.key)?.removal;
            if (removal !== undefined) {
              await handleCanvasAction(this.host, {...removal, kind: 'remove'});
            }
          }
        },
      );
      panel.webview.html = webviewHtml(
        panel.webview,
        this.extension,
        'navigationBrowser',
      );
    } else {
      this.browser.title = title;
      if (routeChanged || previous?.page.category !== page.category) {
        this.browser.reveal(vscode.ViewColumn.Active, false);
      }
    }
    this.postBrowserPage();
  }

  private overviewTarget(): NavigationTarget | undefined {
    const visit = this.currentVisit();
    const snapshot = this.host.snapshot;
    if (visit === undefined || snapshot === undefined) {
      return undefined;
    }
    const current = snapshotCanvasGraphs(snapshot)[visit.target.scope];
    const target =
      current === undefined ? undefined : definitionTarget(snapshot, current);
    return target === undefined
      ? undefined
      : {
          ...target,
          ...(visit.target.workflow === undefined
            ? {}
            : {workflow: visit.target.workflow}),
        };
  }

  private postPropertyResult(
    panel: vscode.WebviewPanel,
    request: PropertyRequest,
    saved: boolean,
  ): void {
    if (this.browser !== panel) {
      return;
    }
    void panel.webview.postMessage({
      kind: 'property-result',
      requestId: request.requestId,
      route: request.route,
      saved,
    } satisfies HostToNavigationBrowser);
  }

  async navigate(direction: 'back' | 'forward'): Promise<void> {
    if (this.browser !== undefined) {
      await this.navigateBrowser(direction === 'back' ? -1 : 1);
    } else {
      void this.host.view?.webview.postMessage({
        direction,
        kind: 'navigate',
      } satisfies HostToCanvas);
    }
  }

  private async navigateBrowser(direction: -1 | 1): Promise<void> {
    const next = this.nextVisit(direction);
    if (next === undefined) {
      return;
    }
    this.browserTraversal = {...this.browserTraversal, cursor: next.cursor};
    this.browserRestoring = next.route;
    this.postBrowserPage();
    if (hasProject(this.host)) {
      await followNavigationTarget(
        this.host,
        next.visit.target,
        next.visit.panel ?? null,
        next.route,
      );
    }
  }

  private async editProperty(edit: NavigationPropertyEdit): Promise<boolean> {
    if (!hasProject(this.host)) {
      return false;
    }
    const current = this.freshCurrentVisit();
    const inspection =
      current?.page.category === 'entity'
        ? current.target.inspection
        : undefined;
    if (inspection === undefined) {
      return false;
    }
    const subroutine = inspection.subroutine;
    switch (edit.kind) {
      case 'constrain':
        if (inspection.entity !== 'edges') {
          return false;
        }
        return (
          (await handleCanvasAction(this.host, {
            edge: inspection.id,
            kind: 'constrain',
            subroutine,
          })) === true
        );
      case 'unconstrain':
        if (
          inspection.entity !== 'edges' ||
          (edit.collection !== 'conditions' && edit.collection !== 'effects')
        ) {
          return false;
        }
        return (
          (await handleCanvasAction(this.host, {
            collection: edit.collection,
            edge: inspection.id,
            feature: edit.feature,
            kind: 'unconstrain',
            subroutine,
          })) === true
        );
      case 'name':
        return (
          (await handleCanvasAction(this.host, {
            ...inspection,
            kind: 'name',
            name: edit.name,
          })) === true
        );
      case 'rename':
        return (
          (await handleCanvasAction(this.host, {
            ...inspection,
            kind: 'rename',
            to: edit.to,
          })) === true
        );
      case 'profile':
        if (inspection.entity !== 'profiles') {
          return false;
        }
        return (
          (await handleCanvasAction(this.host, {
            kind: 'set-profile-configuration',
            options: edit.profile.options,
            profile: inspection.id,
            provider: edit.profile.provider,
            subroutine,
            ...(inspection.workflow === undefined
              ? {}
              : {workflow: inspection.workflow}),
          })) === true
        );
      case 'session-persistence':
        if (inspection.entity !== 'sessions') {
          return false;
        }
        return (
          (await handleCanvasAction(this.host, {
            kind: 'set-session-persistence',
            persistent: edit.persistent,
            session: inspection.id,
            subroutine,
            ...(inspection.workflow === undefined
              ? {}
              : {workflow: inspection.workflow}),
          })) === true
        );
      case 'resources': {
        const resources = edit.fields.map(({parameter, resource, value}) => ({
          ...(parameter === undefined ? {} : {parameter}),
          resource,
          value,
        }));
        if (inspection.entity === 'nodes') {
          return (
            (await handleCanvasAction(this.host, {
              kind: 'set-node-resources',
              node: inspection.id,
              resources,
              subroutine,
            })) === true
          );
        } else if (
          inspection.entity === 'workflows' &&
          inspection.workflow !== undefined
        ) {
          return (
            (await handleCanvasAction(this.host, {
              kind: 'set-workflow-resources',
              resources,
              subroutine,
              workflow: inspection.workflow,
            })) === true
          );
        }
        return false;
      }
      default: {
        const unsupported: never = edit;
        throw new Error(`Unsupported property edit: ${String(unsupported)}`);
      }
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.host.view = view;
    this.host.canvasReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extension, 'dist')],
    };
    view.webview.html = webviewHtml(view.webview, this.extension);
    view.onDidDispose(() => {
      if (this.host.view === view) {
        this.host.canvasReady = false;
        this.host.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage(async (message: CanvasToHost) => {
      if (typeof message !== 'object' || message === null) {
        return;
      }
      if (this.host.view !== view) {
        return;
      }
      switch (message.kind) {
        case 'ready':
          if (hasProject(this.host)) {
            await refresh(this.host);
          } else {
            void view.webview.postMessage({
              kind: 'idle',
            } satisfies HostToCanvas);
          }
          if (this.host.view !== view) {
            return;
          }
          this.host.canvasReady = true;
          await deliverPendingReveal(this.host);
          return;
        case 'shown':
          this.host.showingSubroutine = message.subroutine;
          if (message.workflow !== undefined && hasProject(this.host)) {
            await selectWorkflowEnvironment(this.host, message.workflow);
          }
          return;
        case 'cancel-navigation':
          if (message.navigationVersion <= this.host.canvasNavigationVersion) {
            return;
          }
          this.host.canvasNavigationVersion = message.navigationVersion;
          this.browserRestoring = undefined;
          this.host.pendingReveal = undefined;
          ++this.host.navigationRevision;
          return;
        case 'browse':
          this.showBrowser(
            message.page,
            message.target,
            message.panel,
            message.restoration,
          );
          return;
        case 'close-browser':
          this.closeBrowser();
          return;
        case 'navigate':
          await this.navigate(message.direction);
          return;
        default:
          if (hasProject(this.host)) {
            await handleCanvasAction(this.host, message);
          }
      }
    });
  }
}

export async function showCanvas(host: HostState): Promise<void> {
  const available = new Set(await vscode.commands.getCommands(true));
  const wanted = [
    'workbench.action.focusAuxiliaryBar',
    'workbench.view.extension.verdog',
    `${CANVAS_VIEW}.focus`,
  ];
  let reached = false;
  for (const id of wanted) {
    if (!available.has(id)) {
      continue;
    }
    try {
      await vscode.commands.executeCommand(id);
      reached = true;
    } catch (error) {
      host.output.appendLine(`${id} failed: ${String(error)}`);
    }
  }
  if (!reached) {
    host.output.appendLine(
      'No command revealed the canvas. Open it from the secondary side bar ' +
        '(View: Toggle Secondary Side Bar).',
    );
  }
}

export function registerCanvas(
  host: HostState,
  extension: vscode.Uri,
): vscode.Disposable[] {
  const canvas = new CanvasView(host, extension);
  return [
    vscode.window.registerWebviewViewProvider(CANVAS_VIEW, canvas, {
      webviewOptions: {retainContextWhenHidden: true},
    }),
    vscode.commands.registerCommand('verdog.openCanvas', () =>
      showCanvas(host),
    ),
    vscode.commands.registerCommand('verdog.canvasBack', () =>
      canvas.navigate('back'),
    ),
    vscode.commands.registerCommand('verdog.canvasForward', () =>
      canvas.navigate('forward'),
    ),
  ];
}
