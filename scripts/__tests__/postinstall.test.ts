import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('postinstall reports its attribution without changing the installation directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-postinstall-'));
  try {
    const before = await readdir(directory);
    const result = spawnSync('node', [join(import.meta.dir, '..', 'postinstall.cjs')], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('WTM installed — Powered by https://nafru.com\n');
    expect(result.stderr).toBe('');
    expect(await readdir(directory)).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
