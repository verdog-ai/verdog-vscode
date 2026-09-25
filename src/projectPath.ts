// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Resolve one manifest-style path without permitting it to leave through syntax or symlinks. */
export async function directProjectPath(root: string, relative: string): Promise<string> {
  const parts = relative.split("/");
  if (
    !relative ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.win32.parse(relative).root !== "" ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe project path: ${relative || "<empty>"}`);
  }

  const owner = path.resolve(root);
  const resolved = path.resolve(owner, ...parts);
  const within = path.relative(owner, resolved);
  if (!within || path.isAbsolute(within) || within === ".." || within.startsWith(`..${path.sep}`)) {
    throw new Error(`project path escapes its owner: ${relative}`);
  }

  let current = owner;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`project path contains a symbolic link: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return resolved;
}
