/** Fault-tolerant reads of the project document while an author is typing it. */

import {
  findNodeAtLocation,
  getLocation,
  parse,
  parseTree,
  type JSONPath,
  type Node,
} from "jsonc-parser";

import { isFeatureKind, type Feature } from "./features";
import {
  CALL_DEFINITION_KIND,
  callTargets,
  subroutineInProject,
  type CallTarget,
  type CallNodeKind,
} from "./project";
import { array, entries } from "./reading";

const COLLECTIONS = [
  "conditions",
  "effects",
  "edges",
  "features",
  "nodes",
  "profile_parameters",
  "profiles",
  "session_parameters",
  "sessions",
  "subroutines",
  "workflows",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type CompletionContext = {
  /** The innermost authorable array containing the cursor. */
  collection: Collection | undefined;
  /** The feature named by the surrounding condition or effect. */
  feature: string | undefined;
  /** Whether the cursor is at a new item in the enclosing collection. */
  insertion: boolean;
  /** The property value currently being completed. */
  property: "feature_id" | "observation" | "target" | "value" | undefined;
  /** The kind of call surrounding a target completion. */
  callKind: CallNodeKind | undefined;
  /** The subroutine graph containing the cursor. */
  subroutine: string | undefined;
};

const isCollection = (value: unknown): value is Collection =>
  typeof value === "string" && COLLECTIONS.some((collection) => collection === value);

function enclosingCollection(
  path: JSONPath,
): { collection: Collection; pathIndex: number } | undefined {
  for (let pathIndex = path.length - 2; pathIndex >= 0; pathIndex -= 1) {
    const collection = path[pathIndex];
    if (isCollection(collection) && typeof path[pathIndex + 1] === "number") {
      return { collection, pathIndex };
    }
  }
  return undefined;
}

function stringAt(root: Node | undefined, path: JSONPath): string | undefined {
  if (root === undefined) return undefined;
  const value = findNodeAtLocation(root, path)?.value;
  return typeof value === "string" ? value : undefined;
}

/** The completion context at an offset, including in an incomplete JSON value. */
export function contextAt(text: string, offset: number): CompletionContext {
  const location = getLocation(text, Math.max(0, Math.min(offset, text.length)));
  const path = location.path;
  const enclosing = enclosingCollection(path);
  const current = path[path.length - 1];
  const property =
    !location.isAtPropertyKey &&
    (current === "feature_id" ||
      current === "observation" ||
      current === "target" ||
      current === "value")
      ? current
      : undefined;
  const root = parseTree(text);
  const bodyPaths: JSONPath[] = path[0] === "subroutine" ? [["subroutine"]] : [];
  for (let index = 0; index < path.length - 1; index += 1) {
    if (path[index] === "subroutines" && typeof path[index + 1] === "number") {
      bodyPaths.push(path.slice(0, index + 2));
    }
  }
  const itemPath = enclosing === undefined
    ? undefined
    : path.slice(0, enclosing.pathIndex + 2);
  const kind = itemPath === undefined ? undefined : stringAt(root, [...itemPath, "kind"]);
  const scope = bodyPaths.map((bodyPath) => stringAt(root, [...bodyPath, "id"]));

  return {
    callKind:
      kind === "workflow_call" || kind === "subroutine_call" ? kind : undefined,
    collection: enclosing?.collection,
    feature:
      (property === "observation" || property === "value") && itemPath !== undefined
        ? stringAt(root, [...itemPath, "feature_id"])
        : undefined,
    insertion:
      enclosing !== undefined && path.length === enclosing.pathIndex + 2,
    property,
    subroutine: scope.length > 0 && scope.every((id): id is string => id !== undefined)
      ? scope.join("__")
      : undefined,
  };
}

/** Valid feature declarations from an already-decoded project, optionally scoped by subroutine. */
export function featuresIn(project: unknown, subroutine: string | undefined): Feature[] {
  const found: Feature[] = [];
  const bodies = subroutine === undefined ? [] : [subroutineInProject(project, subroutine)];
  for (const body of bodies) {
    if (body === undefined) continue;
    for (const feature of entries(body.features)) {
      if (typeof feature.id !== "string" || !isFeatureKind(feature.kind)) continue;
      const common = {
        id: feature.id,
        label: typeof feature.label === "string" ? feature.label : feature.id,
      };
      if (feature.kind === "enum") {
        found.push({
          ...common,
          kind: "enum",
          values: array(feature.values).filter((value): value is string =>
            typeof value === "string"
          ),
        });
      } else {
        found.push({ ...common, kind: feature.kind });
      }
    }
  }
  return found;
}

/** Valid feature declarations recovered from a possibly incomplete project document. */
export const documentFeatures = (text: string, subroutine: string | undefined): Feature[] =>
  featuresIn(parse(text) as unknown, subroutine);

/** Definitions a call at this cursor may target, recovered from an incomplete document. */
export function documentDefinitions(
  text: string,
  subroutine: string | undefined,
  callKind: CallNodeKind | undefined,
  external: readonly CallTarget[] = [],
): CallTarget[] {
  if (subroutine === undefined || callKind === undefined) return [];
  return callTargets(
    parse(text) as unknown,
    subroutine,
    CALL_DEFINITION_KIND[callKind],
    external,
  );
}
