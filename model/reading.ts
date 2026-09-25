// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Reading a graph that somebody may be halfway through typing.
 *
 * Named `reading` rather than `graph`, which it was: `src/graph.ts` already owns that word for
 * graph *hashing*, and `clone.ts` imports from both -- so one file had two imports spelled
 * `graph` that meant different things.
 *
 * The counterpart to `json.ts`, and the opposite discipline: those validators throw, which is
 * right for data arriving from our own backend, where a bad shape means the backend is broken.
 * `project.json` is a file an author edits by hand, so a missing key is a normal intermediate
 * state -- and throwing on one would blank the canvas over a half-typed line rather than draw
 * what is there and let the compiler explain the rest.
 *
 * Here rather than in three modules, which is where these were: `editing`, `agents` and
 * `propertyData` each carried a copy, and copies of a convention are what this repository has
 * been bitten by most.
 */

/** An object, or an empty one. Arrays are not objects for this purpose. */
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** An array, or an empty one. */
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An array of objects -- a graph's `nodes`, `edges`, `features`, `externals`, `sources`. */
export const entries = (value: unknown): Record<string, unknown>[] =>
  array(value).map((item) => object(item));

/** A string, or an empty one. */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
