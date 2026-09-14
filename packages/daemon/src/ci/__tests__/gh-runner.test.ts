import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExecutableFixture } from '../../../../testkit/src/executable-fixture';
import { createGhRunner } from '../gh-runner';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fake(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-gh-runner-'));
  roots.push(root);
  return (await writeExecutableFixture(join(root, 'gh'), body)).path;
}

describe('gh runner', () => {
  test('passes argv without a shell and disables prompts and colour', async () => {
    const executable = await fake(`process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), prompt: process.env.GH_PROMPT_DISABLED, color: process.env.NO_COLOR }));`);
    const result = await createGhRunner({ executable })(['run', 'list', '--repo', 'a b; echo x']);
    expect(result.outcome).toBe('success');
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['run', 'list', '--repo', 'a b; echo x'], prompt: '1', color: '1' });
  });

  test('reports a non-zero exit as failure with stderr', async () => {
    const executable = await fake(`process.stderr.write('HTTP 404'); process.exit(1);`);
    expect(await createGhRunner({ executable })(['run', 'list'])).toMatchObject({ outcome: 'failure', exitCode: 1, stderr: 'HTTP 404' });
  });

  test('reports a missing executable as not-found', async () => {
    expect((await createGhRunner({ executable: join(tmpdir(), 'wtm-no-such-gh') })(['auth', 'status'])).outcome).toBe('not-found');
  });

  test('times out a hung process', async () => {
    const executable = await fake(`setInterval(() => {}, 1000);`);
    const started = Date.now();
    expect((await createGhRunner({ executable, timeoutMs: 300 })(['run', 'list'])).outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
