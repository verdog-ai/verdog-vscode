/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/// <reference types="node" />

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

import type {TerminationNavigation} from '../model/protocol';
import {TerminationBadge, TerminationSection} from './Termination';

const analysis: TerminationNavigation = {
  entries: [],
  state: {
    status: 'ready',
    revision: 'revision',
    definition: {
      status: 'not_certified',
      local_status: 'certified',
      reason: 'A called definition is not certified.',
      memory_states: 4,
      rules: 5,
      dependencies: [{scope: 'missing/main', node: 'child'}],
      edges: {forward: 'remaining', back: 'remaining'},
      regions: [
        {
          id: '0',
          nodes: ['first', 'second'],
          edges: ['forward', 'back'],
          witnesses: [
            {
              feature: 'iterations',
              expression: 'iterations↓',
              edges: ['forward'],
              opposing_edges: ['back'],
            },
          ],
          cycle: [
            {
              node: 'first',
              values: ['iterations>0', 'phase=ready'],
              edge: 'forward',
            },
            {node: 'second', values: ['iterations=0', '¬done'], edge: 'back'},
          ],
        },
      ],
    },
  },
};

test('termination presentation distinguishes local and aggregate certification and preserves advisory meaning', () => {
  const html = renderToStaticMarkup(
    createElement(TerminationSection, {
      analysis,
      onHighlight() {},
      renderEntry: entry => createElement('li', {key: entry.key}, entry.id),
    }),
  );
  assert.match(html, /This graph<\/dt><dd>Certified/);
  assert.match(html, /Including calls<\/dt><dd>Not certified/);
  assert.match(html, /missing\/main<\/code> — Unavailable/);
  assert.match(html, /iterations↓/);
  assert.match(html, /Qualitative policy<\/dt><dd>4 control states · 5 rules/);
  assert.match(html, /Conservative qualitative analysis/);
  assert.doesNotMatch(html, /Reachable abstraction|Progress witnesses/);
  assert.match(html, /Highlight region<\/button>/);
  assert.match(html, /Clear highlight<\/button>/);
  assert.match(html, /does not prove nontermination/);
  assert.match(html, /not authored Python termination/);
  assert.doesNotMatch(
    html,
    /<details[^>]*data-disclosure="termination\/region:0"[^>]*open/,
  );
});

test('pending analysis exposes no old regions or actionable highlights', () => {
  const html = renderToStaticMarkup(
    createElement(TerminationSection, {
      analysis: {state: {status: 'checking'}, entries: []},
      onHighlight() {},
      renderEntry: () => null,
    }),
  );
  assert.match(html, /The Verdog service is checking the current graph/);
  assert.doesNotMatch(html, /Highlight region|Clear highlight|Residual region/);
  const badge = renderToStaticMarkup(
    createElement(TerminationBadge, {
      state: {status: 'checking'},
      onClick() {},
    }),
  );
  assert.match(
    badge,
    /<button aria-label="Structural termination: Checking. Show analysis."/,
  );
  assert.match(badge, /aria-live="polite"/);
});

test('cycle rows preserve native order, observations, edge identities, and closing step', () => {
  const entries = [
    ...['first', 'second'].map(id => ({entity: 'nodes' as const, id})),
    ...['forward', 'back'].map(id => ({entity: 'edges' as const, id})),
  ].map(entry => ({
    ...entry,
    key: `${entry.entity}:${entry.id}`,
    children: [],
    scope: [],
    meta: [],
  }));
  const html = renderToStaticMarkup(
    createElement(TerminationSection, {
      analysis: {...analysis, entries},
      onHighlight() {},
      renderEntry: entry =>
        createElement(
          'li',
          {key: entry.key},
          createElement('a', {href: `#${entry.key}`}, entry.id),
        ),
    }),
  );
  assert.match(html, /<caption>One residual cycle<\/caption>/);
  const cycle = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.ok(
    cycle.indexOf('href="#nodes:first"') <
      cycle.indexOf('href="#nodes:second"'),
  );
  assert.ok(
    cycle.indexOf('href="#edges:forward"') <
      cycle.indexOf('href="#edges:back"'),
  );
  assert.match(cycle, /iterations&gt;0/);
  assert.match(cycle, /phase=ready/);
  assert.match(cycle, /¬done/);
  assert.match(cycle, /→ step 2/);
  assert.match(cycle, /↻ back to step 1/);
  assert.match(html, /not a concrete execution trace/);
});
