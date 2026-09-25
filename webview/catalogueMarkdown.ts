// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Keep the catalogue record title as the document's sole level-one heading. */
export function demoteDocumentationHeadings(tokens: { tag: string }[]): void {
  for (const token of tokens) {
    const level = /^h([1-6])$/.exec(token.tag)?.[1];
    if (level !== undefined) token.tag = `h${Math.min(6, Number(level) + 1)}`;
  }
}
