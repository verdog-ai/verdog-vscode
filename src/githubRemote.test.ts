/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {githubRemoteMatches, githubRemoteRepository} from './githubRemote';

test('GitHub HTTPS, SCP and SSH remotes preserve one repository identity', () => {
  for (const remote of [
    'https://github.com/Alice/Workflow.git',
    'git@github.com:Alice/Workflow.git',
    'ssh://git@github.com/Alice/Workflow.git',
  ]) {
    assert.equal(githubRemoteMatches(remote, 'alice/workflow'), true);
  }
  assert.equal(
    githubRemoteRepository('https://github.com/alice/workflow.git'),
    'alice/workflow',
  );
});

test('a stale or lookalike cache remote is rejected', () => {
  for (const remote of [
    'https://github.com/alice/other.git',
    'https://github.com.evil/alice/workflow.git',
    'file:///tmp/attacker',
  ]) {
    assert.equal(githubRemoteMatches(remote, 'alice/workflow'), false);
  }
});
