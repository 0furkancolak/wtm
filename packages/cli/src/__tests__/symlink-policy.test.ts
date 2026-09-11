import { expect, test } from 'bun:test';
import { lstat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

for (const policy of ['ignore', 'review', 'block', 'invalid']) {
  test(`production analyze/remove use configured untracked symlink policy: ${policy}`, async () => {
    const fixture = await createGitSafetyFixture();
    try {
      await fixture.write(fixture.root, 'wtm.toml', `[safety]\nuntracked_symlinks = "${policy}"\n`);
      const target = join(fixture.root, 'outside-target');
      const link = join(fixture.linkedWorktreePath, 'local-link');
      await fixture.write(fixture.root, 'outside-target', 'preserve');
      await symlink(target, link, 'file');
      const invoke = async (command: string) => {
        let stdout = '';
        const exitCode = await runCli([command, fixture.linkedWorktreePath, '--json'], {
          cwd: fixture.repoPath, analysisDatabasePath: join(fixture.root, 'absent.db'),
          removalGlobalConfigPath: join(fixture.root, 'global.toml'),
          stdout: (text) => { stdout += text; }, stderr: () => {},
        });
        return { exitCode, envelope: jsonEnvelopeSchema.parse(JSON.parse(stdout)) };
      };
      const analysis = await invoke('analyze');
      if (policy === 'invalid') {
        expect(analysis.exitCode).toBe(2);
        expect(analysis.envelope.errors[0]?.code).toBe('WTM_CONFIG_INVALID');
      } else {
        expect(analysis.exitCode).toBe(0);
        const data = analysis.envelope.data as { safety: { readiness: string; blockers: { code: string; context: unknown }[] }; workingTree: { counts: { untracked: number } } };
        expect(data.workingTree.counts.untracked).toBe(0);
        expect(data.safety.readiness).toBe(policy === 'block' ? 'BLOCKED' : policy === 'review' ? 'REVIEW' : 'SAFE');
        const issues = policy === 'block' ? data.safety.blockers : analysis.envelope.warnings;
        expect(issues.filter((issue) => issue.code === 'GIT_UNTRACKED_SYMLINKS')).toHaveLength(policy === 'ignore' ? 0 : 1);
        if (policy !== 'ignore') expect(issues.find((issue) => issue.code === 'GIT_UNTRACKED_SYMLINKS')?.context)
          .toMatchObject({ policy, paths: ['local-link'], count: 1 });
      }
      const removal = await invoke('remove');
      expect(removal.envelope.ok).toBe(false);
      expect(removal.exitCode).toBe(policy === 'invalid' ? 2 : policy === 'block' ? 3 : 1);
      expect(removal.envelope.errors[0]?.code).toBe(policy === 'invalid' ? 'WTM_CONFIG_INVALID'
        : policy === 'block' ? 'GIT_UNTRACKED_SYMLINKS' : 'GIT_COMMAND_FAILED');
      if (policy === 'review') expect(removal.envelope.warnings).toContainEqual(expect.objectContaining({
        code: 'GIT_UNTRACKED_SYMLINKS', severity: 'warning',
      }));
      // ignore/review does not force Git to delete an arbitrary dirty worktree.
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('preserve');
    } finally { await fixture.cleanup(); }
  });
}

test('selectors evaluate the target worktree policy instead of the caller repository policy', async () => {
  const fixture = await createGitSafetyFixture();
  try {
    await fixture.write(fixture.root, 'wtm.toml', '[safety]\nuntracked_symlinks = "ignore"\n');
    await fixture.write(fixture.linkedWorktreePath, '.wtm.toml', '[safety]\nuntracked_symlinks = "block"\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', '.wtm.toml']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Set target safety policy']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'HEAD']);
    const link = join(fixture.linkedWorktreePath, 'target-link');
    await symlink(join(fixture.root, 'absent-target'), link, 'file');
    const invoke = async (cwd: string, argv: string[]) => {
      let stdout = '';
      const exitCode = await runCli([...argv, '--json'], { cwd,
        analysisDatabasePath: join(fixture.root, 'absent.db'),
        removalGlobalConfigPath: join(fixture.root, 'global.toml'),
        stdout: (text) => { stdout += text; }, stderr: () => {},
      });
      return { exitCode, envelope: jsonEnvelopeSchema.parse(JSON.parse(stdout)) };
    };
    const own = await invoke(fixture.linkedWorktreePath, ['analyze']);
    const selected = await invoke(fixture.repoPath, ['analyze', fixture.linkedWorktreePath]);
    for (const result of [own, selected]) {
      expect(result.exitCode).toBe(0);
      expect(result.envelope.data).toMatchObject({ safety: { readiness: 'BLOCKED', blockers: [
        expect.objectContaining({ code: 'GIT_UNTRACKED_SYMLINKS' }),
      ] } });
    }
    const all = await invoke(fixture.repoPath, ['analyze', '--all']);
    expect(all.exitCode).toBe(0);
    expect(JSON.stringify(all.envelope.data)).toContain('GIT_UNTRACKED_SYMLINKS');
    const removal = await invoke(fixture.repoPath, ['remove', fixture.linkedWorktreePath]);
    expect(removal.exitCode).toBe(3);
    expect(removal.envelope.errors[0]?.code).toBe('GIT_UNTRACKED_SYMLINKS');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  } finally { await fixture.cleanup(); }
});
