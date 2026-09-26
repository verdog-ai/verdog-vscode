# Verdog for VS Code

**Your verifier watchdog.**

Verdog is an agentic workflow programming language built on top of Python.
Design workflows visually, implement verification in Python, and run them locally.
You own the workflow source, agent configurations, and prompts.

**[Website](https://drexlerd.github.io/verdog-website/)** ·
[Get started](https://drexlerd.github.io/verdog-website/getting-started.html) ·
[Try the running example](https://drexlerd.github.io/verdog-website/running-example.html)

[![Countdown workflow in Verdog's VS Code canvas](media/running-example.png)](https://drexlerd.github.io/verdog-website/running-example.html)

*An agent proposes the next integer, Python verifies it, and a decreasing counter controls the loop.*

## Why workflows?

Agents can produce plausible results while missing the objective. Make verification
and revision explicit: check results, use failures to guide correction, and decide
when to accept, retry, or stop.

Explore the motivation, evidence, and limits in
[Why Workflows?](https://drexlerd.github.io/verdog-website/why-workflows.html).

## Why Verdog?

- **See the whole process.** Make agent calls, checks, branches, and repair loops
  visible in a graph beside your Python code.
- **Write less boilerplate.** Declare the workflow structure; Verdog generates
  scaffolding so you can focus on the task-specific behavior.
- **Catch errors early.** Find incompatible inputs and outputs through Python type
  checking, with diagnostics directly in VS Code.
- **Check that loops terminate.** Certify termination under declared conditions and
  effects, assuming individual steps terminate and respect those declarations.
  Termination does not guarantee a successful result.
- **Reuse your work.** Share workflows through the catalogue and combine components
  with isolated Python dependencies.
- **Recover instead of restarting.** Inspect local runs and resume or fork from
  restorable checkpoints.

See [Why Verdog?](https://drexlerd.github.io/verdog-website/why-verdog.html) for the
problems each capability addresses.

## Get started

Requires **VS Code 1.106+**, **Python 3.12+**, Git, and **verdog-cli 0.1.2+**.
Install the CLI with [uv](https://docs.astral.sh/uv/getting-started/installation/):

```sh
uv tool install --upgrade verdog-cli
```

1. Install **Verdog** from VS Code's Extensions view.
2. Run **Verdog: New Project** from the Command Palette.
3. Run `verdog sync` in the project's terminal, then use **Verdog: Check** and
   **Verdog: Run Workflow**.

For a complete agent workflow, follow the
[Countdown walkthrough](https://drexlerd.github.io/verdog-website/running-example.html).

## Service and privacy

Workflow execution is local. Generation and checks send project content to the
Verdog service; automatic graph analysis sends workflow declarations in trusted
projects. Catalogue access uses GitHub sign-in. Agent steps may send content to
configured providers. See the [privacy policy](PRIVACY.md) for details and controls.

## Development and license

[Developer documentation](DEVELOPMENT.md) · [Source and build information](SOURCE.md)

Licensed under [AGPL-3.0-only](LICENSE), with an
[additional permission for linking with Graphviz](LICENSE-EXCEPTION).
Third-party notices are included in the extension package.
