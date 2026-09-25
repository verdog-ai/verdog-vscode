/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {NodeKind} from '../model/project';
import type {SubroutineGraph, SubroutineNode} from './subroutines';

const NODE_WIDTH = 216;
const NODE_HEIGHT = 80;

const PALETTE: Record<
  NodeKind,
  {fill: string; gradient: string; stroke: string}
> = {
  agent: {fill: '#2b2038', gradient: '#20172a', stroke: '#c19be8'},
  enter: {fill: '#282d32', gradient: '#1d2226', stroke: '#d7dde4'},
  exit: {fill: '#282d32', gradient: '#1d2226', stroke: '#d7dde4'},
  failure: {fill: '#371b1f', gradient: '#291418', stroke: '#e8797f'},
  feature: {fill: '#1d2842', gradient: '#151d31', stroke: '#88a2e8'},
  python: {fill: '#302b16', gradient: '#231f10', stroke: '#e3cf70'},
  subroutine_call: {fill: '#172c31', gradient: '#102024', stroke: '#6cb8c9'},
  workflow_call: {fill: '#183028', gradient: '#11231d', stroke: '#72c6a8'},
};

function quote(value: string): string {
  return JSON.stringify(value);
}

export function nodeDomId(id: string): string {
  return `verdog-node-${encodeURIComponent(id)}`;
}
export function edgeDomId(id: string): string {
  return `verdog-edge-${encodeURIComponent(id)}`;
}

function nodeLabel({data}: SubroutineNode): string {
  return `${data.kind.replaceAll('_', ' ').toUpperCase()}\n${data.label}${
    data.definition === undefined ? '' : '  ↗'
  }`;
}

export function graphvizSource(
  graph: Pick<SubroutineGraph, 'nodes' | 'edges'>,
): {dot: string; engine: 'dot'} {
  const lines = [
    'digraph {',
    '  graph [bgcolor="transparent", rankdir="TB", ranksep=0.888889, nodesep=1.875, splines="spline", outputorder="edgesfirst"];',
    `  node [shape="rect", style="rounded,filled", fixedsize=false, width=${
      NODE_WIDTH / 72
    }, height=${NODE_HEIGHT / 72}, fontname="Arial", fontsize=16, fontcolor="#e1e6df", gradientangle=270, penwidth=1];`,
    '  edge [color="#647260", penwidth=1.4, arrowsize=0.75];',
  ];

  for (const node of graph.nodes) {
    const palette = PALETTE[node.data.kind];
    const compact =
      node.data.kind === 'feature'
        ? ', width=1.75, height=0.625, fontsize=14, margin="0.14,0.08"'
        : '';
    lines.push(
      `  ${quote(node.id)} [id=${quote(nodeDomId(node.id))}, label=${quote(
        nodeLabel(node),
      )}, color=${quote(palette.stroke)}, fillcolor=${quote(`${palette.fill}:${palette.gradient}`)}${compact}];`,
    );
  }

  for (const edge of graph.edges) {
    lines.push(
      `  ${quote(edge.source)} -> ${quote(edge.target)} [id=${quote(edgeDomId(edge.id))}];`,
    );
  }

  lines.push('}');
  return {dot: lines.join('\n'), engine: 'dot'};
}
