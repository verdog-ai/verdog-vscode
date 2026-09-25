// Two runtime targets: the extension host is Node; the canvas and catalogue are browsers.
import { build } from "esbuild";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";

const shared = { bundle: true, logLevel: "info", sourcemap: true, metafile: true };

await rm("dist", { force: true, recursive: true });

const host = await build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  mainFields: ["module", "main"],
  platform: "node",
  target: "node18",
  external: ["vscode"],
});

const extension = await readFile("dist/extension.js", "utf8");
if (/["']\.\/impl\/(?:edit|format|parser|scanner)["']/.test(extension)) {
  throw new Error("dist/extension.js: jsonc-parser left an unresolved internal import");
}

// Duplicate React or classic JSX produces a blank webview, so check the emitted bundles.
const webviews = await build({
  ...shared,
  entryPoints: {
    catalogue: "webview/catalogue.tsx",
    navigationBrowser: "webview/navigationBrowser.tsx",
    removalReview: "webview/removalReview.tsx",
    webview: "webview/main.tsx",
  },
  outdir: "dist",
  format: "iife",
  platform: "browser",
  target: "es2022",
  // esbuild only reads a file literally named `tsconfig.json`, and ours are per-target, so
  // the JSX runtime has to be stated here. Without it the classic transform emits
  // `React.createElement` against an import nobody made, and the webview is blank.
  jsx: "automatic",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
});

const duplicates = Object.keys(webviews.metafile.inputs).filter((file) =>
  /node_modules\/(react|react-dom)\//.test(file) &&
  !file.startsWith("node_modules/"),
);
if (duplicates.length > 0) {
  throw new Error(`a second copy of a shared library was bundled:\n  ${duplicates.join("\n  ")}`);
}
for (const name of [
  "dist/webview.js",
  "dist/catalogue.js",
  "dist/navigationBrowser.js",
  "dist/removalReview.js",
]) {
  const bundle = await readFile(name, "utf8");
  if (/[^.\w]React\.createElement\(/.test(bundle)) {
    throw new Error(
      `${name}: the classic JSX transform emitted React.createElement; set jsx: automatic`,
    );
  }
}

// esbuild bundles dependencies into the JS files; ship their complete license notices too.
const packageRoots = new Set(
  [...Object.keys(host.metafile.inputs), ...Object.keys(webviews.metafile.inputs)]
    .map((file) => file.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1])
    .filter(Boolean),
);
const notices = [];
for (const root of [...packageRoots].sort()) {
  const metadata = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  const licenses = (await readdir(root)).filter((name) => /^(licen[cs]e|notice)([.-]|$)/i.test(name)).sort();
  if (licenses.length === 0) throw new Error(`Missing bundled dependency license: ${root}`);
  notices.push(`${metadata.name}@${metadata.version} (${metadata.license})`);
  for (const license of licenses) notices.push(await readFile(`${root}/${license}`, "utf8"));
}
notices.push(await readFile("THIRD_PARTY_NOTICES.txt", "utf8"));
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n----------------------------------------\n\n"));
