import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { directProjectPath } from "./projectPath";

test("project paths reject absolute and dot components", async () => {
  for (const relative of [
    "",
    "src/\0outside.py",
    ".",
    "../outside.py",
    "src/../outside.py",
    "/outside.py",
    "src//outside.py",
    "src\\outside.py",
    "C:outside.py",
    "C:\\outside.py",
  ]) {
    await assert.rejects(directProjectPath("/unused", relative), /unsafe project path/);
  }
});

test("project paths reject an intermediate symlink without touching its target", async (context) => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "verdog-project-path-"));
  context.after(() => fs.rm(temporary, { force: true, recursive: true }));
  const root = path.join(temporary, "project");
  const outside = path.join(temporary, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const protectedFile = path.join(outside, "keep.py");
  await fs.writeFile(protectedFile, "keep\n");
  await fs.symlink(outside, path.join(root, "linked"), "dir");

  await assert.rejects(
    directProjectPath(root, "linked/keep.py"),
    /contains a symbolic link/,
  );
  assert.equal(await fs.readFile(protectedFile, "utf8"), "keep\n");
});
