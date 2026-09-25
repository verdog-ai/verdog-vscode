// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * The two things authoring completion has to get right.
 *
 *   1. Where the cursor is -- in a document that is usually mid-edit and therefore not valid
 *      JSON, which is exactly when help is wanted.
 *   2. Which observations are legal, which depends on the feature's kind *and* on whether the
 *      cursor is in `conditions` or `effects`. Four sets, checked against the project schema's
 *      vocabulary rather than against what I remembered of it.
 *
 * `vscode` is not importable outside the editor, so the context reader and snippets are plain
 * model modules that these tests can exercise directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { testProjectText } from "./fixtures";

import schema from "../schemas/project.schema.json";

import { CONDITIONS, EFFECTS, FEATURE_KINDS } from "../model/features";
import { contextAt, documentDefinitions, documentFeatures } from "../model/grammar";
import { externalSubroutineTargets, type ProjectGraphs } from "../model/snapshot";
import { snippetsFor } from "../model/snippets";

const PROJECT = testProjectText();

/** The offset just after the nth occurrence of `needle`. */
const after = (text: string, needle: string, nth = 1): number => {
  let index = -1;
  for (let count = 0; count < nth; count += 1) index = text.indexOf(needle, index + 1);
  assert.ok(index >= 0, `${needle} not found`);
  return index + needle.length;
};

test("the cursor's collection and subroutine come out of a real project", () => {
  const conditions = after(PROJECT, '"conditions": [');
  const context = contextAt(PROJECT, conditions);
  assert.equal(context.collection, "conditions");
  assert.equal(context.subroutine, "main");

  const nodes = contextAt(PROJECT, after(PROJECT, '"nodes": ['));
  assert.equal(nodes.collection, "nodes");
  assert.equal(nodes.insertion, true);

  const features_ = contextAt(PROJECT, after(PROJECT, '"features": ['));
  assert.equal(features_.collection, "features");

  // Outside any of them, there is nothing to offer.
  assert.equal(contextAt(PROJECT, 10).collection, undefined);
});

test("a half-typed document still locates, because that is when help is wanted", () => {
  const text = `{
  "package": "space.demo",
  "subroutine":
    { "id": "implement", "features": [], "nodes": [], "edges": [
      { "id": "a_b", "conditions": [ { "feature_id": "remaining", "observation": "`;
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "conditions");
  assert.equal(context.subroutine, "implement");
  assert.equal(context.property, "observation");
  assert.equal(context.feature, "remaining");
  assert.equal(context.insertion, false);

  const feature = contextAt(text, after(text, '"feature_id": "'));
  assert.equal(feature.property, "feature_id");
});

test("an entity property is not an array-item insertion point", () => {
  const text = `{
  "subroutine": { "id": "main", "nodes": [{ "id": "`;
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "nodes");
  assert.equal(context.insertion, false);
  assert.equal(context.property, undefined);
});

test("a new array slot is an insertion point, but a started object is not", () => {
  const prefix = `{ "subroutine": { "id": "main", "nodes": [`;
  assert.equal(contextAt(prefix, prefix.length).insertion, true);
  assert.equal(contextAt(`${prefix}{},`, prefix.length + 3).insertion, true);
  assert.equal(contextAt(`${prefix}{`, prefix.length + 1).insertion, false);
});

test("JSON string escapes are not mistaken for structure", () => {
  const name = JSON.stringify('Use {braces}, "quotes", and end with \\');
  const text = `{
  "subroutine":
    { "id": "main", "nodes": [
      { "id": "step", "name": ${name}, "kind": "python", "operation": {} },
      `;
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "nodes");
  assert.equal(context.subroutine, "main");
});

test("the features offered are the enclosing subroutine's own", () => {
  const found = documentFeatures(PROJECT, "main");
  assert.deepEqual(
    found.map((feature) => `${feature.id}:${feature.kind}`),
    ["remaining_iterations:integer"],
  );
  // A subroutine that declares none offers none, rather than the other subroutine's.
  assert.deepEqual(documentFeatures(PROJECT, "main__implement"), []);
});

test("subroutine targets include every subroutine in a direct pin", () => {
  const own = JSON.parse(PROJECT) as Record<string, unknown>;
  own.externals = [{ alias: "publisher.tools" }];
  const snapshot = {
    entity_documents: {
      edges: {}, features: {}, nodes: {}, profile_parameters: {}, profiles: {},
      session_parameters: {}, sessions: {},
    },
    pinned: { "publisher.tools": JSON.parse(PROJECT) },
    project: own,
  } as unknown as ProjectGraphs;
  const external = externalSubroutineTargets(snapshot, "main");

  const offered = documentDefinitions(
    PROJECT,
    "main",
    "subroutine_call",
    external,
  );
  assert.deepEqual(
    offered.filter(({ externalAlias }) => externalAlias !== undefined).map(({ id }) => id),
    ["publisher.tools/main", "publisher.tools/main__implement"],
  );
  assert.equal(
    documentDefinitions(PROJECT, "main", "workflow_call", external)
      .some(({ id }) => id.includes("/")),
    false,
  );
});

test("an incomplete document keeps feature order, labels and subroutine scope", () => {
  const text = `{
  "subroutine":
    { "id": "first", "features": [
      { "id": "wrong", "label": "Wrong", "kind": "boolean" }
    ], "subroutines": [
    { "id": "second", "features": [
      { "kind": "integer", "label": "Remaining", "id": "remaining" },
      { "kind": "`;
  assert.deepEqual(documentFeatures(text, "first__second"), [
    { id: "remaining", kind: "integer", label: "Remaining" },
  ]);
  assert.deepEqual(documentFeatures(text, "first").map((feature) => feature.id), ["wrong"]);
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "features");
  assert.equal(context.subroutine, "first__second");
});

test("an observation value may start on another line", () => {
  const text = `{
  "subroutine": { "id": "main", "edges": [{ "conditions": [{
    "feature_id": "ready",
    "observation":
      "`;
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "conditions");
  assert.equal(context.property, "observation");
  assert.equal(context.feature, "ready");
});

test("an enum value completes from the feature's declared domain", () => {
  const text = `{
  "subroutine": { "id": "main", "features": [{
    "id": "status", "label": "Status", "kind": "enum",
    "values": ["pending", "done"]
  }], "edges": [{ "conditions": [{
    "feature_id": "status", "observation": "equal", "value": "`;
  const context = contextAt(text, text.length);
  assert.equal(context.collection, "conditions");
  assert.equal(context.property, "value");
  assert.equal(context.feature, "status");
  assert.deepEqual(documentFeatures(text, "main"), [
    { id: "status", kind: "enum", label: "Status", values: ["pending", "done"] },
  ]);
  assert.deepEqual(CONDITIONS.enum, ["equal"]);
  assert.deepEqual(EFFECTS.enum, ["equal", "unconstrained"]);
});

test("the observation vocabulary agrees with the project schema", () => {
  const vocabulary = (kind: "condition" | "effect") =>
    schema.$defs[kind].properties.observation.enum.slice().sort();
  assert.deepEqual([...new Set(Object.values(CONDITIONS).flat())].sort(), vocabulary("condition"));
  assert.deepEqual([...new Set(Object.values(EFFECTS).flat())].sort(), vocabulary("effect"));
});

test("a skeleton asks only for what its author chooses", () => {
  // The module path used to be filled in here because the compiler rejected one that did
  // not start with `<space>__<project>`. A graph no longer stores it at all, so the whole
  // class of mistake is gone rather than papered over.
  const [python] = snippetsFor("nodes");
  assert.doesNotMatch(python.body, /node_impl/);
  assert.doesNotMatch(python.body, /"symbol"/);
  assert.match(python.body, /"operation": \{\}/);

  const featureNode = snippetsFor("nodes").find((item) => item.label === "feature node")!;
  assert.match(featureNode.body, /"kind": "feature"/);
  assert.match(featureNode.body, /"operation": \{\}/);
  assert.doesNotMatch(featureNode.body, /"(?:effects|implementation)"/);

  const agent = snippetsFor("nodes").find((item) => item.label === "agent node")!;
  assert.match(agent.body, /"profile":/);
  assert.match(agent.body, /"session":/);
  assert.doesNotMatch(agent.body, /"model"/);

  const [integer] = snippetsFor("features");
  assert.doesNotMatch(integer.body, /implementation/);
  assert.match(integer.body, /"kind": "integer"/);
  assert.deepEqual(
    snippetsFor("features").map((item) =>
      /"kind": "([a-z]+)"/.exec(item.body)?.[1]
    ),
    [...FEATURE_KINDS],
  );
  const enumFeature = snippetsFor("features").find((item) => item.label === "enum feature")!;
  assert.match(enumFeature.body, /"values": \[/);
  assert.match(snippetsFor("conditions").at(-1)!.body, /"value":/);
  assert.match(snippetsFor("effects").at(-1)!.body, /"value":/);

  // An edge's skeleton exists to show that constraints are where they are.
  const [edge] = snippetsFor("edges");
  assert.match(edge.body, /"conditions": \[\]/);
  assert.match(edge.body, /"effects": \[\]/);

  const [workflow] = snippetsFor("workflows");
  assert.match(workflow.body, /"subroutine":/);
  assert.doesNotMatch(workflow.body, /"dependencies":/);
  assert.doesNotMatch(workflow.body, /"(?:id|name)":/);
});
