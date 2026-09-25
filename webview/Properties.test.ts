// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Properties } from "./Properties";

test("id and name writability are independent component inputs", () => {
  const element = createElement(Properties, {
    constraints: [
      {
        collection: "conditions",
        expression: "num_iterations>0",
        feature: "num_iterations",
      },
      {
        collection: "effects",
        expression: "num_iterations↓",
        feature: "num_iterations",
      },
    ],
    constraintsWritable: true,
    documents: [],
    fields: [],
    id: "source__target",
    idWritable: false,
    kind: "edge",
    name: "Transition",
    nameWritable: true,
    onConstrain: () => undefined,
    onName: () => undefined,
    onOpen: () => undefined,
    onProfile: () => undefined,
    onRemoveConstraint: () => undefined,
    onRename: () => undefined,
    onResources: () => undefined,
    onSessionPersistence: () => undefined,
    resources: [],
    resourcesWritable: false,
    settingsWritable: false,
  });
  assert.equal(element.props.idWritable, false);
  assert.equal(element.props.nameWritable, true);
  assert.equal(element.props.constraintsWritable, true);
  assert.equal(typeof element.props.onConstrain, "function");
  const enabled = renderToStaticMarkup(element);
  assert.match(enabled, /<button[^>]*>add constraint<\/button>/);
  assert.doesNotMatch(enabled, /<button[^>]*disabled[^>]*>add constraint<\/button>/);
  assert.match(
    enabled,
    /Conditions[\s\S]*num_iterations&gt;0[\s\S]*Effects[\s\S]*num_iterations↓/,
  );
  assert.equal(enabled.match(/aria-label="Remove /g)?.length, 2);
  assert.doesNotMatch(enabled, /<button[^>]*disabled=""/);
  const readOnly = renderToStaticMarkup(createElement(Properties, {
    ...element.props,
    constraintsWritable: false,
  }));
  assert.match(
    readOnly,
    /<button disabled=""[^>]*>add constraint<\/button>/,
  );
  assert.equal(readOnly.match(/<button[^>]*disabled=""/g)?.length, 3);
  const pending = renderToStaticMarkup(createElement(Properties, {
    ...element.props,
    pending: true,
    persistent: false,
    settingsWritable: true,
  }));
  assert.match(pending, /<fieldset[^>]*disabled=""/);
  assert.match(pending, /role="status">Saving/);
  assert.doesNotMatch(pending, /checked=""/);
  const saved = renderToStaticMarkup(createElement(Properties, {
    ...element.props,
    persistent: true,
    settingsWritable: true,
  }));
  assert.match(saved, /checked=""/);
});
