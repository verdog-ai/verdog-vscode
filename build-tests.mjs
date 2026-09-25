// The tests import the project model, so they need the same bundling the webview does.
// Bundled to CJS-free ESM so `node --test` can run them directly.
import { rm } from "node:fs/promises";

import { build } from "esbuild";

const integration = process.argv.includes("--integration");
const outdir = integration ? "dist-test-integration" : "dist-test";

// Entry roots determine the output layout, so clear stale bundles before test discovery.
await rm(outdir, { force: true, recursive: true });

await build({
  bundle: true,
  entryPoints: integration ? ["integration/**/*.test.ts"] : [
    "src/**/*.test.ts",
    "model/**/*.test.ts",
    "webview/**/*.test.ts",
  ],
  format: "esm",
  jsx: "automatic",
  logLevel: "error",
  mainFields: ["module", "main"],
  outbase: ".",
  outdir,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node18",
  // `vscode` exists only inside the editor. The pure half of `authoring` is what is tested,
  // so marking it external keeps the bundle honest: if a test reached the editor API, this
  // would fail to resolve at run time rather than pretending.
  external: ["node:*", "react", "react-dom", "vscode", "esbuild"],
});
