# Verdog for VS Code

**Your verifier watchdog.**

Verdog is an agentic workflow programming language built on top of Python.
Design workflows visually, implement verification in Python, and run them locally.
You own the workflow source, agent configurations, and prompts.

**[Website](https://drexlerd.github.io/verdog-website/)** ·
[Get started](https://drexlerd.github.io/verdog-website/getting-started.html) ·
[Try the running example](https://drexlerd.github.io/verdog-website/running-example.html)

Requires **VS Code 1.106+**, **Python 3.12+**, Git, and **verdog-cli 0.1.2+**.

[![Countdown workflow in Verdog's VS Code canvas](media/running-example.png)](https://drexlerd.github.io/verdog-website/running-example.html)

*An agent proposes the next integer, Python verifies it, and a decreasing counter controls the loop.*

## Why agentic workflows?

Agents can produce plausible results while missing the objective. Make verification
and revision explicit: check results, use failures to guide correction, and decide
when to accept, retry, or stop.

Explore the motivation, evidence, and limits in
[Why agentic workflows?](https://drexlerd.github.io/verdog-website/why-workflows.html).
See [Why Verdog?](https://drexlerd.github.io/verdog-website/why-verdog.html) for the
problems Verdog addresses and how it helps.

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
