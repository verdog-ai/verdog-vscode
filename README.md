# Verdog for VS Code

View and edit workflow graphs, check projects, and run or resume workflows from VS Code.
The canvas sits beside your code, with results in the Runs view.

[Privacy policy](PRIVACY.md) · [Source and build instructions](SOURCE.md)

## Installation

Requires VS Code **1.106 or newer** and the separately installed
`verdog` CLI. Installing
[verdog-runtime](https://github.com/verdog-ai/verdog-runtime) alone does not install the CLI.

Install a release VSIX with **Extensions: Install from VSIX…**, then open a Verdog project
folder containing `project.json` and run **Verdog: Show Canvas**. Use **Verdog: New Project**
to create a project. The extension calls the CLI for generation, analysis, checks, and execution.
Generation, analysis, Check, and Rename require access to your configured Verdog service.
**In trusted workspaces, opening or refreshing a graph automatically sends project manifests
for analysis. Structural canvas edits, New Project, and catalogue imports send declared project
files for generation; Check and Rename also send declared project files.**
See the [privacy policy](PRIVACY.md) for automatic requests, storage, and workflow providers.

## Development and packaging

Use Node.js 22 or newer (`nvm use` if available):

```sh
npm ci
npm test
npm run package
code --install-extension verdog-vscode-0.0.1.vsix
```

Packaging type-checks and builds the extension first. To launch a development window:

```sh
npm run build
code --extensionDevelopmentPath=. <a clone>
```

## Publishing

1. Create a publisher at [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage).
   Its ID must match `publisher` in `package.json` (currently `verdog`). If that ID is unavailable,
   update the manifest before packaging.
2. Commit and publish the source in this repository. Set the release version in `package.json`
   and `package-lock.json`, then push a matching `v<version>` tag.
3. The `release.yml` workflow tests and packages the extension. Download the `verdog-vscode`
   artifact from that Actions run. It contains the VSIX and the matching source archive.
4. Create a public GitHub Release for the tag and attach **both** files. Check that the source,
   [privacy policy](PRIVACY.md), dependency source links, and CLI installation instructions
   are accessible without signing in. A private Actions artifact is not a public source download.
5. Upload that same VSIX through the publisher page using **New extension → Visual Studio Code**,
   or **Update** for an existing extension.

The workflow builds an artifact; Marketplace upload is manual. See the
[VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## License

Verdog's extension code is licensed under **AGPL-3.0-only** ([LICENSE](LICENSE)), with
an [additional permission for linking with Graphviz](LICENSE-EXCEPTION). That permission
applies to Verdog's code; it does not change Graphviz's or other components' licenses.
Bundled third-party licenses and notices are included in the VSIX at
`dist/THIRD_PARTY_NOTICES.txt`. Matching source archives are provided with the
[releases](https://github.com/verdog-ai/verdog-vscode/releases); see [SOURCE.md](SOURCE.md).

## Using Verdog

*New Project* is the one command that works with no project open — it is registered before the
extension looks for a clone, because looking for one is the thing it exists to make
unnecessary. It shells `verdog init` rather than writing the graph itself: the module paths in
a blank project are templated from the package name and the compiler checks them exactly, so a
second template here would be a second thing to keep in step.

The canvas docks in the secondary side bar, so the window reads explorer | code | canvas. If
`verdog` is not on your `PATH`, set `verdog.command` to an argument array. An executable
path containing spaces is one array item. The former string-valued `verdog.path` setting is no longer read.

| command | what it does |
|---|---|
| *New Project* | asks where and what to call it, then runs `verdog init` and opens the canvas |
| *Show Canvas* | reveals the graph |
| *Add Node*, *Add Feature Declaration* | asks for a kind and a name, then writes it |
| *Delete Node, Edge or Feature* | pick from a list; a node takes its edges with it |
| *Connect Two Nodes*, *Constrain an Edge* | what the canvas gestures do, from the palette |
| *Check*, *Run Workflow* | the CLI |
| *Resume Run*, *Restart Run*, *Fork Run* | continues a committed local run, restarts its launch, or branches a selected checkpoint from the Runs view |
| *Show My Access* | what GitHub says you may do in this repository |

There is no *Save Revision* any more. Committing is git's, and VS Code already has the whole
of git — so each structural canvas edit writes `project.json` and asks the service to refresh
the generated tree; *Check* also runs local type checking, and the Source Control panel does the rest.
Files marked generated in the root `project.json` open read-only. Authored files,
`project.json`, and external checkouts remain ordinary editable files; the compiler's
manifest check is still authoritative outside VS Code.

Each takes optional arguments, so a keybinding — or a test — can skip the prompts:
`{"command": "verdog.addNode", "args": {"kind": "python", "name": "Measure"}}`.

`npm test` checks the clone reader, project model, and verdict parser directly, with no
sibling repositories required. `npm run typecheck` and `npm run build` check and build the
extension. Run `npm run test:integration` with `../verdog` and `../verdog-runtime` checked
out alongside this repository to check the run-history schema against the Python producers.
`VERDOG_COMMANDS=verdog.openCanvas,verdog.check` runs commands on activation, which is the
only way a smoke test can invoke one.

## What it deliberately does not have

An editor, a file tree, a diagnostics list, a theme, a revision browser. VS Code has all
five, and what is left is the graph — drawing it, navigating from it, and editing it.

| the browser IDE built | here it is |
|---|---|
| Monaco, tabs, dirty state | native editors, with the real Python language server |
| a file explorer | the workspace, which *is* the clone |
| a diagnostics list | the Problems panel, from `verdog check --json` |
| a design system | `--vscode-*` custom properties |
| session, CSRF, capabilities | the session `verdog login` stores, used by the CLI |
| revision history | `git log`, the Timeline view, and GitHub |
| commit, push, branch, merge | the Source Control panel |

## Authoring

The graph is `project.json`, and you edit it as text — by hand or with an agent — then run
`verdog generate`; canvas edits request that service generation automatically. Run *Verdog: Check*
for service verification and local type checking. Three things make that a real authoring surface rather than a hex editor:

**The schema.** `schemas/project.schema.json` describes the authorable half: required keys per
node kind, the identifier grammar, and the observations a condition or an effect may carry.
The core repository's `integration/tests/test_project_schema.py` checks this schema against
the compiler model when the two repositories are checked out alongside each other. Run it
from `../verdog` with `uv run pytest integration/tests/test_project_schema.py`.

**Completion that knows the project** (`model/grammar.ts`, `model/snippets.ts`,
`src/authoring.ts`). Inside `nodes`,
`features` or `edges`, Ctrl+Space offers an authorable skeleton; generated module paths are no
longer stored in the graph. On `feature_id` it offers the enclosing workflow's own features
with their kinds. On `observation` it offers only what is legal for *that* feature's kind on
*that* side of the edge: four sets no schema can express, because the answer depends on another
part of the document. Explicit effects are offered only when the edge starts at a feature node.

| | boolean | integer / float | enum |
|---|---|---|---|
| `conditions` | `positive`, `negative` | `equal_zero`, `greater_zero` | `equal` with a declared `value` |
| `effects` | `positive`, `negative`, `unchanged`, `unconstrained` | `increases`, `decreases`, `unchanged`, `unconstrained` | `equal` with a declared `value`, or `unconstrained` |

A bounded integer whose feature node proposes a lower value and whose outgoing effect verifies
**decreases** is the usual termination witness; `unconstrained` gives up that proof.

**The canvas.** Drag from a node's handle to connect two, press Delete to remove one, and use
the toolbar to add a node or a feature declaration or to constrain the selected edge. DOT always places
the nodes and routes their edges together; Tidy recomputes that layout without changing the
viewport. Authoring gestures write `project.json` — the same file an agent edits — through a
`WorkspaceEdit`, so Ctrl+Z in the JSON editor undoes a canvas action and an unsaved hand edit
is never clobbered. The extension enforces cheap authoring invariants (a free id, the right
module path, no dangling reference after a delete, effects only after feature nodes); the
compiler owns complete validation.

Deleting frees the name. There used to be a `tombstones` record keeping a retired identifier
retired, and it protected something real when Verdog owned the history and a dependency was a
revision in its store. A dependency is a repository at a commit: whoever pinned the release
that had a `measure` node still has it, and a later commit that gives the name to something
else cannot reach them. So the record earned nothing and it is gone.

**The compiler.** `verdog generate` sends declared project files to the service and writes its
returned scaffolds locally. `verdog check` uses the same service and adds local type checking.
Automatic termination analysis sends saved project manifests, including pinned dependencies,
to the service in trusted workspaces. Restricted Mode keeps the canvas readable without sending
those manifests; granting Workspace Trust starts analysis. If the service or authentication is
unavailable, analysis shows the failure and generation reports that files could not be refreshed.
Adding a node is one step: what it receives is whatever you wire into it,
so there is no contract to reconcile afterwards. Declare what it *emits*, and let the type
checker tell you which arriving cases its `run_impl` does not handle yet.

## Rights

Editing is offered only when GitHub says you may: `verdog access` asks -- one call with your
own token -- and the answer gates the handles, the toolbar and the delete key. Asked again
after every check, because a repository token acts as whoever issued it and their access can be
reduced.

If the question cannot be put, the canvas stays editable in a trusted workspace. A clone with
no GitHub remote has no repository permissions to ask about. Generation, analysis, and Check
still require an authenticated service; a failed generation leaves the saved graph available
for a later retry. GitHub permissions are enforced when pushing.

## Structure

- `src/clone.ts` — reads `project.json` into the shared snapshot and derives entity document
  paths from convention, which makes the canvas navigable with no service running.
- `src/cli.ts` — spawns `verdog`, and reads one `check --json` verdict. No parsing of prose.
- `src/graph.ts` — the graph's content hash, so "stale" is answerable with no round trip. A
  client-side mirror of the native compiler's graph hash, with direct semantic tests in
  `graph.test.ts`.
- `src/extension.ts` — activation and wiring only. `projectHost.ts` owns project state and CLI
  results; `projectActions.ts` owns authoring commands; `canvasView.ts` and `catalogueView.ts`
  own their VS Code views.
- `model/` — the platform-neutral project, feature, editing, snapshot, catalogue, and host ↔
  webview contracts, including the graph grammar. It imports neither VS Code, Node, React nor
  Graphviz. `src/authoring.ts` is the thin adapter that turns that grammar into completions.
- `webview/` — the React toolbar and inspectors around one Graphviz canvas adapter.

The build checks its own output for the two failures that are silent at build time and blank
at runtime: a second copy of React, and a stray classic-JSX `React.createElement`.
