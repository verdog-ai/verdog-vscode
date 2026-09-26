/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import {test} from 'node:test';

import schema from '../schemas/run-history.schema.json';

function repositoryFile(...parts: string[]): string {
  return path.resolve(process.env.VERDOG_CONTRACT_ROOT ?? '..', ...parts);
}

function pythonTopLevelBlock(
  source: string,
  header: RegExp,
  description: string,
): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex(line => header.test(line));
  assert.notEqual(start, -1, `Python ${description} must remain discoverable`);
  const block = [lines[start]];
  let headerComplete = lines[start].trimEnd().endsWith(':');
  for (const line of lines.slice(start + 1)) {
    if (!headerComplete) {
      block.push(line);
      headerComplete = line.trimEnd().endsWith(':');
      continue;
    }
    if (line !== '' && !/^\s/u.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join('\n');
}

function pythonStringEnum(source: string, name: string): string[] {
  const body = pythonTopLevelBlock(
    source,
    new RegExp(`^class ${name}\\((?:enum\\.)?StrEnum\\):\\s*$`, 'u'),
    `${name} enum`,
  );
  const values: string[] = [];
  for (const line of body.split('\n').slice(1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const member = line.match(/^\s+[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"\s*$/u);
    assert.ok(member, `unsupported ${name} member declaration: ${line.trim()}`);
    values.push(member[1]);
  }
  assert.ok(
    values.length > 0,
    `Python ${name} must declare at least one member`,
  );
  assert.equal(
    new Set(values).size,
    values.length,
    `Python ${name} values must be unique`,
  );
  return values;
}

function pythonIntegerConstant(source: string, name: string): number {
  const assignment = new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'gmu');
  const matches = [...source.matchAll(assignment)];
  assert.equal(matches.length, 1, `Python must declare exactly one ${name}`);
  return Number(matches[0][1]);
}

function assertCanonicalProducerVersion(
  source: string,
  functionName: string,
): void {
  const body = pythonTopLevelBlock(
    source,
    new RegExp(`^def ${functionName}\\(`, 'u'),
    `${functionName} producer`,
  );
  const canonicalReferences = body.match(
    /"schema_version"\s*:\s*(?:_run_model\.|runtime_runs\.)?RUN_HISTORY_SCHEMA_VERSION\b/gu,
  );
  assert.equal(
    canonicalReferences?.length,
    1,
    `${functionName} must emit the canonical run-history wire version`,
  );
  assert.doesNotMatch(
    body,
    /"schema_version"\s*:\s*\d+\b/u,
    `${functionName} must not hardcode a run-history wire version`,
  );
}

test('the shared schema stays in parity with canonical Python definitions', async () => {
  const model = await readFile(
    repositoryFile('verdog-runtime/verdog_runtime/_run_model.py'),
    'utf8',
  );
  assert.equal(
    schema.definitions.schemaVersion.const,
    pythonIntegerConstant(model, 'RUN_HISTORY_SCHEMA_VERSION'),
  );
  const enumContracts: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      'CheckpointKind',
      schema.definitions.checkpointSummary.properties.kind.enum,
    ],
    ['RunStatus', schema.definitions.runSummary.properties.status.enum],
    [
      'CheckpointPolicy',
      schema.definitions.runSummary.properties.launch.properties.checkpointing
        .enum,
    ],
  ];
  for (const [name, schemaValues] of enumContracts) {
    assert.equal(
      new Set(schemaValues).size,
      schemaValues.length,
      `schema ${name} values must be unique`,
    );
    assert.deepEqual(
      [...schemaValues].sort(),
      pythonStringEnum(model, name).sort(),
      `schema and Python ${name} values differ`,
    );
  }
});

test('Python run-history producers use the canonical wire version', async () => {
  const [runs, entry, main] = await Promise.all([
    readFile(repositoryFile('verdog-cli/verdog_cli/runs.py'), 'utf8'),
    readFile(repositoryFile('verdog-runtime/verdog_runtime/entry.py'), 'utf8'),
    readFile(repositoryFile('verdog-cli/verdog_cli/main.py'), 'utf8'),
  ]);
  assertCanonicalProducerVersion(runs, 'list_runs');
  assertCanonicalProducerVersion(runs, '_list_brief_runs');
  assertCanonicalProducerVersion(runs, 'list_checkpoints');
  assertCanonicalProducerVersion(entry, '_error_document');
  assertCanonicalProducerVersion(entry, '_operation_document');
  assertCanonicalProducerVersion(main, 'main');
});
