// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Small in-memory projects shared by model tests. */

import { SCHEMA_VERSION } from "../model/project";

const sha = (digit: string): string => digit.repeat(64);
const source = (path_: string, ownership: "generated" | "user", hash: string) => ({
  ownership,
  path: path_,
  sha256: hash,
  size: 0,
});
const port = (id: string, kind: "enter" | "exit" | "failure") => ({
  id,
  kind,
  name: id[0].toUpperCase() + id.slice(1),
  operation: {},
});
export const testProfile = (id: string, name: string, provider: "codex" | "claude" = "codex") => ({
  id,
  name,
  provider,
  options: { model: null, reasoning_effort: null, extra_args: [] },
});
const emptySubroutine = (id: string, name: string) => ({
  edges: [{
    conditions: [], effects: [], id: "enter__exit", name: "Pass through",
    source: "enter", target: "exit",
  }],
  features: [],
  profile_parameters: [],
  profiles: [],
  session_parameters: [],
  sessions: [],
  id,
  name,
  nodes: [port("enter", "enter"), port("exit", "exit"), port("failure", "failure")],
  ports: { enter: "enter", exit: "exit", failure: "failure" },
  subroutines: [],
  workflows: [],
});

const PROJECT = {
  schema_version: SCHEMA_VERSION,
  editor: { layouts: { main: { profile: { x: 10, y: 20 } } } },
  extensions: {},
  externals: [],
  generated_from: sha("0"),
  package: "demo.project",
  sources: [
    source("src/demo/project/subroutines/main/impl.py", "user", sha("a")),
    source(
      "src/demo/project/subroutines/main/subroutines/implement/impl.py",
      "user",
      sha("b"),
    ),
    source(
      "src/demo/project/subroutines/main/nodes/profile/__init__.py",
      "generated",
      sha("c"),
    ),
    source(
      "src/demo/project/subroutines/main/nodes/profile/visit/enter__profile/impl.py",
      "user",
      sha("d"),
    ),
    source(
      "src/demo/project/subroutines/main/features/__init__.py",
      "generated",
      sha("e"),
    ),
    source(
      "src/demo/project/subroutines/main/features/remaining_iterations/__init__.py",
      "generated",
      sha("f"),
    ),
    source(
      "src/demo/project/subroutines/main/features/remaining_iterations/impl.py",
      "user",
      sha("1"),
    ),
  ],
  subroutine: {
    edges: [
      {
        conditions: [], effects: [], id: "enter__profile", name: "Enter profile",
        source: "enter", target: "profile",
      },
      {
        conditions: [{ feature_id: "remaining_iterations", observation: "greater_zero" }],
        effects: [],
        id: "profile_analyze",
        name: "Analyze profile",
        source: "profile",
        target: "prepare_optimization",
      },
      {
        conditions: [{ feature_id: "remaining_iterations", observation: "equal_zero" }],
        effects: [],
        id: "profile_budget_exhausted",
        name: "Budget exhausted",
        source: "profile",
        target: "approve",
      },
      {
        conditions: [], effects: [], id: "prepare_optimize", name: "Prepare optimize",
        source: "prepare_optimization", target: "optimize",
      },
      {
        conditions: [], effects: [], id: "optimize__plan", name: "Optimize plan",
        source: "optimize", target: "plan",
      },
      {
        conditions: [], effects: [], id: "plan_implement", name: "Plan implementation",
        source: "plan", target: "call_implement",
      },
      {
        conditions: [], effects: [], id: "implement_consume", name: "Consume iteration",
        source: "call_implement", target: "consume_iteration",
      },
      {
        conditions: [{ feature_id: "remaining_iterations", observation: "greater_zero" }],
        effects: [{ feature_id: "remaining_iterations", observation: "decreases" }],
        id: "iteration_consumed",
        name: "Iteration consumed",
        source: "consume_iteration",
        target: "profile",
      },
      {
        conditions: [], effects: [], id: "approve__exit", name: "Approve exit",
        source: "approve", target: "exit",
      },
    ],
    features: [{
      description: "How many attempts remain.",
      id: "remaining_iterations",
      kind: "integer",
      label: "Remaining iterations",
    }],
    profile_parameters: [],
    profiles: [testProfile("default", "Default")],
    session_parameters: [],
    sessions: [
      { id: "optimize", name: "Optimize", persistent: true },
      { id: "plan", name: "Plan", persistent: true },
    ],
    id: "main",
    name: "Main",
    nodes: [
      port("enter", "enter"),
      { id: "profile", kind: "python", name: "Profile", operation: {} },
      {
        id: "prepare_optimization", kind: "python", name: "Prepare optimization", operation: {},
      },
      {
        id: "optimize", kind: "agent", name: "Optimize",
        operation: { profile: "default", session: "optimize" },
      },
      {
        id: "plan", kind: "agent", name: "Plan",
        operation: { profile: "default", session: "plan" },
      },
      {
        id: "call_implement", kind: "subroutine_call", name: "Implement",
        operation: { profile_arguments: {}, session_arguments: {}, target: "main__implement" },
      },
      { id: "consume_iteration", kind: "feature", name: "Consume iteration", operation: {} },
      { id: "approve", kind: "python", name: "Approve", operation: {} },
      port("exit", "exit"),
      port("failure", "failure"),
    ],
    ports: { enter: "enter", exit: "exit", failure: "failure" },
    subroutines: [emptySubroutine("implement", "Implement")],
    workflows: [],
  },
  workflow: {
    subroutine: "main",
    profiles: [],
    sessions: [],
    profile_arguments: {},
    session_arguments: {},
  },
};

export const testProject = (): Record<string, unknown> => structuredClone(PROJECT);
export const testProjectText = (): string => JSON.stringify(PROJECT, null, 2);
