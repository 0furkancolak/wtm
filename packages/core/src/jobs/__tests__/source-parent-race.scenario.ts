import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSourceSnapshot } from '../source-snapshot';

const parent = fs.mkdtempSync(join(tmpdir(), 'wtm-source-parent-'));
const root = join(parent, 'repo');
const sourceDir = join(root, 'src');
const moved = join(parent, 'moved');
const source = join(sourceDir, 'index.ts');
const originalOpen = fs.promises.open;
try {
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(source, 'export const value = 1;');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, '.git', 'isolated-global'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  let swapped = false;
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (!swapped && String(args[0]) === source) {
      swapped = true;
      fs.renameSync(sourceDir, moved);
      fs.symlinkSync(moved, sourceDir);
      const handle = await originalOpen(...args);
      fs.unlinkSync(sourceDir);
      fs.renameSync(moved, sourceDir);
      return handle;
    }
    return await originalOpen(...args);
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  await assert.rejects(captureSourceSnapshot(root), /Source.*(ancestor|parent|changed)/);
  assert.equal(swapped, true);
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
  fs.rmSync(parent, { recursive: true, force: true });
}
