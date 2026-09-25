/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {
  DefinitionKind,
  LocalWorkflowDefinition,
  NodeKind,
  SubroutineDefinition,
} from '../model/project';
import type {DocumentLink} from '../model/documents';
import type {EdgeId, GraphId, NodeId} from '../model/identifiers';

/// Which subroutine a definition or call opens. `alias` is present for an external child and
/// names its owner-local checkout. `ownerPath` qualifies children of a pinned project.
export interface DefinitionRef {
  alias?: string;
  graph: GraphId;
  ownerPath?: string;
  /** A workflow call opens its process boundary before entering `graph`. */
  scope?: string;
}

export interface DefinitionItem {
  /** The authored identity occurs more than once, so navigation must not guess a target. */
  ambiguous?: true;
  /** The graph that owns this definition. Deleting the root subroutine resets it. */
  declaredIn?: string;
  /** Generated and authored files owned by this definition. */
  documents: DocumentLink[];
  id: GraphId;
  /** Stable across kinds and pinned projects. */
  key: string;
  kind: DefinitionKind;
  /** A graph in the project that owns this declaration, used to locate its clone. */
  ownerGraph: string;
  /** Canvas scope opened by this definition. */
  scope?: string;
  /** The canonical subroutine graph this definition opens. Absent when it cannot be resolved. */
  target?: string;
  /** The local workflow envelope represented by this definition. */
  workflow?: LocalWorkflowDefinition;
}

interface SubroutineNodeData {
  definition?: DefinitionRef;
  kind: NodeKind;
  label: string;
  /** The called subroutine's authored implementation module. */
  implementation?: string;
}

export interface SubroutineNode {
  data: SubroutineNodeData;
  id: NodeId;
}

export interface SubroutineEdge {
  id: EdgeId;
  source: NodeId;
  target: NodeId;
}

export interface SubroutineGraph {
  edges: SubroutineEdge[];
  /**
   * Unique across everything the canvas can draw.
   *
   * For your own subroutines this is the definition id. For one belonging to a pinned
   * dependency it is `<alias path>/<id>`, because two projects may both define a subroutine
   * `main` and the canvas now holds both at once.
   */
  id: string;
  nodes: SubroutineNode[];
  scope:
    | {kind: 'subroutine'; ownerGraph: string}
    | {
        definition: GraphId;
        kind: 'workflow';
        ownerGraph: string;
        target: SubroutineDefinition;
        workflow: LocalWorkflowDefinition;
      };
}

export type SubroutineMap = Record<string, SubroutineGraph>;
