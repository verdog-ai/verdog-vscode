import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CanvasAction,
  CanvasSelection,
  CanvasToHost,
  HostToCanvas,
  NavigationCategory,
  NavigationInspection,
  NavigationTarget,
} from "../model/protocol";
import { qualifiedKey, type ProjectSnapshot } from "../model/snapshot";
import { edgeDirectionProblem } from "../model/project";
import { highlightedTerminationRegion, terminationFor, type TerminationHighlight } from "../model/termination";
import { CanvasBar } from "./CanvasBar";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import {
  calledDefinitionTarget,
  definitionTarget,
  navigationContext,
  navigationPage,
} from "./navigation";
import { entityPropertyPage } from "./propertyData";
import { activeWorkflowScope, snapshotCanvasGraphs } from "./subroutineGraphs";
import type { SubroutineNode } from "./subroutines";
import { retainAvailable, startTraversal, travel, visit } from "./traversal";

export type CanvasHost = { postMessage(message: CanvasToHost): void };
type PendingReveal = { restoration?: string; target: NavigationTarget };

export function Canvas({ host }: { host: CanvasHost }) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | undefined>();
  const [idle, setIdle] = useState(false);
  const [traversal, setTraversal] = useState(startTraversal);
  const [panel, setPanel] = useState<NavigationCategory | undefined>();
  const [browserHistory, setBrowserHistory] = useState<{
    canGoBack: boolean;
    canGoForward: boolean;
  }>();
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | undefined>();
  const [selected, setSelected] = useState<CanvasSelection | undefined>();
  const [terminationHighlight, setTerminationHighlight] = useState<TerminationHighlight>();
  const graphRef = useRef<GraphCanvasHandle | null>(null);
  const navigationVersionRef = useRef(0);
  const restorationRef = useRef<string | undefined>(undefined);
  // Inspection survives focus leaving the graph; selection deliberately does not.
  const [inspectionTarget, setInspectionTarget] = useState<NavigationTarget | undefined>();
  const inspecting = inspectionTarget?.inspection;
  const inspectionScope = inspectionTarget?.scope;
  const inspectionSelection = inspectionTarget?.selection;
  const cancelNavigation = useCallback(() => {
    setPendingReveal(undefined);
    restorationRef.current = undefined;
    host.postMessage({
      kind: "cancel-navigation",
      navigationVersion: ++navigationVersionRef.current,
    });
  }, [host]);
  const showScope = useCallback((id: string) => {
    setTraversal((current) => visit(current, id));
  }, []);
  const moveThroughTraversal = useCallback((direction: -1 | 1) => {
    cancelNavigation();
    setTraversal((current) => travel(current, direction));
  }, [cancelNavigation]);
  const navigate = useCallback((direction: "back" | "forward") => {
    host.postMessage({ direction, kind: "navigate" });
  }, [host]);
  useEffect(() => {
    const navigateWithKeys = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        event.altKey === event.shiftKey ||
        (event.code !== "Minus" && event.key !== "-" && event.key !== "_")
      ) {
        return;
      }
      event.preventDefault();
      navigate(event.altKey ? "back" : "forward");
    };
    const navigateWithMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      navigate(event.button === 3 ? "back" : "forward");
    };
    window.addEventListener("keydown", navigateWithKeys, true);
    window.addEventListener("auxclick", navigateWithMouse, true);
    return () => {
      window.removeEventListener("keydown", navigateWithKeys, true);
      window.removeEventListener("auxclick", navigateWithMouse, true);
    };
  }, [navigate]);
  const showPanel = useCallback((kind: NavigationCategory | undefined) => {
    cancelNavigation();
    if (kind === undefined) host.postMessage({ kind: "close-browser" });
    setPanel(kind);
    setInspectionTarget(undefined);
  }, [cancelNavigation, host]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.data === null || typeof event.data !== "object") return;
      const message = event.data as HostToCanvas;
      if (message.kind === "termination-highlight") {
        setTerminationHighlight(message.region === null ? undefined : message);
      } else if (message.kind === "snapshot") {
        navigationVersionRef.current = Math.max(
          navigationVersionRef.current,
          message.navigationVersion,
        );
        setSnapshot(message.snapshot);
        setIdle(false);
      } else if (message.kind === "idle") {
        setSnapshot(undefined);
        setIdle(true);
      } else if (message.kind === "navigate") {
        moveThroughTraversal(message.direction === "back" ? -1 : 1);
      } else if (message.kind === "browser-closed") {
        setBrowserHistory(undefined);
        setPanel(undefined);
        setPendingReveal(undefined);
        setInspectionTarget(undefined);
        restorationRef.current = undefined;
      } else if (message.kind === "navigation-state") {
        setBrowserHistory((current) =>
          current?.canGoBack === message.canGoBack && current.canGoForward === message.canGoForward
            ? current
            : message);
      } else if (message.kind === "reveal") {
        if (message.navigationVersion < navigationVersionRef.current) return;
        navigationVersionRef.current = message.navigationVersion;
        if ("panel" in message) setPanel(message.panel ?? undefined);
        setPendingReveal({
          ...(message.restoration === undefined
            ? {}
            : { restoration: message.restoration }),
          target: message.target,
        });
      }
    };
    window.addEventListener("message", listen);
    host.postMessage({ kind: "ready" });
    return () => window.removeEventListener("message", listen);
  }, [host, moveThroughTraversal, showScope]);

  const scopes = useMemo(
    () => (snapshot === undefined ? {} : snapshotCanvasGraphs(snapshot)),
    [snapshot],
  );
  const ids = Object.keys(scopes);
  const initialScope =
    snapshot?.initial_scope && scopes[snapshot.initial_scope] !== undefined
      ? snapshot.initial_scope
      : ids[0];
  useEffect(() => {
    setTraversal((current) =>
      retainAvailable(current, new Set(ids), initialScope),
    );
  }, [initialScope, scopes]);
  const scopeId = traversal.entries[traversal.cursor];
  const current = scopes[scopeId ?? initialScope];
  const termination = useMemo(
    () => terminationFor(snapshot?.termination, current?.id ?? ""),
    [snapshot?.termination, current?.id],
  );
  const highlightedRegion = highlightedTerminationRegion(snapshot?.termination, current?.id ?? "", terminationHighlight);
  useEffect(() => {
    if (highlightedRegion === undefined) setTerminationHighlight(undefined);
  }, [highlightedRegion, terminationHighlight]);
  const activeWorkflow = activeWorkflowScope(scopes, traversal.entries, traversal.cursor);
  const workflow = activeWorkflow === undefined
    ? undefined
    : {
        id: activeWorkflow.scope.definition,
        ownerGraph: activeWorkflow.scope.ownerGraph,
        scope: activeWorkflow.key,
      };
  const scopeWritable = snapshot?.editable === true && current !== undefined;
  const currentDefinitionTarget = useMemo(
    () => snapshot === undefined || current === undefined
      ? undefined
      : definitionTarget(snapshot, current),
    [current, snapshot],
  );

  useEffect(() => {
    const keepBrowser = panel === undefined && inspecting !== undefined;
    const inspection = keepBrowser ? currentDefinitionTarget?.inspection : undefined;
    setInspectionTarget(inspection === undefined || current === undefined
      ? undefined
      : { inspection, scope: current.id });
    setSelected(undefined);
    if (keepBrowser && inspection === undefined) setPanel("status");
  }, [current?.id]);

  useEffect(() => {
    if (pendingReveal === undefined) return;
    const target = pendingReveal.target;
    const targetWorkflow = target.workflow;
    if (
      scopes[target.scope] === undefined ||
      (targetWorkflow !== undefined && scopes[targetWorkflow.scope] === undefined)
    ) {
      restorationRef.current = pendingReveal.restoration;
      setPendingReveal(undefined);
      return;
    }
    if (targetWorkflow !== undefined && workflow?.scope !== targetWorkflow.scope) {
      setTraversal((currentTraversal) =>
        visit(visit(currentTraversal, targetWorkflow.scope), target.scope)
      );
      return;
    }
    if (current?.id !== target.scope) {
      showScope(target.scope);
      return;
    }
    const selection = target.selection;
    setSelected(selection);
    let inspection = target.inspection;
    let nodes = current.nodes.map(({ id }) => id);
    if (selection?.entity === "nodes" && current.nodes.some(({ id }) => id === selection.id)) {
      inspection ??= current.scope.kind === "workflow"
        ? {
            entity: "workflows",
            id: current.scope.definition,
            subroutine: current.scope.ownerGraph,
            workflow: current.scope.definition,
          }
        : { entity: "nodes", id: selection.id, subroutine: current.id };
      nodes = [selection.id];
    } else if (selection?.entity === "edges") {
      const edge = current.edges.find(({ id }) => id === selection.id);
      if (edge === undefined) {
        inspection = undefined;
      } else {
        inspection ??= { entity: "edges", id: selection.id, subroutine: current.id };
        nodes = [edge.source, edge.target];
      }
    }
    setInspectionTarget(inspection === undefined
      ? undefined
      : { ...target, inspection });
    graphRef.current?.reveal(current.id, nodes);
    restorationRef.current = pendingReveal.restoration;
    setPendingReveal(undefined);
  }, [current, pendingReveal, scopes, showScope, workflow?.scope]);

  useEffect(() => {
    if (current !== undefined) {
      host.postMessage({
        kind: "shown",
        subroutine: current.scope.ownerGraph,
        ...(workflow === undefined ? {} : { workflow }),
      });
    }
  }, [current?.id, host, workflow?.id, workflow?.ownerGraph, workflow?.scope]);

  const send = useCallback(
    (message: CanvasAction) => {
      cancelNavigation();
      if (current !== undefined) {
        const action: CanvasAction = current.scope.kind === "workflow" &&
            (message.kind === "add-profile" || message.kind === "add-session")
          ? { ...message, workflow: current.scope.definition }
          : message;
        host.postMessage({ ...action, subroutine: current.scope.ownerGraph });
      }
    },
    [cancelNavigation, current, host],
  );
  const focused: CanvasSelection | undefined = inspectionScope === current?.id
    ? inspectionSelection ?? (
        inspecting?.entity === "edges" || inspecting?.entity === "nodes"
          ? inspecting
          : undefined
      )
    : undefined;

  const openCall = useCallback(
    (node: SubroutineNode) => {
      cancelNavigation();
      if (snapshot !== undefined && current !== undefined) {
        const target = calledDefinitionTarget(snapshot, current, node);
        if (target !== undefined && scopes[target.scope] !== undefined) {
          setPendingReveal({ target });
          return;
        }
      }
      const child = node.data.definition;
      if (child === undefined) return;
      if (child.scope !== undefined) {
        if (scopes[child.scope] !== undefined) showScope(child.scope);
        return;
      }
      const owner = child.alias
        ? qualifiedKey(child.ownerPath, child.alias)
        : child.ownerPath;
      const target = qualifiedKey(owner, child.graph);
      if (scopes[target] !== undefined) showScope(target);
    },
    [cancelNavigation, current, scopes, showScope, snapshot],
  );

  const propertyInspection = inspecting === undefined || inspectionScope !== current?.id
    ? undefined
    : inspecting;
  const propertyPage = snapshot === undefined || current === undefined || propertyInspection === undefined
    ? undefined
    : entityPropertyPage(
        snapshot,
        current,
        propertyInspection,
        navigationContext(snapshot, current.id),
        inspectionSelection,
      );
  useEffect(() => {
    if (inspecting === undefined || propertyPage !== undefined || pendingReveal !== undefined) return;
    if (inspectionScope !== current?.id) return;
    setInspectionTarget(undefined);
    if (panel === undefined) {
      restorationRef.current = undefined;
      host.postMessage({ kind: "close-browser" });
    }
  }, [current?.id, host, inspecting, inspectionScope, panel, pendingReveal, propertyPage]);
  const browserPage = propertyPage ?? (
    snapshot === undefined || current === undefined || panel === undefined
      ? undefined
      : navigationPage(snapshot, current.id, panel)
  );
  const browserTarget: NavigationTarget | undefined = current === undefined || browserPage === undefined
    ? undefined
    : propertyPage === undefined || propertyInspection === undefined
      ? { scope: current.id, ...(workflow === undefined ? {} : { workflow }) }
      : {
          inspection: propertyInspection,
          scope: current.id,
          ...(workflow === undefined ? {} : { workflow }),
          ...(inspectionSelection === undefined
            ? propertyInspection.entity === "edges" || propertyInspection.entity === "nodes"
              ? { selection: propertyInspection }
              : {}
            : { selection: inspectionSelection }),
        };
  useEffect(() => {
    if (
      browserPage === undefined ||
      browserTarget === undefined ||
      pendingReveal !== undefined
    ) return;
    const restoration = restorationRef.current;
    restorationRef.current = undefined;
    host.postMessage({
      kind: "browse",
      page: browserPage,
      ...(panel === undefined ? {} : { panel }),
      ...(restoration === undefined ? {} : { restoration }),
      target: browserTarget,
    });
  }, [browserPage, browserTarget, host, panel, pendingReveal]);

  if (snapshot === undefined) {
    return (
      <p className="notice">
        {idle
          ? "No project open. Open a Verdog project, or preview a published workflow from the catalogue."
          : "Reading the clone…"}
      </p>
    );
  }

  return (
    <div className="shell">
      <CanvasBar
        canConnect={selected?.entity === "nodes" && current?.nodes.some((node) =>
          node.id === selected.id && current.nodes.some((target) =>
            edgeDirectionProblem(node.data.kind, target.data.kind) === undefined
          )
        ) === true}
        canGoBack={browserHistory?.canGoBack ?? traversal.cursor > 0}
        canGoForward={browserHistory?.canGoForward ?? traversal.cursor + 1 < traversal.entries.length}
        onAction={send}
        onBack={() => navigate("back")}
        onForward={() => navigate("forward")}
        onOverview={currentDefinitionTarget === undefined ? undefined : () => {
          cancelNavigation();
          setPanel(undefined);
          setPendingReveal({ target: currentDefinitionTarget });
        }}
        onPanel={showPanel}
        onTidy={() => graphRef.current?.tidy()}
        panel={panel}
        selected={selected}
        scope={current?.scope.kind}
        termination={termination}
        writable={scopeWritable}
      />
      <div className="flow">
        <GraphCanvas
          current={current}
          focused={focused}
          highlightedRegion={highlightedRegion}
          onConnect={(source, target) => send({ kind: "connect", source, target })}
          onInspect={(selection) => {
            cancelNavigation();
            if (current !== undefined) {
              setInspectionTarget({
                inspection: current.scope.kind === "workflow"
                  ? {
                      entity: "workflows",
                      id: current.scope.definition,
                      subroutine: current.scope.ownerGraph,
                      workflow: current.scope.definition,
                    }
                  : {
                      entity: selection.entity,
                      id: selection.id,
                      subroutine: current.id,
                    } as NavigationInspection,
                scope: current.id,
                selection,
              });
            }
          }}
          onOpenCall={openCall}
          onRelink={(edge, source, target) => send({ edge, kind: "relink", source, target })}
          onRemove={(selection) => send({ ...selection, kind: "remove" })}
          onSelect={setSelected}
          ref={graphRef}
          selected={selected}
          termination={termination}
          writable={scopeWritable && current?.scope.kind === "subroutine"}
        />
      </div>
    </div>
  );
}
