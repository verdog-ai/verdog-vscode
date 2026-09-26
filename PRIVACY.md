# Privacy — Verdog for VS Code

This notice describes the Verdog extension and the CLI/runtime operations it starts. “Local” means the machine running the extension, CLI, or workflow; in a remote VS Code workspace, that may be a remote development host.

## Local files and storage

The extension reads project manifests, declared source files, Git metadata, dependency checkouts, and run records to display and edit workflows. Editing and CLI commands can write project files, generated code, dependency environments, and run outputs. **New Project** creates project files locally and sends them to the configured service for generation.

Catalogue inspection stores repository checkouts, README metadata, and temporary workspace files in the extension's VS Code storage. Inspection is source-only: it does not install packages, select a Python interpreter, type-check, analyze, or run a workflow. Environment setup and execution belong to the trusted project after import. Workflow runs store logs, checkpoints, state, prompts, provider responses, and other artifacts under `.verdog/runs` by default, or a selected output directory. These may contain project content, personal data, or secrets supplied to a workflow. CLI output and errors also appear in VS Code's Verdog output channel.

The extension stores its Verdog session token in VS Code SecretStorage, bound to the configured backend, GitHub account, and catalogue access mode. VS Code manages its GitHub sign-in session. Neither token is written into project files, logs, or command arguments by the extension. Editor calls explicitly prevent falling back to terminal or clone credentials. Separate terminal CLI sessions may still store credentials in `$XDG_CONFIG_HOME/verdog/session.json` or `~/.config/verdog/session.json`; those are not the extension's sign-in storage.

Successful checks save source paths, content hashes, and diagnostics locally in `.verdog/check.json`. The extension reads this record to show whether the saved sources still match the check.

## Connections to a Verdog service

The extension uses the user-level `verdog.backendOrigin` setting, defaulting to **`https://157.180.79.112`**. Workspace settings and project files cannot change the extension's trusted backend origin. HTTPS is required except on loopback addresses, which support local development and SSH tunnels. The service receives normal connection information, such as the connecting IP address.

**Compiler operations are anonymous.** Opening or editing a graph, generation, analysis, checking, and renaming do not require GitHub sign-in, repository access, an installed App, or a seat. The extension does not attach a session token to these compiler requests.

Catalogue operations invoke VS Code's built-in GitHub sign-in with `read:user` by default. **Verdog: Authorize Private Repository Access** explicitly requests the additional `repo` scope, which grants read and write repository access; its confirmation names the backend that will receive the token. No separate GitHub App registration or installation is required. The extension sends the authorized GitHub token to that backend's `/api/v1/auth/github` endpoint and stores the returned Verdog session token in SecretStorage. Authenticated requests carry the Verdog token in an `Authorization: Bearer` header. The backend receives the account ID, username, and any profile fields returned by GitHub, and retains the GitHub token for permission checks. Private authorization is remembered for that backend and GitHub account only. Changing either requires a new confirmation. Errors never upgrade public access automatically. **Verdog: Use Public Catalogue Access** returns to `read:user`; it does not revoke GitHub permissions shared with other extensions.

- **Explicit access lookup:** **Show My Access** asks the backend for catalogue permissions, sending the current repository's GitHub owner/name and authentication information. This does not send project file contents or restrict local editing. Opening or checking a project does not request catalogue permissions.
- **Catalogue:** displaying or refreshing the catalogue contacts the service. Searches, filters, pagination, and opening an entry send the corresponding query or entry identifiers.
- **Automatic graph analysis:** in trusted workspaces, opening or refreshing a graph and saving graph changes can send `project.json` manifests, including pinned dependency manifests, to the service for termination analysis. This does not include the source file contents listed by those manifests. Automatic analysis is disabled in Restricted Mode and catalogue previews. For ordinary projects it starts when Workspace Trust is granted.
- **Generation, Check, and Rename:** these operations send project manifests and declared source files, including those of pinned dependencies, to the service for generation, verification, or rewriting. Generation runs automatically after structural canvas edits and as part of **New Project** and catalogue imports. Returned changes can be written locally. Publishing through the CLI also performs a check before submitting catalogue metadata.

## GitHub, dependencies, and workflow providers

Catalogue previews, inspection, and imports can fetch repository content from GitHub through Git using your configured Git credentials. Synchronizing environments can contact package registries and other dependency sources selected by the project and your tooling. Those services receive the requests and authentication information needed for the operation.

Running, resuming, restarting, or forking a workflow executes its code. Agent steps can invoke configured provider tools, including Codex or Claude, which may send prompts, source content, tool results, and other context to their providers. Workflows and user-specified tools can read or write files and contact additional services according to their code, configuration, credentials, and permissions. Their data practices are separate from this extension's.

The extension has no separate usage analytics or telemetry collection. VS Code, Git, dependency tools, agent providers, and other services may have their own telemetry and privacy settings.

## Retention and your controls

Local caches and run artifacts are not automatically expired. Use **Verdog: Manage Catalogue Cache** to remove catalogue caches. You can delete unwanted run output directories; doing so removes the saved data needed to inspect or resume those runs. Project files and dependency environments remain under your control. Manage GitHub sign-in through VS Code's Accounts menu. A GitHub account, backend, or catalogue access-mode change invalidates the extension's stored Verdog session; this does not promise revocation of existing tokens on the server. `verdog logout` concerns a separate CLI session; it does not clear the extension's SecretStorage, repository-specific tokens, or workflow artifacts.

This notice does not promise a retention period or deletion behavior for a configured Verdog service, GitHub, package registries, agent providers, or workflow tools. Consult the relevant operator's policy and settings before sending data. Deleting local files does not delete copies already sent to another service.

For questions about this extension's handling of data, contact [drexlerd93@gmail.com](mailto:drexlerd93@gmail.com).
