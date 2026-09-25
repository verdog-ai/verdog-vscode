// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  retainAvailable,
  startTraversal,
  travel,
  visit,
} from "../webview/traversal";

test("canvas traversal follows callers and keeps browser-style forward history", () => {
  let traversal = startTraversal("root");
  traversal = visit(traversal, "caller");
  traversal = visit(traversal, "shared/deep");

  traversal = travel(traversal, -1);
  assert.equal(traversal.entries[traversal.cursor], "caller");
  traversal = travel(traversal, -1);
  assert.equal(traversal.entries[traversal.cursor], "root");
  traversal = travel(traversal, 1);
  assert.equal(traversal.entries[traversal.cursor], "caller");

  traversal = visit(traversal, "other");
  assert.deepEqual(traversal, { cursor: 2, entries: ["root", "caller", "other"] });
  assert.strictEqual(travel(traversal, 1), traversal);

  traversal = retainAvailable(traversal, new Set(["root", "other"]), "root");
  assert.deepEqual(traversal, { cursor: 1, entries: ["root", "other"] });
  assert.deepEqual(retainAvailable(traversal, new Set(["root"]), "root"), {
    cursor: 0,
    entries: ["root"],
  });
});
