# Ownership

This file is maintained and reviewed by the user. Agents MUST NOT edit, delete,
rename, replace or regenerate it. Report outdated or conflicting instructions
and propose amendments in the conversation.

# Repository Scope

- This repository owns the VS Code extension: project authoring, graph and
  catalogue webviews, source inspection, and local run-history presentation.
- `src/` contains the extension host; `model/` contains platform-neutral graph,
  editing, and protocol logic; `webview/` contains the UI.
- Keep commands, settings, activation, permissions, and packaged files aligned
  with `package.json`. Update `README.md` and `PRIVACY.md` when behavior changes.
- Follow `CODE_QUALITY.md` and prefer small changes in existing shared paths.

# Dependency Chain

- The extension launches the separately installed `verdog-cli` as a subprocess.
  The CLI depends on `verdog-runtime`; workflow execution reaches the runtime
  through that chain, rather than importing Python into the extension host.
- The extension contacts the configured backend over HTTP for identity and
  authentication; service-backed CLI operations use that same trusted origin.
- The backend owns compiler, manifest, and catalogue service contracts. Keep
  client decoders and capability checks aligned with its canonical definitions;
  do not create a second compiler or move service authorization into the UI.
- The runtime owns run-history definitions in
  `../verdog-runtime/verdog_runtime/_run_model.py`. Keep this repository's
  `schemas/run-history.schema.json` and readers aligned with those definitions
  and the CLI/runtime producers.
- Sibling CLI/runtime checkouts support development and contract integration
  tests. They are not bundled extension dependencies. Do not bundle a backend,
  CLI installation, or workflow runtime into the VSIX.

# Design Constraints

- Keep the user-facing `README.md` focused on capabilities and usage. Do not
  include implementation details; place those in developer documentation.
- Use VS Code's built-in GitHub sign-in. Do not introduce custom GitHub App
  registration, installation, or a separate authentication flow.
- Public catalogue access is the default and requests `read:user` only. Private
  access requires explicit consent naming the configured backend destination
  and GitHub's broad `repo` read/write scope before sending that token there.
- Bind private consent to the GitHub account and backend destination, and bind
  stored sessions to account, origin, and access mode. Reject unexpectedly
  broader provider scopes. Errors must never silently upgrade authorization.
- Backend origin and access mode are user-only settings. Keep session tokens
  in SecretStorage and subprocess stdin, never project files, arguments, or
  logs. Editor calls must not fall back to terminal or clone credentials.
- Compiler operations remain anonymous; catalogue credentials do not govern
  local editing or workflow execution.
- Inspect is source-only, including in a trusted preview window: no dependency
  installation, interpreter selection, type checking, analysis, or execution.
  Launch inspection metadata commands outside the publisher checkout with an
  explicit project path and the user-level CLI command.
- Reject environment-bearing preview trees. Gate environment setup, automatic
  analysis, and workflow execution on the imported project's Workspace Trust.
- Cache permission changes and deletion must not follow symlinks outside the
  managed cache. Validate managed roots and use filesystem entry types.
- Share immutable source checkouts, while each generated preview workspace
  retains its own originating project. Never overwrite another window's origin.
- Treat webview messages and CLI/backend JSON as untrusted boundary inputs.
  Preserve cancellation and stale-response guards when changing async flows.

# Development and Validation

- Read supported versions from `.nvmrc`, `package.json`, `package-lock.json`,
  and `.github/workflows/`; do not maintain another version list here.
- Before local builds or tests, check that no other build/test process is
  running. Run suites and builds sequentially across repositories and limit
  total local worker parallelism to at most 12; respect that cap in child tools.
- Use `npm ci` for locked dependencies. Run `npm run check` for formatting,
  lint, and both TypeScript projects, then `npm test` for unit tests.
- Run `npm run test:integration` when changing the shared run-history contract;
  it requires sibling `../verdog-cli` and `../verdog-runtime` checkouts.
- Use `npm run format` for formatting, `npm run build` for development bundles,
  and `npm run package` to validate and create a VSIX without publishing.
  Packaging already invokes type checking and the build through prepublish.
- Add focused regressions for changed behavior using existing test harnesses.
  Report commands run, results, and any unverified boundary without claiming
  that packaging or unit tests validate live service compatibility.

# Release Flow

- Confirm compatible backend deployment and CLI/runtime dependency availability
  before releasing client behavior that requires them.
- Follow `.github/workflows/release.yml`. Release only with explicit user
  authorization to create/push the matching `v<version>` tag and publish.
- Keep `package.json` and `package-lock.json` versions consistent with that tag.
  The workflow checks, tests, packages, archives matching source, creates a
  GitHub Release, and publishes that same VSIX to Marketplace.
- Do not rebuild a different artifact for Marketplace or bypass the workflow's
  configured publishing identity. A commit or branch push is not a release
  and does not authorize a tag, publication, or deployment.
