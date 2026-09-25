// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import type { ProjectEdge } from "./project";

export type DocumentRefs = {
  declaration: string;
  implementation?: string;
};

export type EntityDocumentRefs = DocumentRefs & {
  visit?: DocumentRefs;
};

/** Conventional generated declaration and optional authored implementation for one module. */
export function moduleDocumentPaths(
  root: string,
  implementation = true,
): DocumentRefs {
  return {
    declaration: `${root}/__init__.py`,
    ...(implementation ? { implementation: `${root}/impl.py` } : {}),
  };
}

/** A visit is the target node's entry handler selected by an incoming edge. */
export function visitDocumentPaths(
  nodeRoot: string,
  edge: Pick<ProjectEdge, "id">,
): DocumentRefs {
  const root = `${nodeRoot}/visit/${edge.id}`;
  return {
    declaration: `${root}/__init__.py`,
    implementation: `${root}/impl.py`,
  };
}

export type DocumentLink = { label: string; path: string };

/** Files owned by one local definition, independent of whether its manifest lists them. */
export function definitionDocumentPaths(
  root: string,
  kind: "subroutine" | "workflow",
): DocumentLink[] {
  return [
    { label: `${kind} declaration`, path: `${root}/__init__.py` },
    { label: `${kind} implementation`, path: `${root}/impl.py` },
    ...(kind === "workflow" ? [{ label: "requirements", path: `${root}/requirements.txt` }] : []),
  ];
}

export type DocumentedEntity =
  | "edges"
  | "features"
  | "nodes"
  | "profile_parameters"
  | "profiles"
  | "session_parameters"
  | "sessions";

type DocumentKind = DocumentedEntity | "visits";

/** Document keys in the order they are worth opening. */
const DOCUMENT_KEYS = [
  "implementation",
  "declaration",
] as const satisfies readonly (keyof DocumentRefs)[];

const ENTITY_LABELS: Record<
  DocumentKind,
  Partial<Record<keyof DocumentRefs, string>>
> = {
  edges: {
    declaration: "edge declaration",
  },
  features: {
    declaration: "feature declaration",
  },
  nodes: {
    declaration: "node declaration",
    implementation: "node implementation",
  },
  profile_parameters: {
    declaration: "profile parameter declaration",
  },
  profiles: {
    declaration: "profile declaration",
    implementation: "profile implementation",
  },
  session_parameters: {
    declaration: "session parameter declaration",
  },
  sessions: {
    declaration: "session declaration",
    implementation: "session implementation",
  },
  visits: {
    declaration: "visit declaration",
    implementation: "visit implementation",
  },
};

export const documentsOf = (
  refs: DocumentRefs | undefined,
  kind: DocumentKind,
): DocumentLink[] =>
  DOCUMENT_KEYS
    .flatMap((key) => {
      const path = refs?.[key];
      const label = ENTITY_LABELS[kind][key];
      return path === undefined || label === undefined
        ? []
        : [{ label, path }];
    })
    .sort((left, right) => left.label.localeCompare(right.label));

export const visitDocumentsOf = (refs: EntityDocumentRefs | undefined): DocumentLink[] =>
  documentsOf(refs?.visit, "visits");
