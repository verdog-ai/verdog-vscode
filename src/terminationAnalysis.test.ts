// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Outcome } from "./cli";
import { parseTerminationReport, TerminationAnalysis } from "./terminationAnalysis";
import type { TerminationReport, TerminationState } from "../model/termination";

const report = (projects: Record<string, string> = { "": "root" }): TerminationReport => ({
  projects, definitions: { main: {
    status: "certified", local_status: "certified", reason: "acyclic", memory_states: 2, rules: 1,
    dependencies: [], edges: { enter__exit: "cleared" }, regions: [],
  } },
});
const outcome = (body: TerminationReport): Outcome => ({ code: 0, stdout: JSON.stringify(body), stderr: "", combined: "" });

test("analysis validates complete native reports once", () => {
  assert.deepEqual(parseTerminationReport(JSON.stringify(report())), report());
  for (const value of [null, {}, { projects: {}, definitions: {} }, { ...report(), definitions: { main: {} } }]) {
    assert.equal(parseTerminationReport(JSON.stringify(value)), undefined);
  }
  assert.equal(parseTerminationReport("not JSON"), undefined);
  const legacy = { ...report().definitions.main, memory_states: undefined, rules: undefined, states: 2, arcs: 1 };
  assert.equal(parseTerminationReport(JSON.stringify({ ...report(), definitions: { main: legacy } })), undefined);
  const withoutEdges = { ...report().definitions.main, edges: undefined };
  assert.equal(parseTerminationReport(JSON.stringify({ ...report(), definitions: { main: withoutEdges } })), undefined);
  const empty = { ...report(), definitions: {} };
  assert.deepEqual(parseTerminationReport(JSON.stringify(empty)), empty);
});

test("edge statuses and ordered cycle rows are decoded once at the native boundary", () => {
  const step = { node: "step", values: ["remaining > 0", "ready"], edge: "again" };
  const region = { id: "region-1", nodes: ["step"], edges: ["again"], witnesses: [], cycle: [step] };
  const definition = {
    ...report().definitions.main, status: "not_certified", local_status: "not_certified",
    edges: { start: "cleared", again: "remaining", disconnected: "unreachable" }, regions: [region],
  };
  const decode = (main: unknown) => parseTerminationReport(JSON.stringify({ ...report(), definitions: { main } }));
  assert.deepEqual(decode(definition)?.definitions.main, definition);
  const unavailable = { ...definition, status: "unavailable", local_status: "unavailable", edges: {}, regions: [] };
  assert.deepEqual(decode(unavailable)?.definitions.main, unavailable);
  for (const edges of [undefined, [], null, { again: "certified" }, { again: 1 }, { again: null }]) {
    assert.equal(decode({ ...definition, edges }), undefined);
  }
  for (const cycle of [
    undefined, null, {}, [null], [{ ...step, values: "remaining > 0" }], [{ ...step, values: [1] }],
    [{ ...step, node: 1 }], [{ ...step, edge: undefined }], [{ ...step, values: undefined }],
  ]) {
    assert.equal(decode({ ...definition, regions: [{ ...region, cycle }] }), undefined);
  }
  assert.ok(decode({ ...definition, regions: [{ ...region, cycle: [] }] }));
});

test("debounce coalesces edits and unchanged owner hashes reuse analysis", async () => {
  let calls = 0;
  const published: TerminationState[] = [];
  const current = report({ "": "new" });
  const analysis = new TerminationAnalysis(async () => { ++calls; return outcome(current); }, (state) => published.push(state), 5);
  try {
    analysis.update({ "": "old" });
    analysis.update(current.projects);
    assert.equal(analysis.state?.status, "checking");
    await delay(30);
    assert.equal(calls, 1);
    assert.equal(analysis.state?.status, "ready");
    analysis.update(current.projects);
    await delay(15);
    assert.equal(calls, 1);
    assert.equal(published.length, 1);
  } finally { analysis.dispose(); }
});

test("superseding a worker aborts it and serializes the replacement; old results cannot publish", async () => {
  const published: TerminationState[] = [];
  const starts: AbortSignal[] = [];
  const finishes: ((result: Outcome) => void)[] = [];
  let active = 0;
  let maximum = 0;
  const analysis = new TerminationAnalysis(async (signal) => {
    starts.push(signal);
    maximum = Math.max(maximum, ++active);
    const result = await new Promise<Outcome>((resolve) => finishes.push(resolve));
    --active;
    return result;
  }, (state) => published.push(state), 1);
  try {
    analysis.update({ "": "root", pin: "old" });
    await delay(10);
    analysis.update({ "": "root", pin: "new" });
    assert.equal(starts[0]?.aborted, true);
    await delay(10);
    assert.equal(starts.length, 1, "replacement waits for the killed process to close");
    finishes[0]!(outcome(report({ "": "root", pin: "old" })));
    await delay(10);
    assert.equal(starts.length, 2);
    assert.equal(published.length, 0);
    finishes[1]!(outcome(report({ "": "root", pin: "new" })));
    await delay(10);
    assert.equal(maximum, 1);
    assert.equal(published[0]?.status, "ready");
  } finally { analysis.dispose(); }
});

test("refresh suspends immediately and only unchanged saved hashes restore a completed report", async () => {
  let calls = 0;
  const published: TerminationState[] = [];
  const analysis = new TerminationAnalysis(async () => { ++calls; return outcome(report()); }, (state) => published.push(state), 1);
  try {
    analysis.update(report().projects);
    await delay(10);
    assert.equal(analysis.state?.status, "ready");
    analysis.suspend();
    assert.equal(published.at(-1)?.status, "checking", "old highlights disappear before saved files are read");
    assert.equal(analysis.update(report().projects)?.status, "ready");
    await delay(10);
    assert.equal(calls, 1, "metadata-only saves reuse their completed analysis");
    analysis.suspend();
    assert.equal(analysis.update({ "": "changed" })?.status, "checking");
  } finally { analysis.dispose(); }

  let finish!: (result: Outcome) => void;
  const result = new Promise<Outcome>((resolve) => { finish = resolve; });
  const pending = new TerminationAnalysis(() => result, (state) => published.push(state), 1);
  try {
    pending.update(report().projects);
    await delay(10);
    pending.suspend();
    finish(outcome(report()));
    await delay(10);
    assert.equal(pending.state?.status, "checking", "a finishing worker cannot publish during the next snapshot read");
  } finally { pending.dispose(); }
});

test("missing analyzed owners explain rejected pins without accepting a partial certificate", async () => {
  for (const [projects, reason] of [
    [{ "": "root" }, /Some pinned graphs could not be analyzed.*schema, package identity, and dependency chain/],
    [{ "": "root", pin: "different" }, /saved graphs changed/],
  ] as const) {
    const analysis = new TerminationAnalysis(async () => outcome(report(projects)), () => {}, 1);
    try {
      analysis.update({ "": "root", pin: "expected" });
      await delay(10);
      assert.equal(analysis.state?.status, "unavailable");
      if (analysis.state?.status === "unavailable") assert.match(analysis.state.reason, reason);
    } finally { analysis.dispose(); }
  }
});

test("mismatched hashes, invalid output, and CLI or service failures are unavailable, not certificates", async () => {
  for (const result of [
    outcome(report({ "": "different" })),
    { code: 0, stdout: "{}", stderr: "", combined: "" },
    ...["not installed", "http://127.0.0.1:8765 could not be reached", "not signed in; run `verdog login` first"]
      .map((stderr) => ({ code: 1, stdout: "", stderr, combined: "" })),
  ]) {
    const analysis = new TerminationAnalysis(async () => result, () => {}, 1);
    try {
      analysis.update({ "": "root" });
      await delay(10);
      assert.equal(analysis.state?.status, "unavailable");
      if (result.code !== 0 && analysis.state?.status === "unavailable") {
        assert.equal(analysis.state.reason, result.stderr, "show the CLI's service or authentication failure");
      }
    } finally { analysis.dispose(); }
  }
});

test("anonymous analysis failure asks for a service connection, not sign-in", async () => {
  const analysis = new TerminationAnalysis(
    async () => ({ code: 1, stdout: "", stderr: "", combined: "" }), () => {}, 1,
  );
  try {
    analysis.update(report().projects);
    await delay(10);
    assert.equal(analysis.state?.status, "unavailable");
    if (analysis.state?.status === "unavailable") {
      assert.match(analysis.state.reason, /service connection/);
      assert.doesNotMatch(analysis.state.reason, /sign-in|login/);
    }
  } finally { analysis.dispose(); }
});

test("an unavailable worker retries unchanged graphs after repair and caches only the successful report", async () => {
  let calls = 0;
  const analysis = new TerminationAnalysis(async () => ++calls === 1
    ? { code: 127, stdout: "", stderr: "not installed", combined: "" }
    : outcome(report()), () => {}, 1);
  try {
    analysis.update(report().projects);
    await delay(10);
    assert.equal(analysis.state?.status, "unavailable");
    analysis.suspend();
    assert.equal(analysis.update(report().projects)?.status, "checking");
    await delay(10);
    assert.equal(analysis.state?.status, "ready");
    assert.equal(calls, 2);
    analysis.suspend();
    assert.equal(analysis.update(report().projects)?.status, "ready");
    await delay(10);
    assert.equal(calls, 2, "successful unchanged graphs still reuse their completed report");
  } finally { analysis.dispose(); }
});

test("deadline and disposal cancel actual worker signals and reject late publications", async () => {
  let signal: AbortSignal | undefined;
  const published: TerminationState[] = [];
  const analysis = new TerminationAnalysis((current) => {
    signal = current;
    return new Promise((resolve) => current.addEventListener("abort", () => resolve({ code: 130, stdout: "", stderr: "", combined: "" })));
  }, (state) => published.push(state), 1, 10);
  analysis.update({ "": "root" });
  await delay(30);
  assert.equal(signal?.aborted, true);
  assert.equal(analysis.state?.status, "unavailable");
  analysis.update({ "": "next" });
  await delay(5);
  analysis.dispose();
  await delay(10);
  assert.equal(signal?.aborted, true);
  assert.equal(published.length, 1);
});
