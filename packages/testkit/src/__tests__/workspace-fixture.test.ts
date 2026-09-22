import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceFixture } from '../workspace-fixture';

const originalGitDir = process.env.GIT_DIR;

afterEach(() => {
  if (originalGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = originalGitDir;
});

test('an ambient GIT_DIR does not redirect the fixture\'s own repository creation', async () => {
  // `git init <path>` honors an ambient GIT_DIR over its own path argument and creates the
  // repository there instead -- confirmed with a real `git init` before writing this test. A
  // calling process (or a test runner's own environment) that happens to have GIT_DIR set would
  // silently corrupt every fixture this factory creates unless the factory's own git isolation
  // strips it, the same way `createGitWorktreeFixture` already does.
  const decoyGitDir = join(tmpdir(), `wtm-workspace-fixture-decoy-${process.pid}-${Date.now()}`);
  expect(existsSync(decoyGitDir)).toBe(false);
  process.env.GIT_DIR = decoyGitDir;

  const fixture = await createWorkspaceFixture();
  try {
    expect(existsSync(join(fixture.firstRepoPath, '.git'))).toBe(true);
    expect(existsSync(join(fixture.secondRepoPath, '.git'))).toBe(true);
    expect(existsSync(decoyGitDir)).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
