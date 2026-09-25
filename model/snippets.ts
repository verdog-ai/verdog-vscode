// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import type { Collection } from "./grammar";
import { emptySubroutine } from "./editing";

/** A completion snippet to insert; `body` uses VS Code snippet syntax. */
export type CompletionSnippet = {
  body: string;
  detail: string;
  documentation: string;
  label: string;
};

const subroutineBody = () =>
  JSON.stringify(emptySubroutine("${1:subroutine}", "${2:Subroutine}"), undefined, 2);

const SNIPPETS = {
  nodes: [
    {
      label: "python node",
      detail: "a node whose body you write",
      body: `{\n  "id": "\${1:step}",\n  "name": "\${2:Step}",\n  "kind": "python",\n  "operation": {}\n}`,
      documentation:
        "A node that runs Python you own. `verdog generate` writes one typed visit scaffold for each incoming edge.",
    },
    {
      label: "feature node",
      detail: "a node that proposes workflow feature values",
      body: `{\n  "id": "\${1:update_features}",\n  "name": "\${2:Update features}",\n  "kind": "feature",\n  "operation": {}\n}`,
      documentation:
        "A node whose incoming visits pass the payload through while proposing feature values. Its outgoing edge effects verify those proposals.",
    },
    {
      label: "agent node",
      detail: "a node an agent runs",
      body: `{\n  "id": "\${1:decide}",\n  "name": "\${2:Decide}",\n  "kind": "agent",\n  "operation": {\n    "profile": "\${3:default}",\n    "session": "\${4:conversation}"\n  }\n}`,
      documentation:
        "Selects one profile and one session declared or parameterized by this subroutine.",
    },
    {
      label: "subroutine call",
      detail: "a call to a visible subroutine",
      body: `{\n  "id": "\${1:call_child}",\n  "name": "\${2:Call child}",\n  "kind": "subroutine_call",\n  "operation": {\n    "target": "\${3:child}",\n    "profile_arguments": {},\n    "session_arguments": {}\n  }\n}`,
      documentation: "Calls a lexically visible subroutine definition in this process.",
    },
    {
      label: "workflow call",
      detail: "a call to a visible workflow",
      body: `{\n  "id": "\${1:call_child}",\n  "name": "\${2:Call child}",\n  "kind": "workflow_call",\n  "operation": { "target": "\${3:child}" }\n}`,
      documentation: "Calls a lexically visible local or external workflow definition in its own process.",
    },
  ],
  features: [
    {
      label: "integer feature",
      detail: "a non-negative count",
      body: `{\n  "id": "\${1:remaining}",\n  "label": "\${2:Remaining}",\n  "description": "\${3:What this counts, in words an agent can act on.}",\n  "kind": "integer"\n}`,
      documentation:
        "A bounded integer whose feature-node edge verifies **decreases** is the usual termination witness: without one, a loop reports a missing bound.",
    },
    {
      label: "boolean feature",
      detail: "a flag updated by feature nodes",
      body: `{\n  "id": "\${1:approved}",\n  "label": "\${2:Approved}",\n  "description": "\${3:What being true means here.}",\n  "kind": "boolean"\n}`,
      documentation:
        "A boolean can support termination when an outgoing effect verifies a flip and the loop guard requires the opposite value.",
    },
    {
      label: "float feature",
      detail: "a quantity with a fractional part",
      body: `{\n  "id": "\${1:remaining}",\n  "label": "\${2:Remaining}",\n  "description": "\${3:What this quantity measures.}",\n  "kind": "float"\n}`,
      documentation:
        "A bounded float whose feature-node edge verifies **decreases** can witness termination.",
    },
    {
      label: "enum feature",
      detail: "one value from a declared finite set",
      body: `{
  "id": "\${1:status}",
  "label": "\${2:Status}",
  "description": "\${3:What each status means.}",
  "kind": "enum",
  "values": ["\${4:pending}", "\${5:done}"]
}`,
      documentation:
        "A finite set of named alternatives. Conditions require the pre-node value; effects require the candidate value with `equal`.",
    },
  ],
  profile_parameters: [{
    label: "profile parameter",
    detail: "an agent profile supplied by the caller",
    body: `{ "id": "\${1:profile}", "name": "\${2:Profile}" }`,
    documentation: "A formal agent profile parameter for this subroutine.",
  }],
  profiles: [{
    label: "local profile",
    detail: "an agent profile owned by this subroutine",
    body: `{
  "id": "\${1:profile}",
  "name": "\${2:Profile}",
  "provider": "\${3|codex,claude|}",
  "options": {
    "model": null,
    "reasoning_effort": null,
    "extra_args": []
  }
}`,
    documentation: "A concrete agent profile with its provider invocation options.",
  }],
  session_parameters: [{
    label: "session parameter",
    detail: "an agent session supplied by the caller",
    body: `{ "id": "\${1:session}", "name": "\${2:Session}" }`,
    documentation: "A formal agent session parameter for this subroutine.",
  }],
  sessions: [{
    label: "local session",
    detail: "an agent session owned by this subroutine",
    body: `{ "id": "\${1:session}", "name": "\${2:Session}", "persistent": true }`,
    documentation: "A local agent session used by this subroutine's agent nodes.",
  }],
  edges: [
    {
      label: "edge",
      detail: "a transition, with its constraints",
      body: `{\n  "id": "\${1:source}__\${2:target}",\n  "name": "\${3:why it is taken}",\n  "source": "\${1:source}",\n  "target": "\${2:target}",\n  "conditions": [],\n  "effects": []\n}`,
      documentation:
        "`conditions` inspect feature values before the source node executes; `effects` compare that pre-node state with the feature node's candidate state. Enum equality also carries the selected `value`.",
    },
  ],
  conditions: [
    {
      label: "condition",
      detail: "one feature observation",
      body: `{ "feature_id": "\${1:feature}", "observation": "\${2:greater_zero}" }`,
      documentation:
        "What must hold for this edge to be taken. `greater_zero` / `equal_zero` for a number, `positive` / `negative` for a flag.",
    },
    {
      label: "enum condition",
      detail: "one selected enum value",
      body: `{ "feature_id": "\${1:status}", "observation": "equal", "value": "\${2:pending}" }`,
      documentation: "Requires an enum feature to have one of its declared values.",
    },
  ],
  effects: [
    {
      label: "effect",
      detail: "one feature observation",
      body: `{ "feature_id": "\${1:feature}", "observation": "\${2:decreases}" }`,
      documentation:
        "What must hold between the pre-node and candidate states. `decreases` on a bounded integer can prove a loop terminates; `unconstrained` gives up that precision.",
    },
    {
      label: "enum effect",
      detail: "one selected enum value",
      body: `{ "feature_id": "\${1:status}", "observation": "equal", "value": "\${2:done}" }`,
      documentation:
        "Requires the candidate enum value to equal one declared value. Use `unconstrained` without `value` to give up precision.",
    },
  ],
  workflows: [
    {
      label: "workflow definition",
      detail: "a local workflow visible in this scope",
      body: `{ "subroutine": "\${1:subroutine}" }`,
      documentation: "Wraps a visible subroutine in a process boundary.",
    },
    {
      label: "external workflow binding",
      detail: "a name for a pinned workflow",
      body: `{\n  "id": "\${1:child}",\n  "name": "\${2:Child}",\n  "external": { "alias": "\${3:pin}", "workflow": "\${4:main}" }\n}`,
      documentation: "Binds a definition name in this scope to a workflow from a direct pin.",
    },
  ],
  subroutines: [
    {
      label: "subroutine definition",
      detail: "a local in-process definition",
      body: subroutineBody(),
      documentation: "Defines a nested subroutine with a complete pass-through body.",
    },
  ],
} as const satisfies Record<Collection, readonly CompletionSnippet[]>;

export function snippetsFor(
  collection: Collection | undefined,
): readonly CompletionSnippet[] {
  return collection === undefined ? [] : SNIPPETS[collection];
}
