/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {
  CanvasAction,
  CanvasSelection,
  NavigationCategory,
} from '../model/protocol';
import type {DefinitionTerminationState} from '../model/termination';
import {TerminationBadge} from './Termination';

const ADDITIONS = [
  ['add-node', '+ node', 'Add a node (Verdog: Add Node)'],
  [
    'add-definition',
    '+ definition',
    'Add a subroutine definition or make one runnable',
  ],
  ['add-call', '+ call', 'Call a visible workflow or subroutine'],
  ['add-feature', '+ feature', 'Add a feature (Verdog: Add Feature)'],
  ['add-profile', '+ profile', 'Add a local profile or profile parameter'],
  ['add-session', '+ session', 'Add a local session or session parameter'],
] as const;
const WORKFLOW_ADDITIONS = [
  ['add-profile', '+ profile', 'Add a profile owned by this workflow'],
  ['add-session', '+ session', 'Add a session owned by this workflow'],
] as const;
export function additionsFor(scope: 'subroutine' | 'workflow') {
  return scope === 'workflow' ? WORKFLOW_ADDITIONS : ADDITIONS;
}

const PANELS: ReadonlyArray<[NavigationCategory, string]> = [
  ['subroutines', 'Browse subroutine definitions'],
  ['workflows', 'Browse workflow definitions'],
  ['features', 'Which edges constrain each feature'],
  ['profiles', 'Profiles declared by this scope'],
  ['sessions', 'Sessions declared by this scope'],
  ['status', 'Show graph and verification status'],
];

export function CanvasBar({
  canGoBack,
  canGoForward,
  canConnect = false,
  onAction,
  onBack,
  onForward,
  onOverview,
  scope,
  onPanel,
  onTidy,
  panel,
  selected,
  termination,
  writable,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  canConnect?: boolean;
  onAction: (action: CanvasAction) => void;
  onBack: () => void;
  onForward: () => void;
  onOverview?: () => void;
  scope?: 'subroutine' | 'workflow';
  onPanel: (panel: NavigationCategory | undefined) => void;
  onTidy: () => void;
  panel: NavigationCategory | undefined;
  selected: CanvasSelection | undefined;
  termination?: DefinitionTerminationState;
  writable: boolean;
}) {
  return (
    <header className="bar">
      <fieldset className="tool-group">
        <legend>Modify {scope === 'workflow' ? 'workflow' : 'graph'}</legend>
        {writable && scope !== undefined ? (
          <span className="tools">
            {additionsFor(scope).map(([kind, label, title]) => (
              <button
                key={kind}
                onClick={() => onAction({kind})}
                title={title}
                type="button"
              >
                {label}
              </button>
            ))}
            {scope === 'subroutine' && (
              <>
                {selected?.entity === 'nodes' && (
                  <button
                    disabled={!canConnect}
                    onClick={() =>
                      onAction({kind: 'connect', source: selected.id})
                    }
                    title="Choose a target for the selected node"
                    type="button"
                  >
                    Connect to…
                  </button>
                )}
                {selected?.entity === 'edges' &&
                  (['source', 'target'] as const).map(endpoint => (
                    <button
                      key={endpoint}
                      onClick={() =>
                        onAction({
                          edge: selected.id,
                          endpoint,
                          kind: 'relink-endpoint',
                        })
                      }
                      type="button"
                    >
                      Change {endpoint}…
                    </button>
                  ))}
                <button
                  disabled={selected === undefined}
                  onClick={() => {
                    if (selected?.entity === 'edges') {
                      onAction({
                        entity: 'edges',
                        id: selected.id,
                        kind: 'remove',
                      });
                    } else if (selected?.entity === 'nodes') {
                      onAction({
                        entity: 'nodes',
                        id: selected.id,
                        kind: 'remove',
                      });
                    }
                  }}
                  title="Delete the selection (or press Delete)"
                  type="button"
                >
                  delete
                </button>
                <button
                  onClick={onTidy}
                  title="Recompute the DOT layout without changing the viewport"
                  type="button"
                >
                  tidy
                </button>
              </>
            )}
          </span>
        ) : (
          <span className="readonly">read-only</span>
        )}
      </fieldset>
      <fieldset className="tool-group">
        <legend>Navigate &amp; inspect</legend>
        <span className="tools">
          <button
            aria-label="Go back"
            disabled={!canGoBack}
            onClick={onBack}
            title="Go back (Ctrl+Alt+-)"
            type="button"
          >
            ←
          </button>
          <button
            aria-label="Go forward"
            disabled={!canGoForward}
            onClick={onForward}
            title="Go forward (Ctrl+Shift+-)"
            type="button"
          >
            →
          </button>
          <button
            disabled={onOverview === undefined}
            onClick={onOverview}
            title="Open the current workflow or subroutine definition"
            type="button"
          >
            overview
          </button>
          {PANELS.map(([kind, title]) =>
            kind === 'status' && termination !== undefined ? (
              <TerminationBadge
                key={kind}
                onClick={() => onPanel(panel === kind ? undefined : kind)}
                pressed={panel === kind}
                state={termination}
              />
            ) : (
              <button
                aria-pressed={panel === kind}
                className={panel === kind ? 'open' : undefined}
                key={kind}
                onClick={() => onPanel(panel === kind ? undefined : kind)}
                title={title}
                type="button"
              >
                {kind}
              </button>
            ),
          )}
        </span>
      </fieldset>
    </header>
  );
}
