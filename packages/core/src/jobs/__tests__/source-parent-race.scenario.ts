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
  await captureSourceSnapshot(root); // The same source must be readable before the race is armed.
  let swapped = false;
  let openedThroughLink = false;
  let restored = false;
  let stage = 'before-swap';
  const failures: { stage: string; code: string }[] = [];
  const recordFailure = (error: unknown) => {
    failures.push({ stage, code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  };
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (!swapped && String(args[0]) === source) {
      swapped = true;
      try {
        stage = 'rename-out'; fs.renameSync(sourceDir, moved);
        stage = 'create-directory-link'; fs.symlinkSync(moved, sourceDir, 'dir');
        let handle;
        try {
          stage = 'open-through-link';
          handle = await originalOpen(...args);
          openedThroughLink = true;
        } catch (error) { recordFailure(error); throw error; }
        finally {
          try {
            stage = 'unlink-directory-link'; fs.unlinkSync(sourceDir);
            stage = 'rename-back'; fs.renameSync(moved, sourceDir);
            restored = true;
          } catch (error) { await handle?.close(); throw error; }
        }
        return handle;
      } catch (error) { recordFailure(error); throw error; }
    }
    return await originalOpen(...args);
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  await assert.rejects(captureSourceSnapshot(root), (error: unknown) => {
    assert.match(String(error), /Source.*(ancestor|parent|changed)/, JSON.stringify({ stage, swapped, openedThroughLink, restored, failures }));
    return true;
  });
  assert.equal(swapped, true);
  assert.equal(openedThroughLink, true);
  assert.equal(restored, true);
  assert.equal(fs.lstatSync(sourceDir).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'export const value = 1;');
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
  fs.rmSync(parent, { recursive: true, force: true });
}
