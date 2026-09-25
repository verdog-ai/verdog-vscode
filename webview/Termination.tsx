/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {ReactNode} from 'react';

import type {NavigationEntry, TerminationNavigation} from '../model/protocol';
import {
  TERMINATION_LABEL,
  terminationStatus,
  type DefinitionTerminationState,
  type EdgeTerminationDisplayStatus,
  type TerminationCycleStep,
  type TerminationWitness,
} from '../model/termination';

import './termination.css';

const ICON = {
  certified: '✓',
  checking: '…',
  not_certified: '△',
  unavailable: '—',
} as const;

export const EDGE_TERMINATION_BADGE: Record<
  EdgeTerminationDisplayStatus,
  {icon: string; label: string; description: string}
> = {
  cleared: {
    icon: '✓',
    label: 'Cleared',
    description:
      'No transition of this edge remains in a residual abstract cycle.',
  },
  remaining: {
    icon: '↻',
    label: 'Remaining',
    description:
      'At least one transition of this edge remains in a residual abstract cycle; this does not prove nontermination.',
  },
  unreachable: {
    icon: '—',
    label: 'Unreachable',
    description: 'This edge is unreachable in the analyzed qualitative policy.',
  },
  checking: {
    icon: '…',
    label: 'Checking',
    description:
      'The Verdog service is checking structural termination for the current graph.',
  },
  unavailable: {
    icon: '—',
    label: 'Unavailable',
    description: 'No current termination result is available for this edge.',
  },
};

export function EdgeTerminationLegend() {
  return (
    <div
      aria-label="Edge termination legend"
      className="edge-termination-legend"
    >
      <span>Edges</span>
      {(['cleared', 'remaining', 'unreachable', 'checking'] as const).map(
        status => {
          const badge = EDGE_TERMINATION_BADGE[status];
          return (
            <span
              className={`edge-termination-${status}`}
              key={status}
              title={
                status === 'unreachable'
                  ? `${badge.description} ${EDGE_TERMINATION_BADGE.unavailable.description}`
                  : badge.description
              }
            >
              <span aria-hidden="true">{badge.icon}</span>{' '}
              {status === 'unreachable'
                ? 'No result / unreachable'
                : badge.label}
            </span>
          );
        },
      )}
    </div>
  );
}

export function TerminationBadge({
  state,
  onClick,
  pressed,
}: {
  state: DefinitionTerminationState;
  onClick?: () => void;
  pressed?: boolean;
}) {
  const status = terminationStatus(state);
  const label = TERMINATION_LABEL[status];
  const content = (
    <>
      <span aria-hidden="true">{ICON[status]}</span> {label}
    </>
  );
  return onClick === undefined ? (
    <span className={`termination-badge ${status}`} role="status">
      {content}
    </span>
  ) : (
    <button
      aria-label={`Structural termination: ${label}. Show analysis.`}
      aria-pressed={pressed}
      className={`termination-badge ${status}${pressed ? ' open' : ''}`}
      onClick={onClick}
      title="Open structural-termination analysis"
      type="button"
    >
      <span aria-live="polite">{content}</span>
    </button>
  );
}

type EntryRenderer = (entry: NavigationEntry, label?: string) => ReactNode;

function Cycle({
  cycle,
  entries,
  renderEntry,
}: {
  cycle: TerminationCycleStep[];
  entries: NavigationEntry[];
  renderEntry: EntryRenderer;
}) {
  const link = (entity: 'nodes' | 'edges', id: string) => {
    const entry = entries.find(
      entry => entry.entity === entity && entry.id === id,
    );
    return (
      <ul className="tree">
        {entry === undefined ? (
          <li>
            <code>{id}</code>
          </li>
        ) : (
          renderEntry(entry)
        )}
      </ul>
    );
  };
  return (
    <div className="termination-cycle">
      <table>
        <caption>One residual cycle</caption>
        <thead>
          <tr>
            <th>Step</th>
            <th>Node</th>
            <th>Feature observations</th>
            <th>Edge to next step</th>
          </tr>
        </thead>
        <tbody>
          {cycle.map((step, index) => (
            <tr key={index}>
              <td>{index + 1}</td>
              <td>{link('nodes', step.node)}</td>
              <td>
                {step.values.length === 0
                  ? '—'
                  : step.values.map((value, index) => (
                      <code key={index}>{value}</code>
                    ))}
              </td>
              <td>
                {link('edges', step.edge)}
                <span className="reason">
                  {index + 1 === cycle.length
                    ? '↻ back to step 1'
                    : `→ step ${index + 2}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="status-note">
        This is a cycle in the qualitative abstraction, not a concrete execution
        trace.
      </p>
    </div>
  );
}

function Witnesses({
  witnesses,
  entries,
  renderEntry,
  disclosure,
}: {
  witnesses: TerminationWitness[];
  entries: NavigationEntry[];
  renderEntry: EntryRenderer;
  disclosure: string;
}) {
  return (
    <ul className="termination-witnesses">
      {witnesses.map((witness, index) => {
        const feature = entries.find(
          ({entity, id}) => entity === 'features' && id === witness.feature,
        );
        return (
          <li key={`${witness.expression}:${index}`}>
            <ul className="tree">
              {feature === undefined ? (
                <li>
                  <code>{witness.expression}</code>
                </li>
              ) : (
                renderEntry(feature, witness.expression)
              )}
            </ul>
            {(
              [
                ['edges', 'Progress transitions'],
                ['opposing_edges', 'Opposing transitions'],
              ] as const
            ).map(([field, label]) =>
              witness[field].length === 0 ? null : (
                <details
                  data-disclosure={`${disclosure}/witness:${witness.expression}:${index}:${field}`}
                  key={field}
                >
                  <summary>
                    {label}{' '}
                    <span className="count">{witness[field].length}</span>
                  </summary>
                  <ul className="tree">
                    {entries
                      .filter(
                        ({entity, id}) =>
                          entity === 'edges' && witness[field].includes(id),
                      )
                      .map(entry => renderEntry(entry))}
                  </ul>
                </details>
              ),
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TerminationSection({
  analysis,
  onHighlight,
  renderEntry,
}: {
  analysis: TerminationNavigation;
  onHighlight: (region: string | null, revision: string) => void;
  renderEntry: EntryRenderer;
}) {
  const {state, entries} = analysis;
  return (
    <section
      aria-label="Structural termination"
      className="termination-section"
    >
      <div className="termination-heading">
        <h2>Structural termination</h2>
        <TerminationBadge state={state} />
      </div>
      <EdgeTerminationLegend />
      {state.status === 'ready' ? (
        <>
          <p>{state.definition.reason}</p>
          <dl className="termination-summary">
            <div>
              <dt>This graph</dt>
              <dd>{TERMINATION_LABEL[state.definition.local_status]}</dd>
            </div>
            <div>
              <dt>Including calls</dt>
              <dd>{TERMINATION_LABEL[state.definition.status]}</dd>
            </div>
            <div>
              <dt>Qualitative policy</dt>
              <dd>
                {state.definition.memory_states.toLocaleString()} control states
                · {state.definition.rules.toLocaleString()} rules
              </dd>
            </div>
          </dl>
          {state.definition.dependencies.length > 0 && (
            <details data-disclosure="termination/dependencies" open>
              <summary>
                Called definitions{' '}
                <span className="count">
                  {state.definition.dependencies.length}
                </span>
              </summary>
              <ul className="tree">
                {state.definition.dependencies.map(({scope, node}) => {
                  const entry = entries.find(
                    ({key}) =>
                      key === `termination/dependency:${node}:${scope}`,
                  );
                  return entry === undefined ? (
                    <li key={`${scope}:${node}`}>
                      <code>{scope}</code> — Unavailable
                    </li>
                  ) : (
                    renderEntry(entry, scope)
                  );
                })}
              </ul>
            </details>
          )}
          {state.definition.regions.map((region, index) => (
            <details
              className="termination-region"
              data-disclosure={`termination/region:${region.id}`}
              key={region.id}
            >
              <summary>
                Residual region {index + 1}{' '}
                <span className="count">
                  {region.nodes.length} nodes · {region.edges.length} edges
                </span>
              </summary>
              <div className="termination-actions">
                <button
                  onClick={() => onHighlight(region.id, state.revision)}
                  type="button"
                >
                  Highlight region
                </button>
                <button
                  onClick={() => onHighlight(null, state.revision)}
                  type="button"
                >
                  Clear highlight
                </button>
              </div>
              <p className="status-note">
                A residual abstract cycle prevents certification; it does not
                prove nontermination.
              </p>
              {region.cycle.length > 0 && (
                <Cycle
                  cycle={region.cycle}
                  entries={entries}
                  renderEntry={renderEntry}
                />
              )}
              {(
                [
                  ['nodes', 'Nodes'],
                  ['edges', 'Edges'],
                ] as const
              ).map(([entity, label]) => (
                <details
                  data-disclosure={`termination/region:${region.id}:${entity}`}
                  key={entity}
                >
                  <summary>
                    {label}{' '}
                    <span className="count">{region[entity].length}</span>
                  </summary>
                  <ul className="tree">
                    {entries
                      .filter(
                        entry =>
                          entry.entity === entity &&
                          region[entity].includes(entry.id),
                      )
                      .map(entry => renderEntry(entry))}
                  </ul>
                </details>
              ))}
              {region.witnesses.length > 0 && (
                <Witnesses
                  disclosure={`termination/region:${region.id}`}
                  entries={entries}
                  renderEntry={renderEntry}
                  witnesses={region.witnesses}
                />
              )}
            </details>
          ))}
        </>
      ) : (
        <p role="status">
          {state.status === 'checking'
            ? 'The Verdog service is checking the current graph and its reachable calls…'
            : state.reason}
        </p>
      )}
      <p className="status-note">
        Conservative qualitative analysis of graph traversal, not authored
        Python termination or successful execution.
      </p>
    </section>
  );
}
