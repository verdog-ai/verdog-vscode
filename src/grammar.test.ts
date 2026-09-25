/**
 * The grammar rules the editor enforces before a file is written.
 *
 * `packageProblem` mirrors the native compiler's package grammar, and the reason it
 * exists on this side is that the alternative is worse: a package the compiler refuses can
 * only be discovered *after* the project exists, and recovering means deleting a directory.
 * So the rule is checked as the author types — which means it has to agree with the compiler,
 * which is what this file is for.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  definitionIdentifierProblem,
  identifierProblem,
  packageDirectory,
  packageFrom,
  packageProblem,
} from "../model/names";

test("entity identifiers and package components share one rule", () => {
  assert.equal(identifierProblem("pending_review"), undefined);
  assert.match(identifierProblem("Pending") ?? "", /lowercase/);
  assert.match(identifierProblem("class") ?? "", /Python keyword/);
  assert.equal(packageProblem("class.tools"), identifierProblem("class"));
});

test("canonical definition identifiers compose local identifiers", () => {
  for (const value of ["main", "main__worker", "main__worker_2"]) {
    assert.equal(definitionIdentifierProblem(value), undefined, value);
  }
  for (const value of ["main__class", "class__worker", "maïn", "main___worker"]) {
    assert.notEqual(definitionIdentifierProblem(value), undefined, value);
  }
});

test("a package name is accepted exactly where the compiler accepts one", () => {
  for (const good of [
    "space.demo",
    "my_space.my_flow",
    "a1.p2",
    "false.none",
  ]) {
    assert.equal(packageProblem(good), undefined, good);
  }
  // Each rejection names the half at fault, because "invalid" tells an author nothing.
  for (const bad of [
    "",           // nothing typed
    "demo",       // no space
    "space__demo", // no compatibility spelling
    "Demo",       // uppercase
    "2demo",      // leading digit
    "_demo",      // leading underscore
    "demo_",      // trailing underscore
    "two__scores__here", // more than one namespace separator
    "a.b.c",      // more than one space
    "a.b__c",     // both separators at once
    "a._b",       // a separator immediately followed by another
    "demo__",     // empty second half
    "class.tools", // a keyword
    "space.match", // a soft keyword, which `issoftkeyword` also refuses
    "my-flow",    // a hyphen: legal in a repository name, not in a module
    "my flow",
  ]) {
    assert.notEqual(packageProblem(bad), undefined, bad);
  }
});

test("a package is derived from whatever a person typed", () => {
  assert.equal(packageFrom("My Flow"), "my_flow");
  assert.equal(packageFrom("  Compile-Time Optimization! "), "compile_time_optimization");
  assert.equal(packageFrom("2nd attempt"), "p2nd_attempt");
  assert.equal(packageFrom("!!!"), "project");
  // It derives the name half; the author supplies the space.
  for (const typed of ["My Flow", "2nd attempt", "!!!", "a--b", "Ünïcodé"]) {
    assert.equal(identifierProblem(packageFrom(typed)), undefined, typed);
  }
});

test("a package becomes a space/name directory", () => {
  // The extension derives every entity's file path from this, so getting it wrong shows up as
  // an empty canvas rather than an error: `refs()` returns undefined for every entity and the
  // graph draws with no documents at all.
  assert.equal(packageDirectory("space.demo"), "space/demo");
});
