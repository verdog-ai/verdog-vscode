/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import './identityPage.css';
import './navigationBrowser.css';

import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';

import type {
  HostToNavigationBrowser,
  NavigationBrowserToHost,
  NavigationEntry,
  NavigationPage,
  NavigationPageMessage,
  NavigationPropertyEdit,
  NavigationTarget,
  PropertyNavigationPage,
  PropertyRequest,
} from '../model/protocol';
import {entityLabel} from '../model/names';
import {EntityTree} from './EntityTree';
import {Properties} from './Properties';
import {PropertyRequests} from './propertyRequests';
import {NavigationViews} from './navigationViewState';
import {TerminationSection} from './Termination';

interface Host {
  postMessage(message: NavigationBrowserToHost): void;
}

declare function acquireVsCodeApi(): Host;

function EntryLink({
  entry,
  host,
  label,
  route,
}: {
  entry: NavigationEntry;
  host: Host;
  route: string;
  label?: string;
}) {
  const clickTimer = useRef<number | undefined>(undefined);
  const cancelClick = () => {
    if (clickTimer.current === undefined) {
      return;
    }
    window.clearTimeout(clickTimer.current);
    clickTimer.current = undefined;
  };
  const reveal = () =>
    host.postMessage({key: entry.key, kind: 'reveal', route});
  useEffect(() => cancelClick, []);
  return (
    <li className="navigation-entry">
      <a
        aria-keyshortcuts={
          entry.declaration === undefined ? undefined : 'Shift+Enter'
        }
        href={`#${encodeURIComponent(entry.key)}`}
        data-navigation-focus={entry.key}
        onClick={event => {
          event.preventDefault();
          cancelClick();
          if (event.detail === 0) {
            reveal();
          }
          if (event.detail === 1) {
            clickTimer.current = window.setTimeout(reveal, 350);
          }
        }}
        onDoubleClick={event => {
          event.preventDefault();
          cancelClick();
          host.postMessage({key: entry.key, kind: 'open', route});
        }}
        onKeyDown={event => {
          if (
            event.key !== 'Enter' ||
            !event.shiftKey ||
            entry.declaration === undefined
          ) {
            return;
          }
          event.preventDefault();
          cancelClick();
          host.postMessage({key: entry.key, kind: 'open', route});
        }}
        title={
          entry.declaration === undefined
            ? 'Reveal on the canvas'
            : 'Reveal on the canvas; double-click or press Shift+Enter to open its declaration'
        }
      >
        <code>{label ?? entry.id}</code>
      </a>
      {entry.meta.map(item => (
        <span className="reason" key={item}>
          {item}
        </span>
      ))}
      {(entry.removal !== undefined || entry.removalBlocked !== undefined) && (
        <button
          aria-label={`Delete ${entityLabel(entry.entity)} ${entry.id}`}
          className="delete-entry"
          disabled={entry.removalBlocked !== undefined}
          onClick={() => {
            if (entry.removal === undefined) {
              return;
            }
            cancelClick();
            host.postMessage({key: entry.key, kind: 'remove', route});
          }}
          title={
            entry.removalBlocked ??
            `Delete ${entityLabel(entry.entity)} ${entry.id}`
          }
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M6 2h4l1 2h3v1H2V4h3l1-2Zm-2 4h8l-.6 8H4.6L4 6Zm2 1v6h1V7H6Zm3 0v6h1V7H9Z" />
          </svg>
        </button>
      )}
      {entry.children.length > 0 && (
        <details
          className="references"
          data-disclosure={JSON.stringify(['references', entry.key])}
        >
          <summary>
            <span>References</span>
            <span className="count">{entry.children.length}</span>
          </summary>
          <ul className="tree">
            {entry.children.map(child => (
              <EntryLink
                entry={child}
                host={host}
                key={child.key}
                route={route}
              />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function NavigationEntries({
  entries,
  host,
  route,
}: {
  entries: NavigationEntry[];
  host: Host;
  route: string;
}) {
  const tree = useRef<HTMLDivElement>(null);
  const expand = (open: boolean) => {
    for (const details of tree.current?.querySelectorAll('details') ?? []) {
      details.open = open;
    }
  };
  return (
    <div className="navigation-tree" ref={tree}>
      <div aria-label="Tree controls" className="tree-actions">
        <button onClick={() => expand(true)} type="button">
          Expand all
        </button>
        <button onClick={() => expand(false)} type="button">
          Collapse all
        </button>
      </div>
      <EntityTree
        items={entries}
        renderItem={entry => (
          <EntryLink entry={entry} host={host} key={entry.key} route={route} />
        )}
      />
    </div>
  );
}

function PropertyPage({
  edit,
  failedRequest,
  host,
  page,
  pending,
  route,
}: {
  edit: (value: NavigationPropertyEdit) => void;
  failedRequest?: PropertyRequest;
  host: Host;
  page: PropertyNavigationPage;
  pending: boolean;
  route: string;
}) {
  const call = page.kind === 'subroutine_call' || page.kind === 'workflow_call';
  const resolved =
    page.entity === 'profile_parameters' ||
    page.entity === 'session_parameters';
  return (
    <>
      <Properties
        constraints={page.constraints}
        constraintsWritable={page.constraintsWritable}
        documents={page.documents}
        fields={page.fields}
        failedRequest={failedRequest}
        id={page.id}
        idWritable={page.idWritable}
        kind={page.kind}
        name={page.name}
        nameWritable={page.nameWritable}
        onConstrain={
          page.entity === 'edges' ? () => edit({kind: 'constrain'}) : undefined
        }
        onName={name => edit({kind: 'name', name})}
        onOpen={path => host.postMessage({kind: 'open-document', path, route})}
        onProfile={profile => edit({kind: 'profile', profile})}
        onRemoveConstraint={(collection, feature) =>
          edit({collection, feature, kind: 'unconstrain'})
        }
        onRename={to => edit({kind: 'rename', to})}
        onResources={fields => edit({fields, kind: 'resources'})}
        onSessionPersistence={persistent =>
          edit({kind: 'session-persistence', persistent})
        }
        persistent={page.persistent}
        pending={pending}
        profile={page.profile}
        resources={page.resources}
        resourcesWritable={page.resourcesWritable}
        settingsWritable={page.settingsWritable}
      />
      {page.entries.length > 0 && (
        <details className="section" data-disclosure="components" open>
          <summary>
            <span>
              {call ? 'Target' : resolved ? 'Resolves to' : 'Components'}
            </span>
            <span className="count">{page.entries.length}</span>
          </summary>
          <NavigationEntries entries={page.entries} host={host} route={route} />
        </details>
      )}
    </>
  );
}

export function Browser({
  canGoBack,
  canGoForward,
  edit,
  failedRequest,
  host,
  overview,
  page,
  pending,
  retainedRoutes,
  route,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  edit: (value: NavigationPropertyEdit) => void;
  failedRequest?: PropertyRequest;
  host: Host;
  overview?: NavigationTarget;
  page: NavigationPage;
  pending: boolean;
  retainedRoutes: readonly string[];
  route: string;
}) {
  const main = useRef<HTMLElement>(null);
  const [views] = useState(() => new NavigationViews());
  useLayoutEffect(() => {
    const element = main.current;
    if (element === null) {
      return;
    }
    const rememberDisclosure = (event: Event) => {
      const details = event.target as HTMLDetailsElement;
      const key = details.dataset.disclosure;
      if (key !== undefined) {
        views.at(route).disclosures.set(key, details.open);
      }
    };
    element.addEventListener('toggle', rememberDisclosure, true);
    views.restore(route, element);
    return () =>
      element.removeEventListener('toggle', rememberDisclosure, true);
  }, [route, views]);
  useLayoutEffect(() => {
    if (main.current !== null) {
      views.restoreDisclosures(route, main.current);
    }
  }, [page, route, views]);
  useEffect(() => views.retain(retainedRoutes), [retainedRoutes, views]);
  const summary =
    page.category === 'status'
      ? 'Graph and verification'
      : page.category === 'entity'
        ? page.entries.length === 0
          ? 'Properties'
          : page.kind === 'subroutine_call' || page.kind === 'workflow_call'
            ? 'Properties · Target'
            : page.entity === 'profile_parameters' ||
                page.entity === 'session_parameters'
              ? 'Properties · Resolves to'
              : `Properties · ${page.entries.length} components`
        : `${page.entries.length} ${page.entries.length === 1 ? 'identity' : 'identities'}`;
  const footer =
    page.category === 'status'
      ? 'Status updates with the current project and scope.'
      : page.category === 'entity'
        ? 'Identity fields apply on Enter or when you leave the field.'
        : 'Click to reveal an entity; double-click or press Shift+Enter to open its declaration.';
  return (
    <div className="identity-page">
      <header className="page-header">
        <div className="page-heading">
          {page.category === 'entity' && (
            <p className="page-kind">{page.title}</p>
          )}
          <h1
            className={page.category === 'entity' ? 'page-title-id' : undefined}
          >
            {page.category === 'entity' ? page.id : page.title}
          </h1>
          {page.context !== undefined && (
            <nav aria-label="Current scope" className="scope-breadcrumb">
              {overview === undefined ? (
                page.context
              ) : (
                <a
                  className="breadcrumb-link"
                  href="#overview"
                  onClick={event => {
                    event.preventDefault();
                    host.postMessage({kind: 'overview', route});
                  }}
                  title="Open this definition's overview"
                >
                  {page.context}
                </a>
              )}
            </nav>
          )}
          <p className="summary">{summary}</p>
        </div>
        <nav aria-label="Navigation history" className="history-actions">
          <button
            aria-label="Back"
            disabled={!canGoBack}
            onClick={() =>
              host.postMessage({direction: 'back', kind: 'navigate'})
            }
            title="Back"
            type="button"
          >
            ←
          </button>
          <button
            aria-label="Forward"
            disabled={!canGoForward}
            onClick={() =>
              host.postMessage({direction: 'forward', kind: 'navigate'})
            }
            title="Forward"
            type="button"
          >
            →
          </button>
        </nav>
      </header>
      <main
        aria-label={`${page.category === 'entity' ? page.id : page.title} navigation`}
        key={route}
        onFocusCapture={event => {
          const key = event.target.dataset.navigationFocus;
          if (key !== undefined) {
            views.at(route).focus = key;
          }
        }}
        onScroll={event => {
          views.at(route).scrollTop = event.currentTarget.scrollTop;
        }}
        ref={main}
        tabIndex={-1}
      >
        {(page.category === 'status' || page.category === 'entity') &&
          page.termination !== undefined && (
            <TerminationSection
              analysis={page.termination}
              onHighlight={(region, revision) =>
                host.postMessage({
                  kind: 'termination-highlight',
                  region,
                  revision,
                  route,
                })
              }
              renderEntry={(entry, label) => (
                <EntryLink
                  entry={entry}
                  host={host}
                  key={entry.key}
                  label={label}
                  route={route}
                />
              )}
            />
          )}
        {page.category === 'entity' ? (
          <PropertyPage
            edit={edit}
            failedRequest={
              failedRequest?.route === route ? failedRequest : undefined
            }
            host={host}
            key={route}
            page={page}
            pending={pending}
            route={route}
          />
        ) : page.category === 'status' ? (
          <>
            <dl className="status-list">
              <div>
                <dt>Graph</dt>
                <dd title={page.status.graphHash}>
                  <code>{page.status.graphHash.slice(0, 12)}</code>
                </dd>
              </div>
              <div>
                <dt>Generated files</dt>
                <dd
                  className={
                    page.status.stale ? 'status-warning' : 'status-current'
                  }
                >
                  {page.status.stale ? 'stale' : 'current'}
                </dd>
              </div>
              <div>
                <dt>Check</dt>
                <dd
                  className={
                    page.status.checked ? 'status-current' : 'status-warning'
                  }
                >
                  {page.status.checked
                    ? `${page.status.diagnosticCount} diagnostic(s)`
                    : 'unchecked'}
                </dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>
                  <code>{page.status.location}</code>
                </dd>
              </div>
            </dl>
            {(!page.status.checked || page.status.stale) && (
              <p className="status-note">
                Run Verdog: Check to refresh this status.
              </p>
            )}
            {page.status.pinned && (
              <p className="status-note">
                Edits land in that submodule; check and commit there, then bump
                the parent pin.
              </p>
            )}
          </>
        ) : page.entries.length === 0 ? (
          <p className="loading">Nothing is available here.</p>
        ) : (
          <NavigationEntries entries={page.entries} host={host} route={route} />
        )}
      </main>
      <footer>
        <p>{footer}</p>
        <div className="actions">
          <button
            onClick={() => host.postMessage({kind: 'close'})}
            type="button"
          >
            Close
          </button>
        </div>
      </footer>
    </div>
  );
}

function App({host}: {host: Host}) {
  const [message, setMessage] = useState<NavigationPageMessage>();
  const [requests] = useState(() => new PropertyRequests());
  const [pending, setPending] = useState(false);
  const [failedRequest, setFailedRequest] = useState<PropertyRequest>();
  const edit = (value: NavigationPropertyEdit) => {
    const request = requests.submit(value);
    if (request === undefined) {
      return;
    }
    setPending(true);
    setFailedRequest(undefined);
    host.postMessage(request);
  };
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const message = event.data as HostToNavigationBrowser;
      if (message.kind === 'page') {
        requests.navigate(message.route);
        setMessage(message);
      } else if (message.kind === 'property-result') {
        const completed = requests.settle(message);
        if (completed === undefined) {
          return;
        }
        setPending(false);
        if (!message.saved && completed.current) {
          setFailedRequest(completed.request);
        }
      }
    };
    const navigateWithKeys = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.altKey !== event.shiftKey &&
        (event.code === 'Minus' || event.key === '-' || event.key === '_')
      ) {
        event.preventDefault();
        host.postMessage({
          direction: event.altKey ? 'back' : 'forward',
          kind: 'navigate',
        });
        return;
      }
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      event.preventDefault();
      host.postMessage({kind: 'close'});
    };
    const navigateWithMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) {
        return;
      }
      event.preventDefault();
      host.postMessage({
        direction: event.button === 3 ? 'back' : 'forward',
        kind: 'navigate',
      });
    };
    window.addEventListener('message', listen);
    window.addEventListener('keydown', navigateWithKeys);
    window.addEventListener('auxclick', navigateWithMouse, true);
    host.postMessage({kind: 'ready'});
    return () => {
      window.removeEventListener('message', listen);
      window.removeEventListener('keydown', navigateWithKeys);
      window.removeEventListener('auxclick', navigateWithMouse, true);
    };
  }, [host, requests]);
  return message === undefined ? (
    <p className="loading" role="status">
      Preparing navigation…
    </p>
  ) : (
    <Browser
      canGoBack={message.canGoBack}
      canGoForward={message.canGoForward}
      edit={edit}
      failedRequest={failedRequest}
      host={host}
      overview={message.overview}
      page={message.page}
      pending={pending}
      retainedRoutes={message.retainedRoutes}
      route={message.route}
    />
  );
}

if (typeof document !== 'undefined') {
  const mount = document.getElementById('root');
  if (mount !== null) {
    createRoot(mount).render(<App host={acquireVsCodeApi()} />);
  }
}
