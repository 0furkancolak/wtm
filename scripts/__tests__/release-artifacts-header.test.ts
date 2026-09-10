import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenario = fileURLToPath(new URL('./release-artifacts-header.scenario.ts', import.meta.url));

// Named FIFOs are a native POSIX filesystem behavior. Windows has no equivalent mkfifo path.
test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'the bounded archive header reader refuses a real FIFO without waiting for a writer',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-archive-fifo-'));
    try {
      const fifo = join(root, 'input');
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
      expect(created.error).toBeUndefined();
      expect(created.status).toBe(0);
      const result = spawnSync(process.execPath, [scenario, fifo], {
        encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      });
      expect(result.stdout).toStartWith('READING\n');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const answer = JSON.parse(result.stdout.slice('READING\n'.length));
      expect(answer).toMatchObject({ accepted: false, message: expect.stringContaining('regular file') });
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
