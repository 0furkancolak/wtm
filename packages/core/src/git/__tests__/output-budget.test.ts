import { expect, test } from 'bun:test';
import { runGit } from '../git-runner';

test('bounded Git callers reject output beyond their byte budget', async () => {
  await expect(runGit(process.cwd(), ['--version'], { maxOutputBytes: 1 })).rejects.toThrow('output budget');
  expect((await runGit(process.cwd(), ['--version'], { maxOutputBytes: 1024 })).stdout.toString()).toContain('git version');
});
