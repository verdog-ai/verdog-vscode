# Code quality

Authored TypeScript follows the [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html).
Use Node.js 22 from `.nvmrc` and the versions pinned in `package-lock.json`.

```sh
npm ci
npm run check
npm test
npm run metrics
```

`check` runs Prettier, ESLint, and both TypeScript projects. `format` applies the
formatting. ESLint uses its maintained recommended rules and typescript-eslint,
with explicit checks for interfaces, simple array types, unnecessary assertions,
unused declarations, promise handling, exhaustive switches, strict equality,
and braces. Prettier supplies two-space indentation, single quotes, semicolons,
and an 80-column print width. No local formatter or linter is maintained.
These checks run on pull requests, pushes to `main`, and before release packaging.

`metrics` reports cyclomatic complexity above 20, functions over 100 nonblank,
noncomment lines, and functions over 40 statements. These are review signals,
not correctness tests or targets to satisfy by adding wrappers. The standard
ESLint JSON formatter can retain reports: `npm run metrics -- --format json`.

For the shared runtime wire contract, check out `verdog-runtime` beside this
repository and run `npm run test:integration`. `npm run package` validates and
builds the VSIX without publishing it.

## September 2026 baseline

Measurements cover `src`, `model`, `webview`, integration tests, and build scripts.
The baseline is the repository's tracked source before this cleanup, evaluated
with the same final ESLint rules. No test, generated bundle, or production source
was excluded to reduce the counts.

| Measure | Before | After |
| --- | ---: | ---: |
| Blocking ESLint diagnostics | 971 | 0 |
| Files needing the selected Prettier format | 108 | 0 |
| Functions with cyclomatic complexity above 20 | 23 | 21 |
| Highest cyclomatic complexity | 113 | 62 |
| Functions exceeding 40 statements | 11 | 10 |
| Largest production function by statement count | 181 | 85 |
| Functions exceeding 100 physical source lines | 32 | 51 |
| Unit tests passing | 262 | 263 |
| npm audit advisories | 2 | 0 |

Physical line counts increased because the formatter wraps expressions at 80
columns and control-flow bodies now use braces. They should not be interpreted
as an increase in behavior or branching. Complexity and statement counts are
more useful for comparing this formatting migration. Remaining large functions
include React render/event code and the workspace edit transaction; their size
is still visible in `metrics`.

The largest imperative hotspot, `removeBecause`, mixed every deletion kind in
one 181-statement function with complexity 113. It now dispatches to focused
removal functions. Definition discovery, affected callers, and removal reporting
are separate operations; root reset and file-removal behavior remain covered by
the existing mutation tests. The largest extracted function has 64 statements
and complexity 29.

Authentication now separates stored-session validation from token exchange.
Response JSON is treated as unknown until checked, and a regression test rejects
malformed session/user payloads before storage. Repository origin checks,
credential revision checks, workspace trust, and redirect restrictions remain
unchanged. Property-page projection and SVG node/edge decoration also have
smaller, named operations. Across the source, redundant assertions were removed,
object shapes use interfaces, local names follow the guide, and named top-level
functions use declarations.

## Compatibility and deliberate exceptions

- Public protocol/schema keys keep their existing spelling, including
  `schema_version` and other Python-facing names. Renaming them for TypeScript
  style would change the wire protocol. Third-party declarations and imports
  follow the APIs they describe.
- Prettier is the formatting authority. Google-style naming, useful API comments,
  error handling, and module design still require review; passing automated
  checks is not a claim of complete mechanical style-guide coverage.
- `node:test` owns top-level test registrations and reports their failures.
  Its `test()` call is the only known-safe promise exception; production promises
  retain the floating/misused-promise checks.
- Three `@ts-expect-error` directives deliberately test invalid identifier types.
  They are negative type tests, not production type-check bypasses.
- GitHub authentication-provider errors are replaced with a fixed public message
  without retaining an `Error.cause`, because the original exception can contain
  credentials. This is the single documented `preserve-caught-error` exception.
- JSX, branded identifiers, and boundary conversions use the types required by
  React, VS Code, and the wire protocol. Assertions with a real contract remain;
  assertions are not added to hide lint or type errors.
