# Source code and build inputs

For each released VSIX, the matching `-source.tar.gz` archive is available
beside it in the same public [GitHub Release](https://github.com/verdog-ai/verdog-vscode/releases).
Use the archive for the VSIX's exact version. It contains the authored
TypeScript, CSS, schemas and media, tests, build scripts, configuration,
package manifests and lockfile, license, exception, and notices from that tag.
The upstream sources for bundled dependencies are linked below.

## Build or modify the extension

Extract the matching source archive and use Node.js 22 (also recorded in `.nvmrc`):

```sh
npm ci
npm run package
```

`npm ci` retrieves the exact npm package archives and integrity hashes in
`package-lock.json`. `npm run package` type-checks, builds with `build.mjs`,
and produces the VSIX. Edit `src/`, `model/`, or `webview/` and repeat the
packaging command to build a modified extension. `npm test` runs its tests.
The README describes local installation.

The npm archives are the extension's direct build inputs; some contain
prebuilt JavaScript or WebAssembly. The links below provide their upstream
source, including source languages and upstream build scripts. To modify a
bundled dependency, build it from that source using its upstream instructions,
substitute the resulting package, and rebuild the extension.

## Bundled JavaScript sources

These are the packages identified by the extension bundle's build metadata
and `dist/THIRD_PARTY_NOTICES.txt`. Commit pins come from the published npm
package's `gitHead`, except `jsonc-parser`, whose `v3.3.1` tag resolves to
the listed commit. React and React DOM share a commit; Scheduler uses its own
published commit. Full source-tree archives include upstream build files.

| Bundled package and version | Pinned upstream source |
| --- | --- |
| `@hpcc-js/wasm` 2.35.0; embedded `@hpcc-js/wasm-graphviz` 1.28.0 | [1d7a3567f6c3](https://github.com/hpcc-systems/hpcc-js-wasm/tree/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa) · [archive](https://github.com/hpcc-systems/hpcc-js-wasm/archive/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa.tar.gz) |
| `ajv` 8.20.0 | [0fba0b8e6499](https://github.com/ajv-validator/ajv/tree/0fba0b8e649909613cfce0999b149cd08f4a4987) · [archive](https://github.com/ajv-validator/ajv/archive/0fba0b8e649909613cfce0999b149cd08f4a4987.tar.gz) |
| `d3-color` 3.1.0 | [7a1573ed260d](https://github.com/d3/d3-color/tree/7a1573ed260de4fd97d061975244841132adde92) · [archive](https://github.com/d3/d3-color/archive/7a1573ed260de4fd97d061975244841132adde92.tar.gz) |
| `d3-dispatch` 3.0.1 | [904ddf22634b](https://github.com/d3/d3-dispatch/tree/904ddf22634bb642460685992f4ce22898f8aeb4) · [archive](https://github.com/d3/d3-dispatch/archive/904ddf22634bb642460685992f4ce22898f8aeb4.tar.gz) |
| `d3-drag` 3.0.0 | [1b88d8a2d69f](https://github.com/d3/d3-drag/tree/1b88d8a2d69fca86d4d90a8329987693b79ec506) · [archive](https://github.com/d3/d3-drag/archive/1b88d8a2d69fca86d4d90a8329987693b79ec506.tar.gz) |
| `d3-ease` 3.0.1 | [a0919680efc6](https://github.com/d3/d3-ease/tree/a0919680efc6f8e667275ba1d6330bf6a4cc9301) · [archive](https://github.com/d3/d3-ease/archive/a0919680efc6f8e667275ba1d6330bf6a4cc9301.tar.gz) |
| `d3-format` 3.1.2 | [ebdc2d530277](https://github.com/d3/d3-format/tree/ebdc2d530277df379157f82fee6ea5623d179bd7) · [archive](https://github.com/d3/d3-format/archive/ebdc2d530277df379157f82fee6ea5623d179bd7.tar.gz) |
| `d3-graphviz` 5.6.0 | [d6a49de6f31b](https://github.com/magjac/d3-graphviz/tree/d6a49de6f31bcbf0571d82bc102b4a14b9233108) · [archive](https://github.com/magjac/d3-graphviz/archive/d6a49de6f31bcbf0571d82bc102b4a14b9233108.tar.gz) |
| `d3-interpolate` 3.0.1 | [6562b85040f7](https://github.com/d3/d3-interpolate/tree/6562b85040f7a9b96efe49b54a77eb6fceafa1c1) · [archive](https://github.com/d3/d3-interpolate/archive/6562b85040f7a9b96efe49b54a77eb6fceafa1c1.tar.gz) |
| `d3-path` 3.1.0 | [58bce7a53df2](https://github.com/d3/d3-path/tree/58bce7a53df2b03f70092a9b00b78055c4ffee04) · [archive](https://github.com/d3/d3-path/archive/58bce7a53df2b03f70092a9b00b78055c4ffee04.tar.gz) |
| `d3-selection` 3.0.0 | [91245ee124ec](https://github.com/d3/d3-selection/tree/91245ee124ec4dd491e498ecbdc9679d75332b49) · [archive](https://github.com/d3/d3-selection/archive/91245ee124ec4dd491e498ecbdc9679d75332b49.tar.gz) |
| `d3-timer` 3.0.1 | [441e45b3f582](https://github.com/d3/d3-timer/tree/441e45b3f582762cd20035d47b40e9759ed1b235) · [archive](https://github.com/d3/d3-timer/archive/441e45b3f582762cd20035d47b40e9759ed1b235.tar.gz) |
| `d3-transition` 3.0.1 | [c4c94c421e2e](https://github.com/d3/d3-transition/tree/c4c94c421e2ef9e9ffc253fab33ccf99f1434901) · [archive](https://github.com/d3/d3-transition/archive/c4c94c421e2ef9e9ffc253fab33ccf99f1434901.tar.gz) |
| `d3-zoom` 3.0.0 | [debbe3d76d86](https://github.com/d3/d3-zoom/tree/debbe3d76d86ea96965ed4cc61beb6bdf7238156) · [archive](https://github.com/d3/d3-zoom/archive/debbe3d76d86ea96965ed4cc61beb6bdf7238156.tar.gz) |
| `dompurify` 3.4.15 | [1d7460c4f8a2](https://github.com/cure53/DOMPurify/tree/1d7460c4f8a27be825c11b1c9d346d79db32c1e5) · [archive](https://github.com/cure53/DOMPurify/archive/1d7460c4f8a27be825c11b1c9d346d79db32c1e5.tar.gz) |
| `entities` 4.5.0 | [61afd4701eaa](https://github.com/fb55/entities/tree/61afd4701eaa736978b13c7351cd3de9a96b04bc) · [archive](https://github.com/fb55/entities/archive/61afd4701eaa736978b13c7351cd3de9a96b04bc.tar.gz) |
| `fast-deep-equal` 3.1.3 | [d807ffc5013e](https://github.com/epoberezkin/fast-deep-equal/tree/d807ffc5013e710deb1c63d463a03f729bcd144d) · [archive](https://github.com/epoberezkin/fast-deep-equal/archive/d807ffc5013e710deb1c63d463a03f729bcd144d.tar.gz) |
| `fast-uri` 3.1.5 | [5e179cbb4636](https://github.com/fastify/fast-uri/tree/5e179cbb4636d5f773ed21126e5bd3068e87e94e) · [archive](https://github.com/fastify/fast-uri/archive/5e179cbb4636d5f773ed21126e5bd3068e87e94e.tar.gz) |
| `json-schema-traverse` 1.0.0 | [6b45983cd762](https://github.com/epoberezkin/json-schema-traverse/tree/6b45983cd76270042cc79527da5c8972f13599ec) · [archive](https://github.com/epoberezkin/json-schema-traverse/archive/6b45983cd76270042cc79527da5c8972f13599ec.tar.gz) |
| `jsonc-parser` 3.3.1 | [3c9b4203d663](https://github.com/microsoft/node-jsonc-parser/tree/3c9b4203d663061d87d4d34dd0004690aef94db5) · [archive](https://github.com/microsoft/node-jsonc-parser/archive/3c9b4203d663061d87d4d34dd0004690aef94db5.tar.gz) |
| `linkify-it` 5.0.2 | [50a0c914f834](https://github.com/markdown-it/linkify-it/tree/50a0c914f834b201cab25ff4faefd1f832b37332) · [archive](https://github.com/markdown-it/linkify-it/archive/50a0c914f834b201cab25ff4faefd1f832b37332.tar.gz) |
| `markdown-it` 14.3.2 | [efb9993124c3](https://github.com/markdown-it/markdown-it/tree/efb9993124c3eb229eea24dd659c91dcee7f6d60) · [archive](https://github.com/markdown-it/markdown-it/archive/efb9993124c3eb229eea24dd659c91dcee7f6d60.tar.gz) |
| `mdurl` 2.1.0 | [dd913f6290a4](https://github.com/markdown-it/mdurl/tree/dd913f6290a4d8772240a401aab993eb65c5786d) · [archive](https://github.com/markdown-it/mdurl/archive/dd913f6290a4d8772240a401aab993eb65c5786d.tar.gz) |
| `punycode.js` 2.3.1 | [9e1b2cda98d2](https://github.com/mathiasbynens/punycode.js/tree/9e1b2cda98d215d3a73fcbfe93c62e021f4ba768) · [archive](https://github.com/mathiasbynens/punycode.js/archive/9e1b2cda98d215d3a73fcbfe93c62e021f4ba768.tar.gz) |
| `react`, `react-dom` 19.2.8 | [1dd4ecbdabf8](https://github.com/react/react/tree/1dd4ecbdabf826f527fc9a58c05ea70375b7d170) · [archive](https://github.com/react/react/archive/1dd4ecbdabf826f527fc9a58c05ea70375b7d170.tar.gz) |
| `scheduler` 0.27.0 | [861811347b8f](https://github.com/facebook/react/tree/861811347b8fa936b4a114fc022db9b8253b3d86) · [archive](https://github.com/facebook/react/archive/861811347b8fa936b4a114fc022db9b8253b3d86.tar.gz) |
| `uc.micro` 2.1.0 | [d91cec10974f](https://github.com/markdown-it/uc.micro/tree/d91cec10974f125be7accd4dd870900fd18fdec7) · [archive](https://github.com/markdown-it/uc.micro/archive/d91cec10974f125be7accd4dd870900fd18fdec7.tar.gz) |

## Embedded WebAssembly and native sources

The HPCC package embeds native code and fzstd that npm's dependency list
alone does not describe. These sources retain their own licenses, provided
in `dist/THIRD_PARTY_NOTICES.txt` and the upstream source trees.

| Component | Pinned source and build inputs |
| --- | --- |
| Graphviz 15.1.0, including `lib/vpsc` | [source](https://gitlab.com/graphviz/graphviz/-/tree/15.1.0) · [archive](https://gitlab.com/graphviz/graphviz/-/archive/15.1.0/graphviz-15.1.0.tar.gz) |
| HPCC WebAssembly wrapper and build | [source at `1d7a3567f6c3`](https://github.com/hpcc-systems/hpcc-js-wasm/tree/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa) · [archive](https://github.com/hpcc-systems/hpcc-js-wasm/archive/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa.tar.gz) |
| Expat 2.8.1 | [source](https://github.com/libexpat/libexpat/tree/R_2_8_1) · [archive](https://github.com/libexpat/libexpat/archive/refs/tags/R_2_8_1.tar.gz) |
| fzstd 0.1.1 | [source at `807a854cac2c`](https://github.com/101arrowz/fzstd/tree/807a854cac2c5766ef030832cc5b66482dc7ca8a) · [archive](https://github.com/101arrowz/fzstd/archive/807a854cac2c5766ef030832cc5b66482dc7ca8a.tar.gz) |
| vcpkg 2026.06.24 build ports | [source](https://github.com/microsoft/vcpkg/tree/2026.06.24) · [archive](https://github.com/microsoft/vcpkg/archive/refs/tags/2026.06.24.tar.gz) |
| Emscripten 6.0.3 toolchain and runtime sources | [source](https://github.com/emscripten-core/emscripten/tree/6.0.3) · [archive](https://github.com/emscripten-core/emscripten/archive/refs/tags/6.0.3.tar.gz) |

The exact HPCC commit contains the
[Graphviz wrapper sources](https://github.com/hpcc-systems/hpcc-js-wasm/tree/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/packages/graphviz/src-cpp),
[wrapper link configuration](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/packages/graphviz/CMakeLists.txt),
and [Graphviz build overlay](https://github.com/hpcc-systems/hpcc-js-wasm/tree/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/vcpkg-overlays/graphviz).
The overlay includes the replacement CMake files and plugin-version edits
applied to the Graphviz source. Its source hash pins the Graphviz download.
The [Expat port](https://github.com/microsoft/vcpkg/blob/2026.06.24/ports/expat/portfile.cmake)
contains its source hash, configuration, and header edits.

Use HPCC's [build instructions](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/README.md) and
[native build script](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/scripts/cpp-build.sh) when modifying the
WebAssembly. The [vcpkg installation script](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/scripts/cpp-install-vcpkg.sh)
pins vcpkg 2026.06.24, and the
[Emscripten installation script](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/scripts/cpp-install-emsdk.sh)
pins Emscripten 6.0.3. The
[WebAssembly triplet](https://github.com/hpcc-systems/hpcc-js-wasm/blob/1d7a3567f6c3b8129abc5f8bfbe06b45269487fa/vcpkg-overlays/wasm32-emscripten.cmake)
sets static library linkage. The Graphviz build enables Expat and disables zlib.

## Keeping release source available

Publish the matching source archive and VSIX in the public release before
uploading that VSIX to Marketplace. Link that release beside the Marketplace
installation instructions. Keep this source manifest and the dependency
notices aligned with each release's lockfile and bundled packages. Upstream
source servers may be used; if a required source disappears, provide a
replacement copy. The distributor remains responsible for source availability.
