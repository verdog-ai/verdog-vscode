# Extension development

[Source and build inputs](SOURCE.md) · [Code quality guide](CODE_QUALITY.md)

<details>
<summary>Build, test, and package</summary>

Use Node.js 22 or newer (`nvm use` if available):

```sh
npm ci
npm run check
npm test
npm run package
```

Install the resulting `.vsix` with **Extensions: Install from VSIX…**.
Packaging type-checks and builds the extension first. To open a development window:

```sh
npm run build
code --extensionDevelopmentPath=. /path/to/project
```

For development previews, prepare `../verdog-cli/.venv` using the
[CLI development instructions](https://github.com/verdog-ai/verdog-cli#development).
Use the paired local-package installation when developing against a local runtime checkout.

`npm test` needs no sibling repositories. With `../verdog-cli` and
`../verdog-runtime` checked out, `npm run test:integration` checks the run-history
contract against the CLI and runtime producers. CI and release packaging also run this
check against the published CLI and its resolved runtime dependency, using their
matching release tags. Each run records the exact tags and commit SHAs in the
`run-history-contract-refs` artifact. This checks source/schema parity, not live
backend compatibility.
The extension host lives in `src/`, platform-neutral graph and editing logic in `model/`,
and the canvas and catalogue webviews in `webview/`.

</details>

<details>
<summary>Publish a release</summary>

Pushing a `v<version>` tag runs [release.yml](.github/workflows/release.yml): tests,
type checking, packaging, a public GitHub Release containing the VSIX and matching source,
then Marketplace publication of **that same VSIX** under publisher `verdog`.
The tag must match the version in `package.json`; update `package-lock.json` with it.
README links in the package are pinned to the release tag.

One-time Marketplace setup:

1. Create a Microsoft Entra publishing identity, following the
   [Marketplace authentication guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace).
2. Create a GitHub environment named `marketplace` in this repository, allowing deployment
   from tags matching `v*`. Set its variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`
   to the publishing identity's application/client ID and tenant ID.
3. Configure the identity's
   [GitHub federated credential](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure):
   issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`,
   subject `repo:verdog-ai@319109192/verdog-vscode@1387501038:environment:marketplace`.
   This repository uses GitHub's [immutable subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).
   If its OIDC settings are customized, use the exact `subject claim` printed by the
   authentication step instead. No stored PAT or client secret is required.
4. On the first tag run, copy the ID printed by **Show Marketplace identity**. In
   [publisher management](https://marketplace.visualstudio.com/manage/publishers/verdog),
   open **Members**, add that ID, and grant **Contributor**. This is the publishing
   identity's Marketplace profile ID, not its Entra application ID or your personal ID.
   Until it is authorized, **Publish existing VSIX** will fail; authorize the identity
   and select **Re-run failed jobs**.

Commit and push the release changes, then push a new `v<version>` tag matching
`package.json`. If Marketplace authentication fails, configure it and select **Re-run failed jobs**: the public GitHub Release remains
available and the publishing job reuses the packaged artifact. An already published
Marketplace version is skipped on retry. Nothing is uploaded to Marketplace until
its identity has been configured and authorized.

The [publishing constraints](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publishing-extensions)
apply to the Marketplace icon, badges, and README/CHANGELOG images. The icon is a PNG;
SVGs used by VS Code's view containers are permitted. Packaging runs `vsce`'s validation.

</details>

