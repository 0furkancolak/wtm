import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeAdapter } from '../index';

// A candidate adapter that exits before reading stdin at all. Paired with a large `context` (well
// past the pipe buffer a single `write` fills synchronously), this reproduces the EPIPE this
// scenario guards against: the write to the closed pipe fails while node is still flushing it, not
// only on some later chunk, so the parent's `error` listener on `child.stdin` has to be in place
// before the write starts.
const root = mkdtempSync(join(tmpdir(), 'wtm-invoke-adapter-epipe-'));
const adapterPath = join(root, 'adapter.mjs');
writeFileSync(adapterPath, 'process.exit(1);\n');

const result = await invokeAdapter(adapterPath, {
  operation: 'detect',
  context: {
    workspace: { root: '/workspace' },
    repository: { root: '/workspace/repo', mainRoot: '/workspace/repo' },
    worktree: { root: '/workspace/repo', id: 1, branch: 'x'.repeat(300_000) },
  },
  timeoutMs: 10_000,
});

process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.ok ? null : result.reason }));
