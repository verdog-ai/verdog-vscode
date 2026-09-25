/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/** @fileoverview Exact Git arguments for resolving the dependency graph of an inspected release. */
export const SUBMODULE_SYNC_ARGUMENTS = [
  'submodule',
  'sync',
  '--recursive',
] as const;

export const SUBMODULE_UPDATE_ARGUMENTS = [
  'submodule',
  'update',
  '--init',
  '--recursive',
  '--depth',
  '1',
] as const;
