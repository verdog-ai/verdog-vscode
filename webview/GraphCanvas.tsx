/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import {graphviz, type GraphvizRenderer} from 'd3-graphviz';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type {Position} from '../model/editing';
import type {EdgeId, NodeId} from '../model/identifiers';
import {edgeDirectionProblem, isCallNodeKind} from '../model/project';
import type {CanvasSelection} from '../model/protocol';
import {
  edgeTerminationStatus,
  type DefinitionTerminationState,
  type EdgeTerminationDisplayStatus,
  type TerminationRegion,
} from '../model/termination';
import {edgeDomId, graphvizSource, nodeDomId} from './graphviz';
import type {
  SubroutineEdge,
  SubroutineGraph,
  SubroutineNode,
} from './subroutines';
import {EDGE_TERMINATION_BADGE} from './Termination';

export interface GraphCanvasHandle {
  reveal(graph: string, ids: readonly NodeId[]): void;
  tidy(): void;
}

interface CanvasProps {
  current: SubroutineGraph | undefined;
  focused: CanvasSelection | undefined;
  highlightedRegion?: TerminationRegion;
  onConnect(source: NodeId, target: NodeId): void;
  onInspect(selection: CanvasSelection): void;
  onOpenCall(node: SubroutineNode): void;
  onRelink(edge: EdgeId, source: NodeId, target: NodeId): void;
  onRemove(selection: CanvasSelection): void;
  onSelect(selection: CanvasSelection | undefined): void;
  selected: CanvasSelection | undefined;
  termination?: DefinitionTerminationState;
  writable: boolean;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Endpoint = 'source' | 'target';
interface RevealRequest {
  graph: string;
  ids: readonly NodeId[];
  revision: number;
}
type Connection = {
  capture: SVGGElement;
  fixed: Position;
  pointerId: number;
} & (
  | {kind: 'connect'; source: SubroutineNode}
  | {edge: SubroutineEdge; endpoint: Endpoint; kind: 'relink'}
);

const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
const ZOOM_FACTOR = 1.2;

function groupAt(target: EventTarget | null): SVGGElement | undefined {
  return target instanceof Element
    ? (target.closest<SVGGElement>('g.node, g.edge') ?? undefined)
    : undefined;
}

function graphPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): Position | undefined {
  const root = container.querySelector<SVGGElement>('svg > g');
  const matrix = root?.getScreenCTM();
  if (matrix === null || matrix === undefined) {
    return undefined;
  }
  const point = new DOMPoint(clientX, clientY).matrixTransform(
    matrix.inverse(),
  );
  return {x: point.x, y: point.y};
}

function union(bounds: readonly DOMRect[]): Bounds | undefined {
  if (bounds.length === 0) {
    return undefined;
  }
  const left = Math.min(...bounds.map(({x}) => x));
  const top = Math.min(...bounds.map(({y}) => y));
  const right = Math.max(...bounds.map(({x, width}) => x + width));
  const bottom = Math.max(...bounds.map(({y, height}) => y + height));
  return {x: left, y: top, width: right - left, height: bottom - top};
}

function viewportCentre(
  container: HTMLElement,
): readonly [number, number] | undefined {
  const svg = container.querySelector<SVGSVGElement>('svg');
  if (svg === null) {
    return undefined;
  }
  const box = svg.viewBox.baseVal;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function nodeBox(node: SVGGElement): DOMRect {
  return (
    node
      .querySelector<SVGGraphicsElement>('path, polygon, ellipse')
      ?.getBBox() ?? node.getBBox()
  );
}

function edgeEnds(edge: SVGGElement): Record<Endpoint, Position> | undefined {
  const path = edge.querySelector<SVGPathElement>(
    ':scope > path:not(.graph-edge-hit)',
  );
  if (path === null) {
    return undefined;
  }
  const arrow = edge.querySelector<SVGPolygonElement>(':scope > polygon');
  const arrowBox = arrow?.getBBox();
  const end = path.getPointAtLength(path.getTotalLength());
  return {
    source: path.getPointAtLength(0),
    target:
      arrowBox === undefined
        ? end
        : {
            x: arrowBox.x + arrowBox.width / 2,
            y: arrowBox.y + arrowBox.height / 2,
          },
  };
}

function previewEnds(
  connection: Connection,
  pointer: Position,
): readonly [Position, Position] {
  return connection.kind === 'relink' && connection.endpoint === 'source'
    ? [pointer, connection.fixed]
    : [connection.fixed, pointer];
}

function nodeBounds(
  container: HTMLElement,
  ids?: readonly NodeId[],
): Bounds | undefined {
  const wanted = ids === undefined ? undefined : new Set(ids.map(nodeDomId));
  return union(
    [...container.querySelectorAll<SVGGElement>('g.node')]
      .filter(({id}) => wanted === undefined || wanted.has(id))
      .map(nodeBox),
  );
}

function graphBounds(container: HTMLElement): Bounds | undefined {
  return union(
    [...container.querySelectorAll<SVGGElement>('g.node, g.edge')].map(entity =>
      entity.getBBox(),
    ),
  );
}

function renderKey(graph: SubroutineGraph): string {
  return JSON.stringify([
    graph.id,
    graph.nodes.map(node => [node.id, node.data]),
    graph.edges.map(({id, source, target}) => [id, source, target]),
  ]);
}

/** A decoration on the existing spline, not a DOT label or a new interaction target. */
function decorateEdgeTermination(
  edge: SVGGElement,
  path: SVGPathElement,
  status: EdgeTerminationDisplayStatus,
): void {
  const {icon, label, description} = EDGE_TERMINATION_BADGE[status];
  const point = path.getPointAtLength(path.getTotalLength() / 2);
  const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  badge.classList.add('graph-edge-status', `edge-termination-${status}`);
  badge.setAttribute('transform', `translate(${point.x},${point.y})`);
  badge.setAttribute('aria-hidden', 'true');
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `${label}: ${description}`;
  const circle = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'circle',
  );
  circle.setAttribute('r', '9');
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.textContent = icon;
  badge.append(title, circle, text);
  edge.append(badge);
}

function decorate(
  container: HTMLElement,
  graph: SubroutineGraph | undefined,
  focused: CanvasSelection | undefined,
  selected: CanvasSelection | undefined,
  writable: boolean,
  highlightedRegion: TerminationRegion | undefined,
  termination: DefinitionTerminationState | undefined,
) {
  decorateNodes(
    container,
    graph,
    focused,
    selected,
    writable,
    highlightedRegion,
  );
  decorateEdges(
    container,
    graph,
    focused,
    selected,
    writable,
    highlightedRegion,
    termination,
  );
}

function matchesSelection(
  selection: CanvasSelection | undefined,
  entity: CanvasSelection['entity'],
  id: string,
) {
  return selection?.entity === entity && selection.id === id;
}

function decorateNodes(
  container: HTMLElement,
  graph: SubroutineGraph | undefined,
  focused: CanvasSelection | undefined,
  selected: CanvasSelection | undefined,
  writable: boolean,
  highlightedRegion: TerminationRegion | undefined,
) {
  const nodes = new Map(
    (graph?.nodes ?? []).map(node => [nodeDomId(node.id), node]),
  );
  for (const element of container.querySelectorAll<SVGGElement>('g.node')) {
    const node = nodes.get(element.id);
    const active =
      node !== undefined &&
      (matchesSelection(focused, 'nodes', node.id) ||
        matchesSelection(selected, 'nodes', node.id));
    element.classList.toggle('is-focused', active);
    const highlighted =
      node !== undefined && highlightedRegion?.nodes.includes(node.id) === true;
    element.classList.toggle('is-termination', highlighted);
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.setAttribute(
      'aria-label',
      `Node ${node?.id ?? element.id}. Enter to inspect; Shift+Enter to enter a call.${highlighted ? ' Highlighted residual region.' : ''}`,
    );
    element.querySelector('.graph-connect-handle')?.remove();
    if (
      !writable ||
      node === undefined ||
      !graph?.nodes.some(
        target =>
          edgeDirectionProblem(node.data.kind, target.data.kind) === undefined,
      )
    ) {
      continue;
    }
    const box = nodeBox(element);
    const handle = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle',
    );
    handle.classList.add('graph-connect-handle');
    handle.setAttribute('cx', String(box.x + box.width));
    handle.setAttribute('cy', String(box.y + box.height / 2));
    handle.setAttribute('r', '6');
    handle.setAttribute('aria-label', `Connect from ${node.data.label}`);
    element.append(handle);
  }
}

function decorateEdges(
  container: HTMLElement,
  graph: SubroutineGraph | undefined,
  focused: CanvasSelection | undefined,
  selected: CanvasSelection | undefined,
  writable: boolean,
  highlightedRegion: TerminationRegion | undefined,
  termination: DefinitionTerminationState | undefined,
) {
  const edges = new Map(
    (graph?.edges ?? []).map(edge => [edgeDomId(edge.id), edge]),
  );
  for (const element of container.querySelectorAll<SVGGElement>('g.edge')) {
    const edge = edges.get(element.id);
    const active =
      edge !== undefined &&
      (matchesSelection(focused, 'edges', edge.id) ||
        matchesSelection(selected, 'edges', edge.id));
    element.classList.toggle('is-focused', active);
    const highlighted =
      edge !== undefined && highlightedRegion?.edges.includes(edge.id) === true;
    element.classList.toggle('is-termination', highlighted);
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    const status = edgeTerminationStatus(termination, edge?.id ?? '');
    const badge = EDGE_TERMINATION_BADGE[status];
    const label = `Edge ${edge?.id ?? element.id}. Structural termination: ${badge.label}.`;
    element.setAttribute(
      'aria-label',
      `${label} Enter to inspect.${highlighted ? ' Highlighted residual region.' : ''}`,
    );
    const title = element.querySelector(':scope > title');
    if (title !== null) {
      title.textContent = `${label} ${badge.description}`;
    }
    element
      .querySelectorAll(
        '.graph-edge-hit, .graph-edge-source-handle, .graph-edge-status',
      )
      .forEach(interaction => interaction.remove());
    const path = element.querySelector<SVGPathElement>(':scope > path');
    if (path !== null) {
      const hit = path.cloneNode(false) as SVGPathElement;
      hit.classList.add('graph-edge-hit');
      path.before(hit);
      decorateEdgeTermination(element, path, status);
    }
    const arrow = element.querySelector<SVGPolygonElement>(':scope > polygon');
    arrow?.classList.toggle('graph-edge-target-handle', writable);
    if (arrow !== null) {
      if (writable) {
        arrow.dataset.relinkEndpoint = 'target';
      } else {
        delete arrow.dataset.relinkEndpoint;
      }
    }
    const ends = edgeEnds(element);
    if (!writable || edge === undefined || ends === undefined) {
      continue;
    }
    const handle = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle',
    );
    handle.classList.add('graph-edge-source-handle');
    handle.dataset.relinkEndpoint = 'source';
    handle.setAttribute('cx', String(ends.source.x));
    handle.setAttribute('cy', String(ends.source.y));
    handle.setAttribute('r', '5');
    handle.setAttribute('aria-label', `Relink source of ${edge.id}`);
    element.append(handle);
  }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, CanvasProps>(
  (props, ref) => {
    const {
      current,
      focused,
      highlightedRegion,
      selected,
      termination,
      writable,
    } = props;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<GraphvizRenderer | null>(null);
    const renderedKeyRef = useRef<string | undefined>(undefined);
    const revisionRef = useRef(0);
    const renderingRef = useRef<number | undefined>(undefined);
    const revealRef = useRef<RevealRequest | undefined>(undefined);
    const revealedRef = useRef<RevealRequest | undefined>(undefined);
    const revealRevisionRef = useRef(0);
    const shownRef = useRef<string | undefined>(undefined);
    const nodesRef = useRef(new Map<string, SubroutineNode>());
    const edgesRef = useRef(new Map<string, SubroutineEdge>());
    const propsRef = useRef(props);
    const connectionRef = useRef<Connection | undefined>(undefined);
    const cancelGestureRef = useRef<() => void>(() => {});
    const suppressClickRef = useRef(0);
    const [gestureStatus, setGestureStatus] = useState<string>();
    propsRef.current = props;

    const zoomParts = useCallback(() => {
      const renderer = rendererRef.current;
      const behavior = renderer?.zoomBehavior();
      const selection = renderer?.zoomSelection();
      return behavior === null ||
        behavior === undefined ||
        selection === null ||
        selection === undefined
        ? undefined
        : {behavior, selection};
    }, []);

    const centre = useCallback(
      (ids?: readonly string[]) => {
        const container = containerRef.current;
        const zoom = zoomParts();
        if (container === null || zoom === undefined) {
          return;
        }
        const bounds = nodeBounds(container, ids);
        const point = viewportCentre(container);
        if (bounds === undefined || point === undefined) {
          return;
        }
        zoom.behavior.translateTo(
          zoom.selection,
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
          point,
        );
      },
      [zoomParts],
    );

    const applyReveal = useCallback(
      (request: RevealRequest) => {
        requestAnimationFrame(() => {
          if (
            request.revision === revealRevisionRef.current &&
            shownRef.current === request.graph
          ) {
            revealedRef.current = request;
            centre(request.ids);
          }
        });
      },
      [centre],
    );

    const reveal = useCallback(
      (graph: string, ids: readonly NodeId[]) => {
        const request = {
          graph,
          ids: [...ids],
          revision: ++revealRevisionRef.current,
        };
        if (shownRef.current === graph && renderingRef.current === undefined) {
          revealRef.current = undefined;
          applyReveal(request);
        } else {
          revealRef.current = request;
        }
      },
      [applyReveal],
    );

    const fit = useCallback(() => {
      const container = containerRef.current;
      const zoom = zoomParts();
      if (container === null || zoom === undefined) {
        return;
      }
      const bounds = graphBounds(container);
      const svg = container.querySelector<SVGSVGElement>('svg');
      const point = viewportCentre(container);
      if (bounds === undefined || svg === null || point === undefined) {
        return;
      }
      const view = svg.viewBox.baseVal;
      const scale = Math.max(
        MIN_SCALE,
        Math.min(
          MAX_SCALE,
          (view.width - 30) / bounds.width,
          (view.height - 30) / bounds.height,
        ),
      );
      zoom.behavior.scaleTo(zoom.selection, scale, point);
      zoom.behavior.translateTo(
        zoom.selection,
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        point,
      );
    }, [zoomParts]);

    const renderGraph = useCallback(
      (graph: SubroutineGraph | undefined, force = false) => {
        const renderer = rendererRef.current;
        const container = containerRef.current;
        if (renderer === null || container === null) {
          return;
        }
        const key = graph === undefined ? undefined : renderKey(graph);
        if (!force && key !== undefined && key === renderedKeyRef.current) {
          return;
        }
        cancelGestureRef.current();
        container
          .querySelectorAll(
            '.graph-connect-handle, .graph-edge-hit, .graph-edge-source-handle, .graph-edge-status',
          )
          .forEach(interaction => interaction.remove());
        const revision = ++revisionRef.current;
        renderingRef.current = revision;
        nodesRef.current = new Map(
          (graph?.nodes ?? []).map(node => [nodeDomId(node.id), node]),
        );
        edgesRef.current = new Map(
          (graph?.edges ?? []).map(edge => [edgeDomId(edge.id), edge]),
        );
        const rendered =
          graph === undefined
            ? {dot: 'digraph {}', engine: 'dot' as const}
            : graphvizSource(graph);
        renderer
          .width(container.clientWidth)
          .height(container.clientHeight)
          .engine(rendered.engine)
          .dot(rendered.dot, function layoutReady() {
            if (revision !== revisionRef.current) {
              return;
            }
            this.render(() => {
              if (revision !== revisionRef.current) {
                return;
              }
              renderingRef.current = undefined;
              if (graph === undefined) {
                renderedKeyRef.current = undefined;
              } else {
                renderedKeyRef.current = key;
              }
              decorate(
                container,
                graph,
                propsRef.current.focused,
                propsRef.current.selected,
                propsRef.current.writable,
                propsRef.current.highlightedRegion,
                propsRef.current.termination,
              );
              const previous = shownRef.current;
              const switched = graph?.id !== previous;
              shownRef.current = graph?.id;
              const requested = revealRef.current;
              if (graph !== undefined && requested?.graph === graph.id) {
                revealRef.current = undefined;
                applyReveal(requested);
              } else if (graph !== undefined && switched) {
                revealedRef.current = undefined;
                requestAnimationFrame(
                  previous === undefined ? fit : () => centre(),
                );
              }
            });
          });
      },
      [applyReveal, centre, fit],
    );

    const tidy = useCallback(() => {
      const graph = propsRef.current.current;
      if (graph === undefined || !propsRef.current.writable) {
        return;
      }
      revealedRef.current = undefined;
      renderGraph(graph, true);
    }, [renderGraph]);

    useImperativeHandle(ref, () => ({reveal, tidy}), [reveal, tidy]);

    useEffect(() => {
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const renderer = graphviz(container, {
        fit: false,
        height: container.clientHeight,
        useWorker: false,
        width: container.clientWidth,
        zoom: true,
        zoomScaleExtent: [MIN_SCALE, MAX_SCALE],
      })
        .keyMode('id')
        .fade(false)
        .tweenPaths(false)
        .tweenShapes(false)
        .growEnteringEdges(false)
        .onerror(error => console.error('Graphviz layout failed', error));
      rendererRef.current = renderer;

      const entity = (
        target: EventTarget | null,
      ): CanvasSelection | undefined => {
        const group = groupAt(target);
        if (group === undefined || !container.contains(group)) {
          return undefined;
        }
        const node = nodesRef.current.get(group.id);
        if (node !== undefined) {
          return {entity: 'nodes', id: node.id};
        }
        const edge = edgesRef.current.get(group.id);
        return edge === undefined ? undefined : {entity: 'edges', id: edge.id};
      };

      const stopGesture = () => {
        const connection = connectionRef.current;
        if (
          connection !== undefined &&
          connection.capture.hasPointerCapture(connection.pointerId)
        ) {
          connection.capture.releasePointerCapture(connection.pointerId);
        }
        renderer.removeDrawnEdge();
        connectionRef.current = undefined;
        container
          .querySelectorAll('.graph-drop-valid, .graph-drop-invalid')
          .forEach(node =>
            node.classList.remove('graph-drop-valid', 'graph-drop-invalid'),
          );
        setGestureStatus(undefined);
      };
      cancelGestureRef.current = stopGesture;

      const onClick = (event: MouseEvent) => {
        if (
          suppressClickRef.current !== 0 &&
          performance.now() - suppressClickRef.current < 250
        ) {
          suppressClickRef.current = 0;
          event.preventDefault();
          return;
        }
        const selection = entity(event.target);
        propsRef.current.onSelect(selection);
        if (selection !== undefined) {
          propsRef.current.onInspect(selection);
        }
      };
      const onDoubleClick = (event: MouseEvent) => {
        const selection = entity(event.target);
        if (selection === undefined) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        container.parentElement?.focus();
        if (selection.entity === 'nodes') {
          const node = [...nodesRef.current.values()].find(
            ({id}) => id === selection.id,
          );
          if (node !== undefined && isCallNodeKind(node.data.kind)) {
            propsRef.current.onOpenCall(node);
          }
        }
      };
      const onFocus = (event: FocusEvent) => {
        // Pointer selection belongs to click: moving the viewport during pointerdown
        // would move the node away before mouseup and lose that click.
        if (!groupAt(event.target)?.matches(':focus-visible')) {
          return;
        }
        const selection = entity(event.target);
        if (selection === undefined) {
          return;
        }
        propsRef.current.onSelect(selection);
        const edge =
          selection.entity === 'edges'
            ? [...edgesRef.current.values()].find(({id}) => id === selection.id)
            : undefined;
        centre(
          selection.entity === 'nodes'
            ? [selection.id]
            : edge === undefined
              ? []
              : [edge.source, edge.target],
        );
      };
      const onEntityKey = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        const selection = entity(event.target);
        if (selection === undefined) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const node =
          selection.entity === 'nodes'
            ? [...nodesRef.current.values()].find(({id}) => id === selection.id)
            : undefined;
        if (
          event.key === 'Enter' &&
          event.shiftKey &&
          node !== undefined &&
          isCallNodeKind(node.data.kind)
        ) {
          propsRef.current.onOpenCall(node);
        } else {
          propsRef.current.onInspect(selection);
        }
      };
      const candidate = (event: PointerEvent, connection: Connection) => {
        const group = document
          .elementsFromPoint(event.clientX, event.clientY)
          .map(element => element.closest<SVGGElement>('g.node'))
          .find(
            (element): element is SVGGElement =>
              element !== null && container.contains(element),
          );
        const dropped =
          group === undefined ? undefined : nodesRef.current.get(group.id);
        const node = (id: NodeId) =>
          [...nodesRef.current.values()].find(item => item.id === id);
        const source =
          connection.kind === 'connect'
            ? connection.source
            : connection.endpoint === 'source'
              ? dropped
              : node(connection.edge.source);
        const target =
          connection.kind === 'connect' || connection.endpoint === 'target'
            ? dropped
            : node(connection.edge.target);
        const problem =
          source === undefined || target === undefined
            ? 'Drop onto a node, or press Escape to cancel.'
            : edgeDirectionProblem(source.data.kind, target.data.kind);
        return {group, problem, source, target};
      };
      const stopEntityStart = (event: Event) => {
        if (groupAt(event.target) !== undefined) {
          event.stopPropagation();
        }
      };
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) {
          return;
        }
        const group = groupAt(event.target);
        if (group === undefined) {
          return;
        }
        const node = nodesRef.current.get(group.id);
        const edge = edgesRef.current.get(group.id);
        container.parentElement?.focus();
        if (!propsRef.current.writable || !(event.target instanceof Element)) {
          return;
        }
        const endpoint = event.target.closest<SVGGraphicsElement>(
          '[data-relink-endpoint]',
        )?.dataset.relinkEndpoint as Endpoint | undefined;
        let connection: Connection;
        if (edge !== undefined && endpoint !== undefined) {
          const ends = edgeEnds(group);
          if (ends === undefined) {
            return;
          }
          connection = {
            capture: group,
            edge,
            endpoint,
            fixed: ends[endpoint === 'source' ? 'target' : 'source'],
            kind: 'relink',
            pointerId: event.pointerId,
          };
        } else {
          if (
            node === undefined ||
            event.target.closest('.graph-connect-handle') === null
          ) {
            return;
          }
          const box = nodeBox(group);
          connection = {
            capture: group,
            fixed: {x: box.x + box.width, y: box.y + box.height / 2},
            kind: 'connect',
            pointerId: event.pointerId,
            source: node,
          };
        }
        const point = graphPoint(container, event.clientX, event.clientY);
        if (point === undefined) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        group.setPointerCapture(event.pointerId);
        connectionRef.current = connection;
        setGestureStatus('Drop onto a node, or press Escape to cancel.');
        const [source, target] = previewEnds(connection, point);
        renderer.drawEdge(
          source.x,
          source.y,
          target.x,
          target.y,
          {color: '#647260', fillcolor: '#647260', penwidth: 1.4},
          {shortening: 8},
        );
      };
      const onPointerMove = (event: PointerEvent) => {
        const point = graphPoint(container, event.clientX, event.clientY);
        if (point === undefined) {
          return;
        }
        const connection = connectionRef.current;
        if (connection?.pointerId !== event.pointerId) {
          return;
        }
        const dropped = candidate(event, connection);
        container
          .querySelectorAll('.graph-drop-valid, .graph-drop-invalid')
          .forEach(node =>
            node.classList.remove('graph-drop-valid', 'graph-drop-invalid'),
          );
        dropped.group?.classList.add(
          dropped.problem === undefined
            ? 'graph-drop-valid'
            : 'graph-drop-invalid',
        );
        setGestureStatus(
          dropped.problem ?? `${dropped.source!.id} → ${dropped.target!.id}`,
        );
        const [source, target] = previewEnds(connection, point);
        renderer.updateDrawnEdge(
          source.x,
          source.y,
          target.x,
          target.y,
          {},
          {shortening: 8},
        );
      };
      const onPointerUp = (event: PointerEvent) => {
        const connection = connectionRef.current;
        if (connection?.pointerId !== event.pointerId) {
          return;
        }
        suppressClickRef.current = performance.now();
        const {problem, source, target} = candidate(event, connection);
        stopGesture();
        if (!propsRef.current.writable) {
          return;
        }
        if (
          problem !== undefined ||
          source === undefined ||
          target === undefined
        ) {
          setGestureStatus(problem);
          return;
        }
        if (connection.kind === 'connect') {
          propsRef.current.onConnect(source.id, target.id);
        } else if (
          source.id !== connection.edge.source ||
          target.id !== connection.edge.target
        ) {
          propsRef.current.onRelink(connection.edge.id, source.id, target.id);
        }
      };
      const onPointerCancel = () => {
        stopGesture();
      };

      container.addEventListener('click', onClick);
      container.addEventListener('dblclick', onDoubleClick, true);
      container.addEventListener('focusin', onFocus);
      container.addEventListener('keydown', onEntityKey);
      container.addEventListener('mousedown', stopEntityStart, true);
      container.addEventListener('touchstart', stopEntityStart, true);
      container.addEventListener('pointerdown', onPointerDown, true);
      container.addEventListener('pointermove', onPointerMove);
      container.addEventListener('pointerup', onPointerUp);
      container.addEventListener('pointercancel', onPointerCancel);
      const observer = new ResizeObserver(([entry]) => {
        if (
          entry === undefined ||
          entry.contentRect.width < 1 ||
          entry.contentRect.height < 1
        ) {
          return;
        }
        renderer
          .width(entry.contentRect.width)
          .height(entry.contentRect.height);
        const svg = container.querySelector<SVGSVGElement>('svg');
        if (svg !== null) {
          svg.setAttribute('width', String(entry.contentRect.width));
          svg.setAttribute('height', String(entry.contentRect.height));
          svg.setAttribute(
            'viewBox',
            `0 0 ${entry.contentRect.width * 0.75} ${entry.contentRect.height * 0.75}`,
          );
          requestAnimationFrame(() => {
            const revealed = revealedRef.current;
            if (
              revealed !== undefined &&
              revealed.revision === revealRevisionRef.current &&
              revealed.graph === shownRef.current
            ) {
              centre(revealed.ids);
            } else {
              centre();
            }
          });
        }
      });
      observer.observe(container);
      return () => {
        ++revisionRef.current;
        stopGesture();
        observer.disconnect();
        container.removeEventListener('click', onClick);
        container.removeEventListener('dblclick', onDoubleClick, true);
        container.removeEventListener('focusin', onFocus);
        container.removeEventListener('keydown', onEntityKey);
        container.removeEventListener('mousedown', stopEntityStart, true);
        container.removeEventListener('touchstart', stopEntityStart, true);
        container.removeEventListener('pointerdown', onPointerDown, true);
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('pointerup', onPointerUp);
        container.removeEventListener('pointercancel', onPointerCancel);
        renderer.destroy();
        rendererRef.current = null;
        renderingRef.current = undefined;
        revealRef.current = undefined;
        revealedRef.current = undefined;
        cancelGestureRef.current = () => {};
      };
    }, [centre]);

    useEffect(() => {
      renderGraph(current);
    }, [current, renderGraph]);

    useEffect(() => {
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      decorate(
        container,
        current,
        focused,
        selected,
        writable,
        highlightedRegion,
        termination,
      );
      if (
        selected !== undefined &&
        !(selected.entity === 'nodes'
          ? current?.nodes.some(({id}) => id === selected.id)
          : current?.edges.some(({id}) => id === selected.id))
      ) {
        propsRef.current.onSelect(undefined);
      }
    }, [current, focused, highlightedRegion, selected, termination, writable]);

    const deleteSelection = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        if (connectionRef.current !== undefined) {
          event.preventDefault();
          cancelGestureRef.current();
        }
        setGestureStatus(undefined);
        return;
      }
      if (!writable || (event.key !== 'Delete' && event.key !== 'Backspace')) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'button,input,select,textarea,[contenteditable=true]',
        ) !== null
      ) {
        return;
      }
      if (propsRef.current.selected === undefined) {
        return;
      }
      event.preventDefault();
      propsRef.current.onRemove(propsRef.current.selected);
    };

    const zoomFromCentre = (factor: number) => {
      const container = containerRef.current;
      const zoom = zoomParts();
      const point = container === null ? undefined : viewportCentre(container);
      if (zoom === undefined || point === undefined) {
        return;
      }
      zoom.behavior.scaleBy(zoom.selection, factor, point);
    };

    return (
      <div
        className="graph-surface"
        aria-label="Graph. Tab selects entities; Enter inspects; Shift+Enter enters a call."
        onKeyDown={deleteSelection}
        onPointerDown={event => event.currentTarget.focus()}
        tabIndex={0}
      >
        <div className="graph-canvas" ref={containerRef} />
        {writable &&
          current?.scope.kind === 'subroutine' &&
          current.nodes.every(
            ({data}) =>
              data.kind === 'enter' ||
              data.kind === 'exit' ||
              data.kind === 'failure',
          ) && (
            <p className="graph-hint">
              Add a node or call, then select it and choose Connect to… or drag
              its circle.
            </p>
          )}
        <div aria-live="polite" className="graph-gesture-status" role="status">
          {gestureStatus}
        </div>
        <div aria-label="Graph zoom" className="graph-controls">
          <button
            aria-label="Zoom in"
            onClick={() => zoomFromCentre(ZOOM_FACTOR)}
            type="button"
          >
            +
          </button>
          <button
            aria-label="Zoom out"
            onClick={() => zoomFromCentre(1 / ZOOM_FACTOR)}
            type="button"
          >
            −
          </button>
          <button aria-label="Fit graph" onClick={fit} type="button">
            □
          </button>
        </div>
      </div>
    );
  },
);
