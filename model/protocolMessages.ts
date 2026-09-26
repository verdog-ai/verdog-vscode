/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import {isAgentProvider} from './agents';
import type {
  CanvasToHost,
  CatalogueToHost,
  NavigationBrowserToHost,
  RemovalReviewToHost,
} from './protocol';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function entity(value: unknown): boolean {
  return [
    'edges',
    'features',
    'nodes',
    'profile_parameters',
    'profiles',
    'session_parameters',
    'sessions',
    'subroutines',
    'workflows',
  ].some(kind => value === kind);
}

function category(value: unknown): boolean {
  return [
    'features',
    'profiles',
    'sessions',
    'status',
    'subroutines',
    'workflows',
  ].some(kind => value === kind);
}

function direction(value: unknown): boolean {
  return value === 'back' || value === 'forward';
}

function workflow(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.ownerGraph === 'string' &&
    typeof value.scope === 'string'
  );
}

function target(value: unknown): boolean {
  if (!record(value) || typeof value.scope !== 'string') {
    return false;
  }
  const {inspection, selection} = value;
  return (
    (value.workflow === undefined || workflow(value.workflow)) &&
    (inspection === undefined ||
      (record(inspection) &&
        entity(inspection.entity) &&
        typeof inspection.id === 'string' &&
        typeof inspection.subroutine === 'string' &&
        optionalString(inspection.workflow))) &&
    (selection === undefined ||
      (record(selection) &&
        (selection.entity === 'nodes' || selection.entity === 'edges') &&
        typeof selection.id === 'string'))
  );
}

function profile(value: unknown): boolean {
  if (
    !record(value) ||
    !isAgentProvider(value.provider) ||
    !record(value.options)
  ) {
    return false;
  }
  const options = value.options;
  return (
    (options.model === null || typeof options.model === 'string') &&
    (options.reasoning_effort === null ||
      typeof options.reasoning_effort === 'string') &&
    Array.isArray(options.extra_args) &&
    options.extra_args.every(item => typeof item === 'string')
  );
}

function resources(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        record(item) &&
        (item.resource === 'profile' || item.resource === 'session') &&
        typeof item.value === 'string' &&
        optionalString(item.parameter),
    )
  );
}

function constraint(value: Record<string, unknown>): boolean {
  return (
    (value.collection === 'conditions' || value.collection === 'effects') &&
    typeof value.feature === 'string'
  );
}

function property(value: unknown): boolean {
  if (!record(value)) {
    return false;
  }
  switch (value.kind) {
    case 'constrain':
      return true;
    case 'unconstrain':
      return constraint(value);
    case 'name':
      return typeof value.name === 'string';
    case 'rename':
      return typeof value.to === 'string';
    case 'profile':
      return profile(value.profile);
    case 'session-persistence':
      return typeof value.persistent === 'boolean';
    case 'resources':
      return resources(value.fields);
    default:
      return false;
  }
}

/** Check wire shapes only; the host/model still owns authorization and graph semantics. */
export function isCanvasToHost(value: unknown): value is CanvasToHost {
  if (!record(value)) {
    return false;
  }
  switch (value.kind) {
    case 'ready':
    case 'close-browser':
      return true;
    case 'navigate':
      return direction(value.direction);
    case 'cancel-navigation':
      return (
        Number.isSafeInteger(value.navigationVersion) &&
        Number(value.navigationVersion) >= 0
      );
    case 'shown':
      return (
        typeof value.subroutine === 'string' &&
        (value.workflow === undefined || workflow(value.workflow))
      );
    case 'browse':
      return (
        record(value.page) &&
        (value.page.category === 'entity' || category(value.page.category)) &&
        target(value.target) &&
        (value.panel === undefined || category(value.panel)) &&
        optionalString(value.restoration)
      );
    default:
      break;
  }
  if (typeof value.subroutine !== 'string' || !optionalString(value.workflow)) {
    return false;
  }
  switch (value.kind) {
    case 'add-call':
    case 'add-definition':
    case 'add-feature':
    case 'add-node':
    case 'add-profile':
    case 'add-session':
      return true;
    case 'connect':
      return typeof value.source === 'string' && optionalString(value.target);
    case 'name':
      return (
        entity(value.entity) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string'
      );
    case 'rename':
      return (
        entity(value.entity) &&
        typeof value.id === 'string' &&
        typeof value.to === 'string'
      );
    case 'remove':
      return entity(value.entity) && typeof value.id === 'string';
    case 'constrain':
      return typeof value.edge === 'string';
    case 'unconstrain':
      return typeof value.edge === 'string' && constraint(value);
    case 'relink':
      return (
        typeof value.edge === 'string' &&
        typeof value.source === 'string' &&
        typeof value.target === 'string'
      );
    case 'relink-endpoint':
      return (
        typeof value.edge === 'string' &&
        (value.endpoint === 'source' || value.endpoint === 'target')
      );
    case 'set-node-resources':
      return typeof value.node === 'string' && resources(value.resources);
    case 'set-workflow-resources':
      return typeof value.workflow === 'string' && resources(value.resources);
    case 'set-profile-configuration':
      return typeof value.profile === 'string' && profile(value);
    case 'set-session-persistence':
      return (
        typeof value.session === 'string' &&
        typeof value.persistent === 'boolean'
      );
    default:
      return false;
  }
}

export function isNavigationBrowserToHost(
  value: unknown,
): value is NavigationBrowserToHost {
  if (!record(value)) {
    return false;
  }
  switch (value.kind) {
    case 'ready':
    case 'close':
      return true;
    case 'navigate':
      return direction(value.direction);
    default:
      break;
  }
  if (typeof value.route !== 'string') {
    return false;
  }
  switch (value.kind) {
    case 'overview':
      return true;
    case 'open-document':
      return typeof value.path === 'string';
    case 'remove':
    case 'open':
    case 'reveal':
      return typeof value.key === 'string';
    case 'termination-highlight':
      return (
        typeof value.revision === 'string' &&
        (value.region === null || typeof value.region === 'string')
      );
    case 'property':
      return (
        Number.isSafeInteger(value.requestId) &&
        Number(value.requestId) >= 0 &&
        property(value.edit)
      );
    default:
      return false;
  }
}

export function isCatalogueToHost(value: unknown): value is CatalogueToHost {
  if (!record(value)) {
    return false;
  }
  switch (value.kind) {
    case 'ready':
    case 'refresh':
    case 'copy-reference':
    case 'import':
    case 'inspect':
    case 'open-source':
    case 'retry-readme':
    case 'show-output':
      return true;
    case 'open-record':
    case 'select-release':
      return typeof value.entry === 'string';
    case 'open-external':
      return typeof value.href === 'string';
    case 'load-more':
      return typeof value.cursor === 'string';
    case 'search':
      return (
        typeof value.query === 'string' &&
        ['all', 'mine', 'public', 'restricted'].some(
          visibility => value.visibility === visibility,
        )
      );
    default:
      return false;
  }
}

export function isRemovalReviewToHost(
  value: unknown,
): value is RemovalReviewToHost {
  if (!record(value)) {
    return false;
  }
  switch (value.kind) {
    case 'ready':
    case 'cancel':
    case 'delete':
      return true;
    case 'open':
    case 'reveal':
      return Number.isSafeInteger(value.index) && Number(value.index) >= 0;
    default:
      return false;
  }
}
