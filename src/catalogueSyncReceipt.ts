/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as path from 'node:path';

export interface CatalogueSyncReceipt {
  environment: string;
  interpreter: string;
  only_binary: true;
  requirements: string[];
  workflow_id: string;
}

interface SyncReceiptExpectation {
  checkout: string;
  platform?: NodeJS.Platform;
  workflow: string;
}

/** The only environment and executable a selected-workflow inspection may use. */
export function catalogueSyncPaths(
  checkout: string,
  workflow: string,
  platform: NodeJS.Platform = process.platform,
): {environment: string; interpreter: string} {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const environment = paths.resolve(
    checkout,
    '.verdog',
    'environments',
    workflow,
  );
  return {
    environment,
    interpreter:
      platform === 'win32'
        ? paths.join(environment, 'Scripts', 'python.exe')
        : paths.join(environment, 'bin', 'python'),
  };
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(left) || !paths.isAbsolute(right)) {
    return false;
  }
  const normalizedLeft = paths.resolve(left);
  const normalizedRight = paths.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Decode and bind `sync --only-binary --json` output to one exact inspected checkout. */
export function decodeCatalogueSyncReceipt(
  stdout: string,
  expected: SyncReceiptExpectation,
): CatalogueSyncReceipt | undefined {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const platform = expected.platform ?? process.platform;
    if (
      value.status !== 'ready' ||
      value.workflow_id !== expected.workflow ||
      value.only_binary !== true ||
      typeof value.environment !== 'string' ||
      typeof value.interpreter !== 'string' ||
      !Array.isArray(value.requirements) ||
      !value.requirements.every(item => typeof item === 'string')
    ) {
      return undefined;
    }
    const paths = catalogueSyncPaths(
      expected.checkout,
      expected.workflow,
      platform,
    );
    if (
      !samePath(value.environment, paths.environment, platform) ||
      !samePath(value.interpreter, paths.interpreter, platform)
    ) {
      return undefined;
    }
    return {
      environment: paths.environment,
      interpreter: paths.interpreter,
      only_binary: true,
      requirements: [...value.requirements] as string[],
      workflow_id: expected.workflow,
    };
  } catch {
    return undefined;
  }
}
