import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundaryLabel,
  buildRunTrees,
  forkCliArguments,
  isIncompleteInvocationError,
  parseCheckpointsEnvelope,
  parseErrorEnvelope,
  parseOperationEnvelope,
  parseRunsEnvelope,
  parseWorkflowArguments,
  restartCliArguments,
  resumeCliArguments,
  type RunSummary,
} from "./runHistory";

const run = (
  id: string,
  parent: RunSummary["parent"] = null,
  workflow = "research",
): RunSummary => ({
  id,
  directory_name: `20260917-${id}`,
  workflow: { id: workflow, definition_id: `planning.${workflow}`, module: `demo.${workflow}` },
  status: "interrupted",
  started_at: "2026-09-17T10:00:00Z",
  updated_at: `2026-09-17T10:00:${id === "root" ? "00" : "01"}Z`,
  output_dir: `/project/.verdog/runs/${id}`,
  launch: { workflow_arguments: ["domain.pddl"], checkpointing: "auto" },
  parent,
  checkpoints: {
    count: 3,
    latest_completed: 3,
    latest_restorable: 3,
    resume_available: true,
    unavailable_code: null,
    unavailable_reason: null,
  },
  sessions: {
    persistent: 2,
    model: "copy-on-write",
    branch_available: true,
    issues: [],
  },
});

test("run and checkpoint envelopes are decoded only at the supported schema", () => {
  const root = run("root");
  const runs = parseRunsEnvelope(JSON.stringify({
    schema_version: 1,
    operation: "runs",
    project: "/project",
    runs: [root],
  }));
  assert.deepEqual(runs?.runs, [root]);
  assert.equal(parseRunsEnvelope("not json"), undefined);
  assert.equal(parseRunsEnvelope(JSON.stringify({ ...runs, schema_version: 2 })), undefined);
  assert.equal(parseRunsEnvelope(JSON.stringify({
    schema_version: 1,
    operation: "runs",
    project: "/project",
    runs: [root, root],
  })), undefined);

  const checkpointEnvelope = {
    schema_version: 1,
    operation: "checkpoints",
    run: root,
    checkpoints: [{
      sequence: 3,
      created_at: "2026-09-17T10:01:00Z",
      kind: "node",
      completed: {
        project_path: ".",
        graph: "main",
        node: "propose",
        visit: 2,
        call_path: "main/learn",
      },
      next: {
        project_path: ".",
        graph: "main",
        node: "validate",
        visit: 2,
        call_path: "main/learn",
      },
      restore_available: true,
      fork_with_branch_available: true,
      fork_with_fresh_available: true,
      unavailable_code: null,
      unavailable_reason: null,
    }],
  };
  const response = parseCheckpointsEnvelope(JSON.stringify(checkpointEnvelope));
  assert.equal(response?.checkpoints[0]?.sequence, 3);
  assert.equal(boundaryLabel(response?.checkpoints[0]?.next ?? null), "main/learn:main/validate #2");
  const childStart = parseCheckpointsEnvelope(JSON.stringify({
    ...checkpointEnvelope,
    checkpoints: [{ ...checkpointEnvelope.checkpoints[0], kind: "child-start" }],
  }));
  assert.equal(childStart?.checkpoints[0]?.kind, "child-start");
  assert.equal(parseCheckpointsEnvelope(JSON.stringify({
    ...checkpointEnvelope,
    checkpoints: [...checkpointEnvelope.checkpoints, ...checkpointEnvelope.checkpoints],
  })), undefined);
  assert.equal(parseCheckpointsEnvelope(JSON.stringify({
    ...checkpointEnvelope,
    checkpoints: [{ ...checkpointEnvelope.checkpoints[0], sequence: 0 }],
  })), undefined);
  assert.equal(parseCheckpointsEnvelope(JSON.stringify({
    ...checkpointEnvelope,
    checkpoints: [{
      ...checkpointEnvelope.checkpoints[0],
      next: { ...checkpointEnvelope.checkpoints[0].next, visit: 0 },
    }],
  })), undefined);
  assert.equal(parseCheckpointsEnvelope(JSON.stringify({
    ...checkpointEnvelope,
    checkpoints: [{ ...checkpointEnvelope.checkpoints[0], sequence: Number.MAX_SAFE_INTEGER + 1 }],
  })), undefined);
});

test("lineage is grouped by workflow and malformed cycles stay visible as roots", () => {
  const root = run("root");
  const fork = run("fork", {
    run_id: "root", operation: "fork", checkpoint: 2, arguments: "checkpoint",
  });
  const nested = run("nested", {
    run_id: "fork", operation: "restart", checkpoint: null, arguments: "reused",
  });
  const other = run("other", null, "evaluation");
  const cycleA = run("cycle-a", {
    run_id: "cycle-b", operation: "fork", checkpoint: 1, arguments: "checkpoint",
  });
  const cycleB = run("cycle-b", {
    run_id: "cycle-a", operation: "fork", checkpoint: 1, arguments: "checkpoint",
  });
  const trees = buildRunTrees([nested, other, cycleA, fork, cycleB, root]);

  assert.deepEqual(trees.map(({ workflow, count }) => [workflow.id, count]), [
    ["evaluation", 1], ["research", 5],
  ]);
  const research = trees[1]!;
  const rootBranch = research.roots.find((branch) => branch.run.id === "root")!;
  assert.equal(rootBranch.children[0]?.run.id, "fork");
  assert.equal(rootBranch.children[0]?.children[0]?.run.id, "nested");
  assert.deepEqual(
    research.roots.filter(({ run: item }) => item.id.startsWith("cycle")).map(({ run: item }) => item.id).sort(),
    ["cycle-a", "cycle-b"],
  );
});

test("operation and error envelopes remain separate", () => {
  const root = run("root");
  const operation = {
    schema_version: 1,
    operation: "resume",
    status: "succeeded",
    source_run_id: "root",
    source_checkpoint: 3,
    sessions: "restore",
    arguments: "checkpoint",
    run: root,
  };
  assert.deepEqual(parseOperationEnvelope(JSON.stringify(operation)), operation);
  assert.deepEqual(
    parseOperationEnvelope(JSON.stringify({ ...operation, error: null })),
    operation,
  );
  assert.equal(parseErrorEnvelope(JSON.stringify({
    status: "error",
    error: { code: "run.incomplete_invocation", message: "confirmation required" },
  }))?.error.code, "run.incomplete_invocation");
});

test("failed operations retain structured errors for explicit provider retry", () => {
  const root = run("root");
  const operation = parseOperationEnvelope(JSON.stringify({
    schema_version: 1,
    operation: "resume",
    status: "failed",
    source_run_id: "root",
    source_checkpoint: 3,
    sessions: "restore",
    arguments: "checkpoint",
    run: root,
    error: {
      code: "invocation.ambiguous",
      message: "the previous request may have reached its provider",
      details: { path: "invocations/000001.json" },
    },
  }));
  assert.equal(operation?.error?.code, "invocation.ambiguous");
  assert.equal(isIncompleteInvocationError(operation?.error), true);
  assert.equal(isIncompleteInvocationError({ code: "run.incomplete", message: "old" }), true);
  assert.equal(isIncompleteInvocationError({ code: "run.operation_failed", message: "no" }), false);
});

test("workflow argument editor accepts only a JSON array of strings", () => {
  assert.deepEqual(parseWorkflowArguments('["domain.pddl","--seed","30"]'), [
    "domain.pddl", "--seed", "30",
  ]);
  assert.deepEqual(parseWorkflowArguments("[]"), []);
  assert.equal(parseWorkflowArguments('["ok", 3]'), undefined);
  assert.equal(parseWorkflowArguments("domain.pddl"), undefined);
});

test("operation argument builders preserve argument boundaries", () => {
  assert.deepEqual(resumeCliArguments("run-1"), ["resume", "run-1", "--json"]);
  assert.deepEqual(resumeCliArguments("run-1", true), [
    "resume", "run-1", "--json", "--retry-incomplete",
  ]);
  assert.deepEqual(restartCliArguments("run-1", "branch"), [
    "restart", "run-1", "--sessions", "branch", "--json",
  ]);
  assert.deepEqual(restartCliArguments("run-1", "fresh", []), [
    "restart", "run-1", "--sessions", "fresh", "--json", "--",
  ]);
  assert.deepEqual(forkCliArguments("run-1", 17, "branch"), [
    "fork", "run-1", "--checkpoint", "17", "--sessions", "branch", "--json",
  ]);
});
