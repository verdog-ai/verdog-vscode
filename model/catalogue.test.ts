import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogueMetadataDifferences,
  decodeCatalogueDescriptor,
  decodeCatalogueDetail,
  decodeCatalogueEntry,
  decodeCatalogueListing,
} from "./catalogue";

const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-a${digit.repeat(3)}-${digit.repeat(12)}`;

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  closure: [{ commit: "b".repeat(40), repository: "publisher/library" }],
  commit: "a".repeat(40),
  description: "A published workflow.",
  id: id("1"),
  package: "publisher.workflow",
  published_at: "2026-09-02T10:00:00+00:00",
  releases: [{
    commit: "a".repeat(40),
    id: id("2"),
    published_at: "2026-09-02T10:00:00+00:00",
  }],
  repository: "publisher/workflow",
  scope: "public",
  workflow_id: "main__review",
  ...overrides,
});

test("catalogue entries are decoded and dependency counts are derived", () => {
  const decoded = decodeCatalogueEntry(entry());
  assert.equal(decoded.dependency_count, 1);
  assert.equal(decoded.repository, "publisher/workflow");
  assert.equal(decoded.releases?.[0].commit, "a".repeat(40));
});

test("a malformed row cannot control a preview identity or poison valid siblings", () => {
  const decoded = decodeCatalogueListing({
    entries: [entry(), entry({ repository: "../outside" })],
    login: "reader",
  });
  assert.equal(decoded.entries.length, 1);
  assert.equal(decoded.rejected.length, 1);
  assert.match(decoded.rejected[0], /owner\/repository/);
  assert.equal(decoded.login, "reader");
});

test("commit, workflow, package and closure shapes are checked at the boundary", () => {
  for (const malformed of [
    entry({ commit: "main" }),
    entry({ workflow_id: "../../main" }),
    entry({ package: "../../package" }),
    entry({ closure: [{ commit: "b".repeat(40), repository: "owner/../repo" }] }),
  ]) {
    assert.throws(() => decodeCatalogueEntry(malformed));
  }
});

test("new records retain visibility, ports, environment and exact release metadata", () => {
  const decoded = decodeCatalogueDetail(entry({
    display_name: "Review evidence",
    environment: { python: ">=3.12", requirements: ["z>=1", "a==2"], schema_version: 32 },
    preview: {
      edges: [{ id: "enter__exit", name: "Continue", source: "enter", target: "exit" }],
      features: [{ id: "proved", kind: "boolean", name: "Proved" }],
      name: "Review evidence",
      nodes: [
        { id: "enter", kind: "enter", name: "Enter" },
        { id: "exit", kind: "exit", name: "Exit" },
      ],
      ports: { enter: "enter", exit: "exit", failure: "failure" },
    },
    published_by_me: true,
    repository_dependency_count: 1,
    release_count: 4,
    scope: "private",
    updated_at: "2026-09-03T10:00:00+00:00",
    visibility: "restricted",
  }));
  assert.equal(decoded.visibility, "restricted");
  assert.equal(decoded.release_count, 4);
  assert.equal(decoded.published_by_me, true);
  assert.deepEqual(decoded.preview?.ports, { enter: "enter", exit: "exit", failure: "failure" });
  assert.deepEqual(decoded.environment?.requirements, ["a==2", "z>=1"]);
});

test("malformed environment claims cannot be normalized into a successful inspection", () => {
  for (const environment of [
    { requirements: "package==1" },
    { requirements: ["package==1", 3] },
    { requirements: ["package==1", "package==1"] },
    { requirements: [], schema_version: 0 },
    { python: "", requirements: [] },
  ]) assert.throws(() => decodeCatalogueDetail(entry({ environment })));
});

test("inspection compares the exact source descriptor including workflow ports", () => {
  const preview = {
    edges: [{ id: "enter__exit", name: "Continue", source: "enter", target: "exit" }],
    features: [],
    name: "Main",
    nodes: [
      { id: "enter", kind: "enter", name: "Enter" },
      { id: "exit", kind: "exit", name: "Exit" },
    ],
    ports: { enter: "enter", exit: "exit", failure: "failure" },
  };
  const detail = decodeCatalogueDetail(entry({
    display_name: "Main",
    environment: { python: ">=3.12", requirements: [], schema_version: 32 },
    preview,
  }));
  const descriptor = decodeCatalogueDescriptor({
    closure: [{ commit: "b".repeat(40), owner: "publisher", name: "library" }],
    display_name: "Main",
    environment: { python: ">=3.12", requirements: [], schema_version: 32 },
    package: "publisher.workflow",
    preview,
    schema_version: 32,
    workflow_id: "main__review",
  });
  assert.deepEqual(catalogueMetadataDifferences(detail, descriptor), []);
  const changed = decodeCatalogueDescriptor({
    ...descriptor,
    preview: { ...preview, ports: { ...preview.ports, exit: "failure" } },
  });
  assert.deepEqual(catalogueMetadataDifferences(detail, changed), ["workflow structure"]);
});

test("legacy records remain readable but cannot pass inspection without published gate metadata", () => {
  const detail = decodeCatalogueDetail(entry({ closure: undefined, environment: undefined, preview: undefined }));
  const descriptor = decodeCatalogueDescriptor({
    closure: [],
    display_name: "main__review",
    environment: { requirements: [] },
    package: "publisher.workflow",
    preview: { edges: [], features: [], name: "main__review", nodes: [], ports: {} },
    schema_version: 32,
    workflow_id: "main__review",
  });
  assert.equal(detail.preview, undefined);
  assert.equal(detail.environment, undefined);
  assert.deepEqual(
    catalogueMetadataDifferences(detail, descriptor),
    ["workflow structure", "environment requirements"],
  );
});
