// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Stage-two materialisation of an immutable catalogue release.
 *
 * The checkout cache is separate from the bare Stage-one metadata cache. Completion is an
 * explicit, atomically-written state rather than the accidental presence of `project.json`.
 */

import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { verdog } from "./cli";
import { SUBMODULE_SYNC_ARGUMENTS, SUBMODULE_UPDATE_ARGUMENTS } from "./checkoutCommands";
import { formatGitHubGitFailure, runGitHubGit } from "./githubGit";
import { githubRemoteMatches } from "./githubRemote";
import {
  INSPECTION_MARKER,
  MARKER,
  type InspectionState,
  type Preview,
  checkoutRoot,
  previewWorkspace,
  workspace,
} from "./preview";

export {
  INSPECTION_MARKER,
  MARKER,
  type InspectionState,
  type Preview,
  checkoutRoot,
  interpreterIn,
  previewWorkspace,
} from "./preview";

export type MaterialisedPreview = {
  dependencies: "incomplete" | "ready";
  folder: vscode.Uri;
};

type MaterialiseOptions = {
  phase?: (label: string) => void;
  signal?: AbortSignal;
};

async function git(root: string, args: string[], signal?: AbortSignal) {
  return verdog(root, args, { command: ["git"], signal });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function write(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

async function atomicWrite(uri: vscode.Uri, content: string): Promise<void> {
  const temporary = vscode.Uri.file(`${uri.fsPath}.tmp-${process.pid}-${Date.now()}`);
  await write(temporary, content);
  await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
}

function samePreview(left: Preview, right: Preview): boolean {
  return left.repository === right.repository && left.commit === right.commit &&
    left.workflow === right.workflow;
}

export async function readInspectionState(
  root: string,
  expected?: Preview,
): Promise<InspectionState | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(root, INSPECTION_MARKER)),
    );
    const value = JSON.parse(Buffer.from(raw).toString("utf8")) as Partial<InspectionState>;
    if (
      value.version !== 1 || value.source !== "ready" || value.preview === undefined ||
      !["ready", "incomplete"].includes(value.dependencies ?? "") ||
      !["ready", "incomplete"].includes(value.environment ?? "") ||
      !["ready", "mismatch", "unchecked"].includes(value.metadata ?? "") ||
      (expected !== undefined && !samePreview(value.preview, expected))
    ) return undefined;
    return value as InspectionState;
  } catch {
    return undefined;
  }
}

export async function writeInspectionState(
  root: string,
  state: InspectionState,
): Promise<void> {
  await atomicWrite(
    vscode.Uri.file(path.join(root, INSPECTION_MARKER)),
    `${JSON.stringify(state, undefined, 2)}\n`,
  );
}

async function markPreview(folder: vscode.Uri, preview: Preview): Promise<void> {
  await atomicWrite(
    vscode.Uri.file(path.join(folder.fsPath, MARKER)),
    `${JSON.stringify(preview, undefined, 2)}\n`,
  );
}

async function headIs(root: string, commit: string, signal?: AbortSignal): Promise<boolean> {
  const found = await git(root, ["rev-parse", "HEAD"], signal);
  return found.code === 0 && found.stdout.trim().toLowerCase() === commit.toLowerCase();
}

async function ensureRepository(
  root: string,
  repository: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  const inside = await git(root, ["rev-parse", "--git-dir"], signal);
  if (inside.code !== 0) {
    const initialized = await git(root, ["init", "--quiet"], signal);
    if (initialized.code !== 0) {
      log(`could not initialise ${root}: ${initialized.combined.trim()}`);
      return false;
    }
  }
  const remote = await git(root, ["remote", "get-url", "origin"], signal);
  if (remote.code === 0) {
    if (githubRemoteMatches(remote.stdout, repository)) return true;
    log(`preview cache has an unexpected origin; remove it before retrying`);
    return false;
  }
  const added = await git(
    root,
    ["remote", "add", "origin", `https://github.com/${repository}.git`],
    signal,
  );
  if (added.code !== 0) {
    log(`could not configure the preview remote: ${added.combined.trim()}`);
    return false;
  }
  return true;
}

async function changeMode(
  root: string,
  mode: "a-w" | "u+w",
  log: (line: string) => void,
): Promise<void> {
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
  const changed = entries
    .map(([name]) => name)
    .filter((name) => ![".git", ".verdog", ".venv"].includes(name));
  if (changed.length === 0) return;
  const result = await verdog(root, ["-R", mode, "--", ...changed], { command: ["chmod"] });
  if (result.code !== 0 && result.code !== 127) {
    log(`could not make preview files ${mode === "a-w" ? "read-only" : "writable"}: ${result.combined.trim()}`);
  }
}

/** Make the inspected sources read-only after every operation that legitimately writes them. */
export function lockPreview(root: string, log: (line: string) => void): Promise<void> {
  return changeMode(root, "a-w", log);
}

/** Restore only a previously locked, extension-generated editor environment. */
export async function preparePreviewEnvironment(
  root: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const name = ".venv";
  const location = path.join(root, name);
  try {
    const status = await lstat(location);
    if (!status.isDirectory()) {
      log("managed preview environment is not a real directory; refusing to change its permissions");
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    log(`managed preview environment could not be inspected: ${String(error)}`);
    return false;
  }

  const tracked = await git(root, ["ls-files", "--", name], signal);
  if (tracked.code !== 0) {
    log(`managed preview environment ownership could not be verified: ${tracked.combined.trim()}`);
    return false;
  }
  if (tracked.stdout.trim()) {
    log("source tracks .venv; refusing to treat it as generated environment state");
    return false;
  }
  const writable = await verdog(root, ["-R", "u+w", "--", name], {
    command: ["chmod"],
    signal,
  });
  if (writable.code !== 0 && writable.code !== 127) {
    log(`managed preview environment could not be made writable: ${writable.combined.trim()}`);
    return false;
  }
  return true;
}

/**
 * Fetch and check out one exact release. A returned folder is useful for reading even when a
 * dependency submodule was inaccessible; callers keep Import locked in that degraded state.
 */
export async function materialise(
  storage: vscode.Uri,
  preview: Preview,
  log: (line: string) => void,
  options: MaterialiseOptions = {},
): Promise<MaterialisedPreview | undefined> {
  const root = checkoutRoot(storage.fsPath, preview.repository, preview.commit, preview.workflow);
  const folder = vscode.Uri.file(root);
  options.phase?.("Fetching exact source");
  await vscode.workspace.fs.createDirectory(folder);
  if (!(await ensureRepository(root, preview.repository, options.signal, log))) return undefined;

  let existing = await readInspectionState(root, preview);
  const hasProject = await exists(vscode.Uri.joinPath(folder, "project.json"));
  const atCommit = hasProject && await headIs(root, preview.commit, options.signal);
  if (!atCommit) {
    // A repaired worktree is a new inspection attempt. Never carry a previous checkout's
    // verification or environment claims across the repair, even though the cache key agrees.
    existing = undefined;
    await changeMode(root, "u+w", log);
    const fetchResult = await runGitHubGit(
      (arguments_) => git(root, arguments_, options.signal),
      ["fetch", "--quiet", "--depth", "1", "origin", preview.commit],
      options.signal,
    );
    const fetched = fetchResult.outcome;
    if (fetched.code !== 0) {
      log(
        `${preview.repository}@${preview.commit.slice(0, 12)} could not be fetched: ` +
          `${formatGitHubGitFailure(fetchResult)}\n` +
          "Verdog tried your normal Git configuration and its automatic GitHub SSH fallback.",
      );
      return undefined;
    }
    const checkedOut = await git(
      root,
      ["checkout", "--detach", "--force", "--quiet", preview.commit],
      options.signal,
    );
    if (checkedOut.code !== 0) {
      log(`${preview.commit.slice(0, 12)} could not be checked out: ${checkedOut.combined.trim()}`);
      return undefined;
    }
  }
  if (!(await exists(vscode.Uri.joinPath(folder, "project.json")))) {
    log(`${preview.repository}@${preview.commit.slice(0, 12)} has no project.json`);
    return undefined;
  }

  let dependencies: "incomplete" | "ready" = existing?.dependencies ?? "incomplete";
  const hasSubmodules = await exists(vscode.Uri.joinPath(folder, ".gitmodules"));
  if (!hasSubmodules) {
    dependencies = "ready";
  } else if (dependencies !== "ready") {
    options.phase?.("Fetching pinned dependencies");
    await changeMode(root, "u+w", log);
    const synchronized = await git(root, [...SUBMODULE_SYNC_ARGUMENTS], options.signal);
    if (synchronized.code !== 0) {
      dependencies = "incomplete";
      log(`pinned dependency URLs were not synchronized: ${synchronized.combined.trim()}`);
    } else {
      const pinnedResult = await runGitHubGit(
        (arguments_) => git(root, arguments_, options.signal),
        [...SUBMODULE_UPDATE_ARGUMENTS],
        options.signal,
      );
      const pinned = pinnedResult.outcome;
      dependencies = pinned.code === 0 ? "ready" : "incomplete";
      if (pinned.code !== 0) {
        log(`pinned dependencies were not fetched: ${formatGitHubGitFailure(pinnedResult)}`);
      }
    }
  }

  await markPreview(folder, preview);
  await writeInspectionState(root, {
    ...(existing?.catalogue === undefined ? {} : { catalogue: existing.catalogue }),
    dependencies,
    environment: existing?.environment ?? "incomplete",
    metadata: existing?.metadata ?? "unchecked",
    preview,
    source: "ready",
    version: 1,
  });
  return { dependencies, folder };
}

/** Write the settings-bearing workspace beside, never inside, the publisher's checkout. */
export async function configurePreviewWorkspace(
  storage: vscode.Uri,
  root: string,
  preview: Preview,
  interpreter: string | undefined,
): Promise<vscode.Uri> {
  const location = vscode.Uri.file(
    previewWorkspace(storage.fsPath, preview.repository, preview.commit, preview.workflow),
  );
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(location.fsPath)));
  await atomicWrite(location, workspace(preview, root, interpreter));
  return location;
}

function developmentExtensionEnvironment(extensionRoot: string): string {
  const environment: NodeJS.ProcessEnv = {};
  const pathVariable = Object.keys(process.env).find((name) => name.toLowerCase() === "path")
    ?? "PATH";
  const executableDirectory = path.resolve(
    extensionRoot,
    "..",
    "verdog-runtime",
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
  );
  const inherited = process.env[pathVariable];
  environment[pathVariable] = inherited
    ? `${executableDirectory}${path.delimiter}${inherited}`
    : executableDirectory;
  return JSON.stringify(environment);
}

/** Open a preview in another window, including the local extension under development. */
export async function openPreviewWorkspace(
  context: Pick<vscode.ExtensionContext, "extensionMode" | "extensionUri">,
  location: vscode.Uri,
  root: string,
): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    // VS Code permits only one development host for an extension path per instance. A short,
    // release-specific user-data directory gives the preview its own instance without risking
    // Unix-domain socket path limits or replacing the project from which it was opened.
    const key = path.basename(location.fsPath, ".code-workspace").slice(0, 12);
    const userData = path.join(tmpdir(), `verdog-vscode-${key}`);
    // The fresh instance has no original user settings. Give only its Extension Host the
    // runtime repository's development CLI directory; installed previews never use this path.
    const launched = await verdog(
      root,
      [
        "--new-window",
        "--user-data-dir",
        userData,
        `--extensionDevelopmentPath=${context.extensionUri.fsPath}`,
        `--extensionEnvironment=${developmentExtensionEnvironment(context.extensionUri.fsPath)}`,
        location.fsPath,
      ],
      { command: ["code"] },
    );
    if (launched.code !== 0) {
      const detail = launched.combined.trim();
      throw new Error(`code could not open the preview${detail ? `: ${detail}` : "."}`);
    }
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    location,
    { forceNewWindow: true },
  );
}

/** What this window is showing, or `undefined` for an ordinary clone. */
export async function readMarker(root: string): Promise<Preview | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, MARKER)));
    const value = JSON.parse(Buffer.from(raw).toString("utf8")) as Partial<Preview>;
    if (typeof value.commit !== "string" || typeof value.repository !== "string") return undefined;
    return {
      commit: value.commit,
      ...(typeof value.origin === "string" ? { origin: value.origin } : {}),
      repository: value.repository,
      workflow: typeof value.workflow === "string" ? value.workflow : "",
    };
  } catch {
    return undefined;
  }
}
