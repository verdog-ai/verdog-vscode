// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";

import { PropertyRequests } from "./propertyRequests";

test("property saves gate duplicate events and match acknowledgements", () => {
  const requests = new PropertyRequests();
  requests.navigate("session:a");
  const request = requests.submit({ kind: "session-persistence", persistent: true });
  assert.ok(request);
  assert.equal(requests.submit(request.edit), undefined);
  const result = { kind: "property-result", requestId: request.requestId, route: request.route, saved: false } as const;
  assert.equal(requests.settle({ ...result, requestId: result.requestId + 1 }), undefined);
  assert.equal(requests.settle({ ...result, route: "session:b" }), undefined);
  assert.equal(requests.submit(request.edit), undefined);
  assert.deepEqual(requests.settle(result), { request, current: true });
  const retry = requests.submit(request.edit);
  assert.ok(retry);
  assert.notEqual(retry.requestId, request.requestId);
  assert.equal(requests.settle(result), undefined);
  assert.deepEqual(requests.settle({ ...result, requestId: retry.requestId, saved: true }), {
    request: retry, current: true,
  });
});

test("a result from an earlier visit cannot reset another page, even after returning", () => {
  const requests = new PropertyRequests();
  requests.navigate("node:a");
  const request = requests.submit({ kind: "rename", to: "renamed" });
  assert.ok(request);
  requests.navigate("node:b");
  assert.equal(requests.submit({ kind: "name", name: "B" }), undefined);
  requests.navigate("node:a");
  assert.deepEqual(requests.settle({
    kind: "property-result", requestId: request.requestId, route: request.route, saved: false,
  }), { request, current: false });
  assert.ok(requests.submit(request.edit));
});

test("refreshes of the same route retain the current pending request", () => {
  const requests = new PropertyRequests();
  requests.navigate("node:a");
  const request = requests.submit({ kind: "name", name: "A" });
  assert.ok(request);
  requests.navigate("node:a");
  assert.equal(requests.settle({
    kind: "property-result", requestId: request.requestId, route: request.route, saved: false,
  })?.current, true);
});
