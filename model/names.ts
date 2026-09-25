// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Python keywords, which Verdog identifiers and package components may not use. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  "_", "and", "as", "assert", "async", "await", "break", "case", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "type", "while", "with", "yield",
]);

const MODULE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Human-readable singular name for a schema collection. */
export const entityLabel = (collection: string): string =>
  collection.replaceAll("_", " ").replace(/s$/, "");

/** Why this entity identifier is unacceptable, or `undefined` if it is valid. */
export function identifierProblem(value: string): string | undefined {
  if (!MODULE_KEY.test(value)) {
    return `"${value}" must be lowercase letters, digits and single underscores, starting with a letter.`;
  }
  return KEYWORDS.has(value) ? `"${value}" is a Python keyword.` : undefined;
}

/** Why a canonical lexical definition id is unacceptable. */
export function definitionIdentifierProblem(value: string): string | undefined {
  for (const component of value.split("__")) {
    const problem = identifierProblem(component);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** A package as a directory path: `alice.tools` -> `alice/tools`. */
export function packageDirectory(packageName: string): string {
  return packageName.replaceAll(".", "/");
}

/** Why this package name is unacceptable, or `undefined` if it is valid. */
export function packageProblem(value: string): string | undefined {
  if (!value) return "A package name is required.";
  const halves = value.split(".");
  if (halves.length !== 2) return "A package is `<space>.<name>`, with one separator.";
  for (const half of halves) {
    const problem = identifierProblem(half);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** A package name derived from something a person typed. */
export function packageFrom(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^([0-9])/, "p$1");
  return slug || "project";
}
