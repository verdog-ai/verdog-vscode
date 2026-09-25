// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
declare module "d3-graphviz" {
  import type { BaseType, Selection } from "d3-selection";

  type Engine = "dot" | "nop2";
  type KeyMode = "id";
  type ZoomExtent = readonly [number, number];
  type SvgSelection = Selection<SVGSVGElement, unknown, BaseType, unknown>;

  interface Options {
    useWorker?: boolean;
    engine?: Engine;
    keyMode?: KeyMode;
    fade?: boolean;
    tweenPaths?: boolean;
    tweenShapes?: boolean;
    growEnteringEdges?: boolean;
    zoom?: boolean;
    zoomScaleExtent?: ZoomExtent;
    width?: number | null;
    height?: number | null;
    fit?: boolean;
  }

  interface ZoomBehavior {
    scaleBy(selection: SvgSelection, scale: number, point?: ZoomExtent): void;
    scaleTo(selection: SvgSelection, scale: number, point?: ZoomExtent): void;
    translateTo(selection: SvgSelection, x: number, y: number, point?: ZoomExtent): void;
  }

  interface EdgeOptions {
    shortening?: number;
  }

  type EdgeAttributes = Readonly<
    Record<string, string | number | boolean | null | undefined>
  >;

  type EventName =
    | "initEnd"
    | "start"
    | "layoutStart"
    | "layoutEnd"
    | "renderStart"
    | "renderEnd"
    | "end"
    | "zoom";

  export interface GraphvizRenderer {
    engine(engine: Engine): this;
    keyMode(mode: KeyMode): this;
    fade(enabled: boolean): this;
    tweenPaths(enabled: boolean): this;
    tweenShapes(enabled: boolean): this;
    growEnteringEdges(enabled: boolean): this;
    dot(source: string, callback?: (this: GraphvizRenderer) => void): this;
    render(callback?: (this: GraphvizRenderer) => void): this;
    on(event: EventName, callback: ((this: GraphvizRenderer) => void) | null): this;
    onerror(callback: (error: unknown) => void): this;
    destroy(): this;
    drawEdge(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      attributes?: EdgeAttributes,
      options?: EdgeOptions,
    ): this;
    updateDrawnEdge(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      attributes?: EdgeAttributes,
      options?: EdgeOptions,
    ): this;
    moveDrawnEdgeEndPoint(x: number, y: number, options?: EdgeOptions): this;
    removeDrawnEdge(): this;
    zoomBehavior(): ZoomBehavior | null;
    zoomSelection(): SvgSelection | null;
    resetZoom(): this;
    zoomScaleExtent(extent: ZoomExtent): this;
    width(width: number | null): this;
    height(height: number | null): this;
    fit(fit: boolean): this;
    options(options: Options): this;
  }

  export type Graphviz = GraphvizRenderer;
  export function graphviz(selector: string | Element, options?: Options): GraphvizRenderer;
}
