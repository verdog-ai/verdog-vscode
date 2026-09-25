// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { test } from "node:test";

import { documentationHref } from "./catalogueLinks";

const commit = "a".repeat(40);

test("README links are pinned to the exact release and cannot escape the repository", () => {
  assert.equal(
    documentationHref("guides/use.md", "alice/workflow", commit, "docs/README.md"),
    `https://github.com/alice/workflow/blob/${commit}/docs/guides/use.md`,
  );
  assert.equal(documentationHref("../../../../outside", "alice/workflow", commit, "README.md"), undefined);
  assert.equal(documentationHref("#usage", "alice/workflow", commit, "README.md"), "#usage");
});

test("README links accept HTTPS and refuse executable, local and insecure protocols", () => {
  assert.equal(documentationHref("https://example.test/paper", "alice/workflow", commit, "README.md"), "https://example.test/paper");
  for (const unsafe of [
    "http://example.test/plaintext",
    "command:workbench.action.closeWindow",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) assert.equal(documentationHref(unsafe, "alice/workflow", commit, "README.md"), undefined);
});
