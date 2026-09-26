/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {CatalogueListing, CatalogueRecord} from './catalogue';
import type {Entity, EntityIdentifier, RemovalImpact} from './editing';
import type {ObservationCollection} from './features';
import type {
  AgentProfileId,
  AgentSessionId,
  EdgeId,
  FeatureId,
  GraphId,
  NodeId,
} from './identifiers';
import type {AgentInvokerOptions, AgentProvider} from './project';
import type {ResourceField, ResourceSelection} from './resources';
import type {ProjectSnapshot} from './snapshot';
import type {DefinitionTerminationState} from './termination';

type EntityAction<Kind extends 'name' | 'remove' | 'rename'> = {
  [EntityKind in Entity]: {
    entity: EntityKind;
    id: EntityIdentifier<EntityKind>;
    kind: Kind;
  };
}[Entity];

export type CanvasAction =
  | {kind: 'add-call'}
  | {kind: 'add-definition'}
  | {kind: 'add-feature'}
  | {kind: 'add-node'}
  | {kind: 'add-profile'; workflow?: GraphId}
  | {kind: 'add-session'; workflow?: GraphId}
  | {kind: 'connect'; source: NodeId; target?: NodeId}
  | (EntityAction<'name'> & {name: string; workflow?: GraphId})
  | (EntityAction<'rename'> & {to: string})
  | {edge: EdgeId; kind: 'constrain'}
  | {
      collection: ObservationCollection;
      edge: EdgeId;
      feature: FeatureId;
      kind: 'unconstrain';
    }
  | {edge: EdgeId; kind: 'relink'; source: NodeId; target: NodeId}
  | {edge: EdgeId; endpoint: 'source' | 'target'; kind: 'relink-endpoint'}
  | {
      kind: 'set-node-resources';
      node: NodeId;
      resources: Array<{
        parameter?: string;
        resource: 'profile' | 'session';
        value: string;
      }>;
    }
  | {
      kind: 'set-workflow-resources';
      workflow: GraphId;
      resources: Array<{
        parameter?: string;
        resource: 'profile' | 'session';
        value: string;
      }>;
    }
  | {
      kind: 'set-profile-configuration';
      options: AgentInvokerOptions;
      profile: AgentProfileId;
      provider: AgentProvider;
      workflow?: GraphId;
    }
  | {
      kind: 'set-session-persistence';
      persistent: boolean;
      session: AgentSessionId;
      workflow?: GraphId;
    }
  | (EntityAction<'remove'> & {workflow?: GraphId});

export type NavigationCategory =
  'features' | 'profiles' | 'sessions' | 'status' | 'subroutines' | 'workflows';

export type EntityNavigationCategory = Exclude<NavigationCategory, 'status'>;

export type CanvasSelection =
  {entity: 'edges'; id: EdgeId} | {entity: 'nodes'; id: NodeId};

export type NavigationInspection = {
  [Kind in Entity]: {
    entity: Kind;
    id: EntityIdentifier<Kind>;
    subroutine: string;
    workflow?: GraphId;
  };
}[Entity];

export interface WorkflowContext {
  id: GraphId;
  ownerGraph: string;
  scope: string;
}

export interface NavigationTarget {
  inspection?: NavigationInspection;
  scope: string;
  selection?: CanvasSelection;
  workflow?: WorkflowContext;
}

export interface NavigationEntry {
  children: NavigationEntry[];
  declaration?: string;
  entity: Entity;
  id: string;
  key: string;
  meta: string[];
  removal?: NavigationInspection;
  removalBlocked?: string;
  scope: string[];
  target?: NavigationTarget;
}

export interface EntityNavigationPage {
  category: EntityNavigationCategory;
  context?: string;
  entries: NavigationEntry[];
  title: string;
}

export interface StatusNavigationPage {
  category: 'status';
  context?: string;
  status: {
    checked: boolean;
    diagnosticCount: number;
    graphHash: string;
    location: string;
    pinned: boolean;
    stale: boolean;
  };
  title: string;
  termination?: TerminationNavigation;
}

export interface TerminationNavigation {
  state: DefinitionTerminationState;
  entries: NavigationEntry[];
}

export interface EdgeConstraint {
  collection: ObservationCollection;
  expression: string;
  feature: FeatureId;
}

export interface ProfileConfiguration {
  options: AgentInvokerOptions;
  provider: AgentProvider;
}

export interface PropertyNavigationPage {
  category: 'entity';
  constraintsWritable: boolean;
  context: string;
  documents: Array<{label: string; path: string}>;
  entity: Entity;
  entries: NavigationEntry[];
  constraints?: EdgeConstraint[];
  fields: Array<{label: string; value: string}>;
  id: string;
  idWritable: boolean;
  kind: string;
  name: string;
  nameWritable: boolean;
  persistent?: boolean;
  profile?: ProfileConfiguration;
  resources: ResourceField[];
  resourcesWritable: boolean;
  settingsWritable: boolean;
  title: string;
  termination?: TerminationNavigation;
}

export type NavigationPage =
  EntityNavigationPage | PropertyNavigationPage | StatusNavigationPage;

export type NavigationPropertyEdit =
  | {kind: 'constrain'}
  | {kind: 'name'; name: string}
  | {kind: 'profile'; profile: ProfileConfiguration}
  | {kind: 'rename'; to: string}
  | {fields: ResourceSelection[]; kind: 'resources'}
  | {kind: 'session-persistence'; persistent: boolean}
  | {
      collection: ObservationCollection;
      feature: FeatureId;
      kind: 'unconstrain';
    };

export type CanvasToHost =
  | (CanvasAction & {subroutine: string})
  | {direction: 'back' | 'forward'; kind: 'navigate'}
  | {
      kind: 'browse';
      page: Pick<NavigationPage, 'category'>;
      panel?: NavigationCategory;
      restoration?: string;
      target: NavigationTarget;
    }
  | {kind: 'cancel-navigation'; navigationVersion: number}
  | {kind: 'close-browser'}
  | {kind: 'ready'}
  | {kind: 'shown'; subroutine: string; workflow?: WorkflowContext};

export type HostToCanvas =
  | {
      kind: 'termination-highlight';
      scope: string;
      region: string | null;
      revision: string;
    }
  | {kind: 'browser-closed'}
  | {canGoBack: boolean; canGoForward: boolean; kind: 'navigation-state'}
  | {kind: 'idle'}
  | {direction: 'back' | 'forward'; kind: 'navigate'}
  | {
      kind: 'reveal';
      navigationVersion: number;
      panel?: NavigationCategory | null;
      restoration?: string;
      target: NavigationTarget;
    }
  | {kind: 'snapshot'; navigationVersion: number; snapshot: ProjectSnapshot};

export interface PropertyRequest {
  edit: NavigationPropertyEdit;
  kind: 'property';
  requestId: number;
  route: string;
}

export interface PropertyResult {
  kind: 'property-result';
  requestId: number;
  route: string;
  saved: boolean;
}

export type NavigationBrowserToHost =
  | {
      kind: 'termination-highlight';
      route: string;
      region: string | null;
      revision: string;
    }
  | {kind: 'ready'}
  | {kind: 'close'}
  | {direction: 'back' | 'forward'; kind: 'navigate'}
  | {kind: 'open-document'; path: string; route: string}
  | {kind: 'overview'; route: string}
  | PropertyRequest
  | {key: string; kind: 'remove'; route: string}
  | {key: string; kind: 'open' | 'reveal'; route: string};

export interface NavigationPageMessage {
  canGoBack: boolean;
  canGoForward: boolean;
  kind: 'page';
  overview?: NavigationTarget;
  page: NavigationPage;
  retainedRoutes: readonly string[];
  route: string;
}

export type HostToNavigationBrowser = NavigationPageMessage | PropertyResult;

export type CatalogueToHost =
  | {entry: string; kind: 'open-record' | 'select-release'}
  | {href: string; kind: 'open-external'}
  | {cursor: string; kind: 'load-more'}
  | {
      kind: 'search';
      query: string;
      visibility: 'all' | 'mine' | 'public' | 'restricted';
    }
  | {
      kind:
        | 'copy-reference'
        | 'import'
        | 'inspect'
        | 'open-source'
        | 'retry-readme'
        | 'show-output';
    }
  | {kind: 'ready'}
  | {kind: 'refresh'};

export type HostToCatalogue =
  | {kind: 'listing'; listing: CatalogueListing}
  | {kind: 'record'; record: CatalogueRecord};

export type RemovalReviewToHost =
  | {kind: 'ready'}
  | {kind: 'cancel'}
  | {kind: 'delete'}
  | {index: number; kind: 'open' | 'reveal'};

export interface HostToRemovalReview {
  kind: 'review';
  review: {
    hasAuthoredCode: boolean;
    impacts: RemovalImpact[];
    orphaned: string[];
    reset: boolean;
    subject: {entity: Entity; id: string; label: string};
  };
}
