/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Reads partially edited graph documents without rejecting missing fields.
 * Invalid or unfinished values yield empty containers; the compiler reports
 * validation errors separately.
 */

/** An object, or an empty one. Arrays are not objects for this purpose. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** An array, or an empty one. */
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** An array of objects -- a graph's `nodes`, `edges`, `features`, `externals`, `sources`. */
export function entries(value: unknown): Array<Record<string, unknown>> {
  return array(value).map(item => object(item));
}

/** A string, or an empty one. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
