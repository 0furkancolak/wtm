import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExecutableFixture } from '../../../../testkit/src/executable-fixture';
import { runGit, useGitExecutableResolver } from '../git-runner';

/**
 * `runGit` hard-codes the name `git`; what actually resolves to a path is a seam a composition
 * root installs (`cli`'s and `daemon`'s own `useGitExecutableResolver` calls, both handing it
 * `@wtm/platform`'s `executablePathResolverFor`). This pins the seam itself, from core, without
 * needing a real Windows host: a resolver that always answers with a fixture executable's path,
 * regardless of what name it was asked to resolve, proves `runGit` actually calls it rather than
 * spawning the literal string `'git'`.
 */
describe('runGit resolves its executable through the installed resolver', () => {
  const roots: string[] = [];
  afterEach(async () => {
    useGitExecutableResolver();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('spawns whatever the resolver returns, not the literal name it was asked to resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-git-resolver-'));
    roots.push(root);
    const callLogPath = join(root, 'calls.json');
    await mkdir(root, { recursive: true });
    const fixture = await writeExecutableFixture(join(root, 'fake-git'), `
      const { appendFileSync } = require('node:fs');
      appendFileSync(${JSON.stringify(callLogPath)}, process.argv.slice(2).join(' ') + '\\n');
      process.stdout.write('fake output\\n');
    `);
    const resolvedNames: string[] = [];
    useGitExecutableResolver((name) => { resolvedNames.push(name); return fixture.path; });

    const result = await runGit('/repo', ['status']);

    expect(result.stdout.toString('utf8')).toBe('fake output\n');
    expect(resolvedNames).toEqual(['git']);
    expect(await readFile(callLogPath, 'utf8')).toBe('-C /repo status\n');
  });

  test('restores the identity resolution when called with nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-git-resolver-'));
    roots.push(root);
    const fixture = await writeExecutableFixture(join(root, 'fake-git'), `
      process.stdout.write(process.argv[0] + '\\n');
    `);
    useGitExecutableResolver(() => fixture.path);
    useGitExecutableResolver();

    await expect(runGit('/repo', ['status'])).rejects.toThrow();
  });
});
