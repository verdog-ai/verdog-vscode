/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview Source-only catalogue checkouts. Inspection never prepares or selects a
 * Python environment; install dependencies only after importing into a trusted project.
 */

import {createHash} from 'node:crypto';
import * as path from 'node:path';

/** What a preview window needs to know about itself, and nothing else. */
export interface Preview {
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
}

/**
 * Where the marker lives.
 *
 * Inside `.git/` on purpose: it is where the CLI already keeps per-clone state that must never
 * be committed (`local.py` writes `.git/verdog.json`), it never shows up in the Explorer, it
 * needs no `.gitignore` entry, and it stays writable when the work tree is locked.
 */
export const MARKER = path.join('.git', 'verdog-preview.json');
export const INSPECTION_MARKER = path.join('.git', 'verdog-inspection.json');
export const PREVIEW_DIRECTORY = 'preview-v2';
export const PREVIEW_WORKSPACE_DIRECTORY = 'preview-workspaces-v2';

export interface InspectionState {
  catalogue?: string;
  dependencies: 'incomplete' | 'ready';
  metadata: 'mismatch' | 'ready' | 'unchecked';
  preview: Preview;
  source: 'ready';
  version: 2;
}

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
  return path.join(
    storage,
    PREVIEW_DIRECTORY,
    previewKey(repository, commit, workflow),
  );
}

function previewKey(
  repository: string,
  commit: string,
  workflow: string,
): string {
  return createHash('sha256')
    .update(repository)
    .update('\0')
    .update(commit)
    .update('\0')
    .update(workflow)
    .digest('hex');
}

export function previewWorkspace(
  storage: string,
  repository: string,
  commit: string,
  workflow: string,
  origin?: string,
): string {
  const key = createHash('sha256')
    .update(previewKey(repository, commit, workflow))
    .update('\0')
    .update(origin ?? '')
    .digest('hex');
  return path.join(
    storage,
    PREVIEW_WORKSPACE_DIRECTORY,
    `${key}.code-workspace`,
  );
}

/**
 * Workspace settings generated outside the publisher's checkout, as JSON.
 *
 * Pure, so the read-only keys are asserted by a test rather than by opening an editor.
 *
 * They are embedded in a disposable `.code-workspace`, so a publisher's tracked
 * `.vscode/settings.json` is never overwritten.
 */
export function settings(preview: Preview): string {
  const value: Record<string, unknown> = {
    // Says "read-only" before the keystroke rather than at save time, which is where a person
    // finds out otherwise. `fromPermissions` defaults to false, so `chmod` alone marks nothing.
    'files.readonlyInclude': {'**': true},
    'files.readonlyFromPermissions': true,
    // Not cosmetic: this checkout has `origin` on the author's real repository at a detached
    // HEAD. For a repository you can write to -- previewing your own published workflow --
    // the SCM view is one click away from committing and pushing to it.
    'git.enabled': false,
    // Their manifest is `strict` with ~19 rules as errors, and it was checked against *their*
    // environment. Reporting that verdict as the reader's would read as "this author publishes
    // broken code".
    //
    // `off` rather than ignoring the files outright, because `off` still reports **unresolved
    // imports**. That is the one diagnostic a reader needs: if a declared dependency did not
    // install, empty hovers on `np.` have a reason, and silence would hide it.
    'python.analysis.typeCheckingMode': 'off',
    'window.title': `${preview.repository}@${preview.commit.slice(0, 12)} (read-only preview)`,
  };
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

/** A disposable control file, kept outside the publisher's exact Git worktree. */
export function workspace(preview: Preview, folder: string): string {
  return `${JSON.stringify(
    {
      folders: [{path: folder}],
      settings: JSON.parse(settings(preview)) as Record<string, unknown>,
    },
    undefined,
    2,
  )}\n`;
}
