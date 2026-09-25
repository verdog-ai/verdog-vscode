// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
export type Traversal = {
  cursor: number;
  entries: readonly string[];
};

export const startTraversal = (initial?: string): Traversal =>
  initial === undefined ? { cursor: -1, entries: [] } : { cursor: 0, entries: [initial] };

export function visit(traversal: Traversal, subroutine: string): Traversal {
  if (traversal.entries[traversal.cursor] === subroutine) return traversal;
  const entries = [...traversal.entries.slice(0, traversal.cursor + 1), subroutine];
  return { cursor: entries.length - 1, entries };
}

export function travel(traversal: Traversal, direction: -1 | 1): Traversal {
  const cursor = traversal.cursor + direction;
  return cursor < 0 || cursor >= traversal.entries.length
    ? traversal
    : { ...traversal, cursor };
}

export function retainAvailable(
  traversal: Traversal,
  available: ReadonlySet<string>,
  initial?: string,
): Traversal {
  const active = traversal.entries[traversal.cursor];
  if (active === undefined || !available.has(active)) return startTraversal(initial);
  const before = traversal.entries.slice(0, traversal.cursor).filter((id) => available.has(id));
  const after = traversal.entries.slice(traversal.cursor + 1).filter((id) => available.has(id));
  if (before.length + after.length + 1 === traversal.entries.length) return traversal;
  return { cursor: before.length, entries: [...before, active, ...after] };
}
