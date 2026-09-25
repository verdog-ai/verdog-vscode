// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Reading a published workflow by checking it out, read-only, in its own window.
 *
 * This replaces a `TextDocumentContentProvider` on a scheme of our own, which served bytes
 * from a blobless clone via `git show`. That made the files read-only *by construction* --
 * VS Code will not save such a document -- and forfeited everything else, because Pylance
 * analyses only `file:` documents. A previewed file had syntax colour and no meaning: no
 * hovers, no go-to-definition, no workspace search, no Explorer tree.
 *
 * It also meant two representations of one thing. `clone.ts` derives `entity_documents` from
 * the path convention; the preview derived the same thing again from the same convention, and
 * the copies drifted -- previews had no edge or feature documents at all, for weeks, because
 * only one copy knew about them.
 *
 * So a preview is now a clone: a real checkout with a real `project.json`, read by the same
 * `readClone` as your own project. Editor read-only settings and filesystem permissions guard
 * the publisher's sources from ordinary edits while keeping Git and generated environment
 * state writable. This is an accident-prevention boundary, not a sandbox; everything a
 * language server needs remains available.
 *
 * What it must never do is *run* anything, and the environment is where that is decided. The
 * checkout gets a generated `.venv` for editor runtime types and a selected
 * `.verdog/environments/<workflow>` venv from `verdog sync --only-binary`: the runtime is
 * provisioned locally, project sources are linked with a `.pth`, and declared
 * dependencies are installed **as wheels only**.
 * That distinction is the whole of it -- installing an sdist executes its build backend,
 * installing a wheel unpacks it -- and it is enough, because a type checker never imports a
 * package. So a workflow that depends on numpy resolves numpy, with nothing executed.
 *
 * The selected workflow's environment is the only interpreter a preview uses. Borrowing the
 * reader's project environment made imports appear resolved against versions this release did
 * not declare, which defeats the point of reproducible inspection.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";

/** What a preview window needs to know about itself, and nothing else. */
export type Preview = {
  commit: string;
  /**
   * The project this preview was opened from, so Import can write there.
   *
   * Absent when the catalogue was browsed with no project open -- in which case Import says
   * so rather than guessing, because in a preview window the only clone in sight is the
   * read-only checkout, and importing into that would write a pin into borrowed code.
   */
  origin?: string;
  repository: string;
  workflow: string;
};

/**
 * Where the marker lives.
 *
 * Inside `.git/` on purpose: it is where the CLI already keeps per-clone state that must never
 * be committed (`local.py` writes `.git/verdog.json`), it never shows up in the Explorer, it
 * needs no `.gitignore` entry, and it stays writable when the work tree is locked.
 */
export const MARKER = path.join(".git", "verdog-preview.json");
export const INSPECTION_MARKER = path.join(".git", "verdog-inspection.json");

export type InspectionState = {
  catalogue?: string;
  dependencies: "incomplete" | "ready";
  environment: "incomplete" | "ready";
  metadata: "mismatch" | "ready" | "unchecked";
  preview: Preview;
  source: "ready";
  version: 1;
};

/**
 * Where a previewed commit is checked out.
 *
 * Keyed by commit and workflow, so each workflow keeps its own interpreter setting and two
 * releases can be open at once. A commit is immutable, so an existing checkout for the same
 * workflow is always reusable with no invalidation rule to get wrong.
 */
export function checkoutRoot(
  storage: string,
  repository: string,
  commit: string,
  workflow: string,
): string {
  return path.join(storage, "preview", previewKey(repository, commit, workflow));
}

function previewKey(repository: string, commit: string, workflow: string): string {
  return createHash("sha256")
    .update(repository)
    .update("\0")
    .update(commit)
    .update("\0")
    .update(workflow)
    .digest("hex");
}

export function previewWorkspace(
  storage: string,
  repository: string,
  commit: string,
  workflow: string,
): string {
  return path.join(storage, "preview-workspaces", `${previewKey(repository, commit, workflow)}.code-workspace`);
}

/**
 * Workspace settings generated outside the publisher's checkout, as JSON.
 *
 * Pure, so the read-only keys are asserted by a test rather than by opening an editor.
 *
 * They are embedded in a disposable `.code-workspace`, so a publisher's tracked
 * `.vscode/settings.json` is never overwritten.
 */
export function settings(preview: Preview, interpreter: string | undefined): string {
  const value: Record<string, unknown> = {
    // Says "read-only" before the keystroke rather than at save time, which is where a person
    // finds out otherwise. `fromPermissions` defaults to false, so `chmod` alone marks nothing.
    "files.readonlyInclude": { "**": true },
    "files.readonlyFromPermissions": true,
    // Not cosmetic: this checkout has `origin` on the author's real repository at a detached
    // HEAD. For a repository you can write to -- previewing your own published workflow --
    // the SCM view is one click away from committing and pushing to it.
    "git.enabled": false,
    // Their manifest is `strict` with ~19 rules as errors, and it was checked against *their*
    // environment. Reporting that verdict as the reader's would read as "this author publishes
    // broken code".
    //
    // `off` rather than ignoring the files outright, because `off` still reports **unresolved
    // imports**. That is the one diagnostic a reader needs: if a declared dependency did not
    // install, empty hovers on `np.` have a reason, and silence would hide it.
    "python.analysis.typeCheckingMode": "off",
    "window.title": `${preview.repository}@${preview.commit.slice(0, 12)} (read-only preview)`,
  };
  if (interpreter !== undefined) {
    // Only the selected workflow's environment. Pylance reads project source links from its
    // `.pth` file; another project's interpreter would resolve the wrong dependency versions.
    value["python.defaultInterpreterPath"] = interpreter;
  }
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

/** A disposable control file, kept outside the publisher's exact Git worktree. */
export function workspace(
  preview: Preview,
  folder: string,
  interpreter: string | undefined,
): string {
  return `${JSON.stringify({
    folders: [{ path: folder }],
    settings: JSON.parse(settings(preview, interpreter)) as Record<string, unknown>,
  }, undefined, 2)}\n`;
}

/**
 * Where the selected workflow's isolated interpreter would be, on either platform.
 */
export function interpreterIn(root: string | undefined, workflow?: string): string[] {
  if (root === undefined || workflow === undefined) return [];
  return [
    path.join(root, ".verdog", "environments", workflow, "bin", "python"),
    path.join(root, ".verdog", "environments", workflow, "Scripts", "python.exe"),
  ];
}
