# Privacy — Verdog for VS Code

This notice describes the Verdog extension and the CLI/runtime operations it starts. “Local” means the machine running the extension, CLI, or workflow; in a remote VS Code workspace, that may be a remote development host.

## Local files and storage

The extension reads project manifests, declared source files, Git metadata, dependency checkouts, and run records to display and edit workflows. Editing and CLI commands can write project files, generated code, dependency environments, and run outputs. **New Project** creates project files locally and sends them to the configured service for generation.

Catalogue inspection stores repository checkouts, README metadata, and temporary workspace files in the extension's VS Code storage. Workflow runs store logs, checkpoints, state, prompts, provider responses, and other artifacts under `.verdog/runs` by default, or a selected output directory. These may contain project content, personal data, or secrets supplied to a workflow. CLI output and errors also appear in VS Code's Verdog output channel.

The CLI stores sign-in details, including a bearer token, in `$XDG_CONFIG_HOME/verdog/session.json` or `~/.config/verdog/session.json`. Repository-specific service settings and tokens may be stored in `.git/verdog.json`.

## Connections to a Verdog service

The CLI uses its configured service address. The project default is `http://127.0.0.1:8765`; a saved sign-in session can select a different service and takes precedence over project credentials. Requests may include an authentication token. The service receives normal connection information, such as the connecting IP address.

Signing in through the CLI gives the configured service your GitHub account ID and username, plus your name and email when returned by GitHub. The service stores that identity and a GitHub token for permission checks. The CLI saves a service session token locally.

- **Automatic access lookup:** opening a project can ask the service for repository permissions, sending its GitHub owner/repository name and authentication information. The extension also refreshes this lookup after a check. This lookup does not send project file contents.
- **Catalogue:** displaying or refreshing the catalogue contacts the service. Searches, filters, pagination, and opening an entry send the corresponding query or entry identifiers.
- **Automatic graph analysis:** in trusted workspaces, opening or refreshing a graph and saving graph changes can send `project.json` manifests, including pinned dependency manifests, to the service for termination analysis. This does not include the source file contents listed by those manifests. Automatic analysis is disabled in Restricted Mode and starts when Workspace Trust is granted.
- **Generation, Check, and Rename:** these operations send project manifests and declared source files, including those of pinned dependencies, to the service for generation, verification, or rewriting. Generation runs automatically after structural canvas edits and as part of **New Project** and catalogue imports. Returned changes can be written locally. Publishing through the CLI also performs a check before submitting catalogue metadata.

## GitHub, dependencies, and workflow providers

Catalogue previews, inspection, and imports can fetch repository content from GitHub through Git using your configured Git credentials. Synchronizing environments can contact package registries and other dependency sources selected by the project and your tooling. Those services receive the requests and authentication information needed for the operation.

Running, resuming, restarting, or forking a workflow executes its code. Agent steps can invoke configured provider tools, including Codex or Claude, which may send prompts, source content, tool results, and other context to their providers. Workflows and user-specified tools can read or write files and contact additional services according to their code, configuration, credentials, and permissions. Their data practices are separate from this extension's.

The extension has no separate usage analytics or telemetry collection. VS Code, Git, dependency tools, agent providers, and other services may have their own telemetry and privacy settings.

## Retention and your controls

Local caches and run artifacts are not automatically expired. Use **Verdog: Manage Catalogue Cache** to remove catalogue caches. You can delete unwanted run output directories; doing so removes the saved data needed to inspect or resume those runs. Project files and dependency environments remain under your control. `verdog logout` removes the CLI's local sign-in session and attempts to revoke it with the service; it does not remove repository-specific tokens or workflow artifacts.

This notice does not promise a retention period or deletion behavior for a configured Verdog service, GitHub, package registries, agent providers, or workflow tools. Consult the relevant operator's policy and settings before sending data. Deleting local files does not delete copies already sent to another service.

For questions about this extension's handling of data, contact [drexlerd93@gmail.com](mailto:drexlerd93@gmail.com).
