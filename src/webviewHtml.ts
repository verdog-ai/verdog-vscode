import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

export function webviewHtml(
  webview: vscode.Webview,
  extension: vscode.Uri,
  bundle = "webview",
): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, "dist", `${bundle}.js`));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, "dist", `${bundle}.css`));
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval';" />
    <link rel="stylesheet" href="${style}" />
    <title>Verdog</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
