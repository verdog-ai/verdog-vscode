/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {ReactNode} from 'react';

import type {Entity} from '../model/editing';

export interface EntityTreeItem {
  entity: Entity;
  id: string;
  scope: readonly string[];
}

export interface EntityTreeData<Item extends EntityTreeItem> {
  collections: Map<Entity, Item[]>;
  scopes: Map<string, EntityTreeData<Item>>;
}

const COLLECTION_LABELS: Record<Entity, string> = {
  edges: 'Edges',
  features: 'Features',
  nodes: 'Nodes',
  profile_parameters: 'Profile parameters',
  profiles: 'Profiles',
  session_parameters: 'Session parameters',
  sessions: 'Sessions',
  subroutines: 'Subroutines',
  workflows: 'Workflows',
};

function emptyTree<Item extends EntityTreeItem>(): EntityTreeData<Item> {
  return {
    collections: new Map(),
    scopes: new Map(),
  };
}

export function entityTree<Item extends EntityTreeItem>(
  items: readonly Item[],
): EntityTreeData<Item> {
  const root = emptyTree<Item>();
  for (const item of items) {
    let branch = root;
    for (const scope of item.scope) {
      let child = branch.scopes.get(scope);
      if (child === undefined) {
        child = emptyTree();
        branch.scopes.set(scope, child);
      }
      branch = child;
    }
    const collection = branch.collections.get(item.entity) ?? [];
    collection.push(item);
    branch.collections.set(item.entity, collection);
  }
  return root;
}

function TreeContents<Item extends EntityTreeItem>({
  ancestry = [],
  renderItem,
  tree,
}: {
  ancestry?: readonly string[];
  renderItem: (item: Item) => ReactNode;
  tree: EntityTreeData<Item>;
}) {
  const scopes = [...tree.scopes].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const collections = [...tree.collections].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    <ul className="tree">
      {collections.map(([collection, items]) => (
        <li key={collection}>
          <details
            data-disclosure={JSON.stringify([
              'collection',
              ...ancestry,
              collection,
            ])}
            open
          >
            <summary>
              <span>{COLLECTION_LABELS[collection]}</span>
              <span className="count">{items.length}</span>
            </summary>
            <ul className="tree">
              {[...items]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map(renderItem)}
            </ul>
          </details>
        </li>
      ))}
      {scopes.map(([scope, child]) => (
        <li key={scope}>
          <details
            data-disclosure={JSON.stringify(['scope', ...ancestry, scope])}
            open
          >
            <summary>
              <code>{scope}</code>
            </summary>
            <TreeContents
              ancestry={[...ancestry, scope]}
              renderItem={renderItem}
              tree={child}
            />
          </details>
        </li>
      ))}
    </ul>
  );
}

export function EntityTree<Item extends EntityTreeItem>({
  items,
  renderItem,
}: {
  items: readonly Item[];
  renderItem: (item: Item) => ReactNode;
}) {
  return <TreeContents renderItem={renderItem} tree={entityTree(items)} />;
}
