/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import type { RemovalImpact } from "../model/editing";
import { graphId } from "../model/identifiers";
import { entityTree } from "./EntityTree";
import { sectionOf } from "./removalReview";

test("removal impacts are grouped by consequence and semantic scope", () => {
  const main = graphId("main");
  const child = graphId("main__generator");
  const impacts: RemovalImpact[] = [
    {
      effect: "delete",
      entity: "subroutines",
      id: child,
      reasons: ["selected"],
      scope: [main],
    },
    {
      effect: "delete",
      entity: "nodes",
      id: "call_generator",
      reasons: ["calls_deleted_target"],
      scope: [main],
    },
    {
      effect: "update",
      entity: "nodes",
      id: "call_self",
      reasons: ["reference_removed"],
      scope: [main, child],
    },
  ];

  assert.deepEqual(impacts.map(sectionOf), ["selected", "deleted", "updated"]);
  const tree = entityTree(impacts);
  const root = tree.scopes.get(main);
  assert.ok(root);
  assert.deepEqual([...root.collections.keys()], ["subroutines", "nodes"]);
  assert.equal(root.scopes.get(child)?.collections.get("nodes")?.[0]?.id, "call_self");
});
