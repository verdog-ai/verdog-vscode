// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Starting a project without leaving the editor.
 *
 * The canvas is the pitch, so making a project must not require a terminal. What this does
 * *not* do is build the graph itself: it runs `verdog init`, which is the one place the blank
 * graph is written. A second template in TypeScript would be a second copy of the module-path
 * convention the compiler checks exactly — and nothing here could compare the two.
 *
 * So the whole of this module is: pick a folder, name it, refuse a package the compiler would
 * reject *before* anything is written, run the verb, and open what it made.
 */

import * as path from "node:path";

import * as vscode from "vscode";

import { verdog } from "./cli";
import { packageFrom, packageProblem } from "../model/names";

/** Set before the window reloads, so the canvas is showing when it comes back. */
export const REVEAL_CANVAS = "verdog.revealCanvas";

export async function newProject(
  context: vscode.ExtensionContext,
  command: string[],
): Promise<void> {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: "Create the project here",
    title: "Where should the project live?",
  });
  const folder = folders?.[0]?.fsPath;
  if (folder === undefined) return;

  // Refused here rather than by the CLI: `verdog init` refuses it too, but spawning a process
  // to learn that a folder is taken is a worse way to say so than saying it.
  const existing = await vscode.workspace.fs
    .stat(vscode.Uri.file(path.join(folder, "project.json")))
    .then(
      () => true,
      () => false,
    );
  if (existing) {
    void vscode.window.showErrorMessage(
      `${folder} already holds a project.json. Open it instead, or pick an empty folder.`,
    );
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: "What does this workflow do?",
    title: "New Verdog project",
    value: path.basename(folder),
  });
  if (name === undefined || !name.trim()) return;

  const suggested = packageFrom(name);
  const packageName = await vscode.window.showInputBox({
    prompt:
      "The Python package every module in this project is rooted at. " +
      "Use `space.name`, so two authors' projects of the same name can sit side by side. " +
      "Generation sends the new project's files to your configured Verdog service.",
    placeHolder: `space.${suggested}`,
    title: `New project "${name.trim()}"`,
    validateInput: packageProblem,
  });
  if (packageName === undefined) return;

  const result = await verdog(
    folder,
    ["init", name.trim(), "--package", packageName],
    { command },
  );
  if (result.code !== 0) {
    void vscode.window.showErrorMessage(
      `Verdog: project setup did not complete. ${result.combined.trim()} ` +
        `If project files were created, open ${folder} and retry \`verdog generate\` after resolving the error.`,
    );
    return;
  }

  // Re-open the folder rather than trying to attach to it in place. Everything in the
  // extension is built around one clone, found once at activation -- the watcher, the view,
  // the access answer -- so a reload is both simpler and exactly what a new workspace is.
  // The flag survives it and reveals the canvas on the other side, so the gesture ends on a
  // drawn graph instead of an instruction to go and find the side bar.
  await context.globalState.update(REVEAL_CANVAS, true);
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(folder),
    { forceReuseWindow: true },
  );
}
