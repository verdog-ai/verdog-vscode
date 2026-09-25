// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the Runs tree contributes every durable-run action", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command?: string }>;
      menus?: Record<string, Array<{ command?: string; when?: string }>>;
      views?: Record<string, Array<{ id?: string; type?: string }>>;
    };
  };
  const commands = new Set(manifest.contributes?.commands?.map(({ command }) => command));
  assert.ok(manifest.activationEvents?.includes("onView:verdog.runs"));
  assert.deepEqual(
    manifest.contributes?.views?.verdog?.find(({ id }) => id === "verdog.runs"),
    { id: "verdog.runs", name: "Runs", contextualTitle: "Verdog Runs" },
  );
  for (const command of [
    "verdog.refreshRuns",
    "verdog.resumeRun",
    "verdog.restartRun",
    "verdog.forkRun",
    "verdog.openRunOutput",
  ]) {
    assert.ok(commands.has(command), `${command} must be contributed`);
  }
  assert.ok(
    manifest.contributes?.menus?.["view/title"]?.some(
      ({ command, when }) => command === "verdog.refreshRuns" && when === "view == verdog.runs",
    ),
  );
  const itemCommands = new Set(
    manifest.contributes?.menus?.["view/item/context"]?.map(({ command }) => command),
  );
  assert.ok(itemCommands.has("verdog.resumeRun"));
  assert.ok(itemCommands.has("verdog.restartRun"));
  assert.ok(itemCommands.has("verdog.forkRun"));
  assert.ok(itemCommands.has("verdog.openRunOutput"));
});
