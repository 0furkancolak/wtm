import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';
import { isWindowsTestHost } from '../../../../testkit/src/platform';
import { invokeAdapter } from '../index';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scriptAdapter(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-sdk-testing-'));
  roots.push(root);
  const path = join(root, 'adapter.mjs');
  await writeFile(path, body, { mode: 0o700 });
  return path;
}

test('invokes a real adapter process and validates its response against the protocol schema', async () => {
  const adapter = await scriptAdapter(`
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(data);
      process.stdout.write(JSON.stringify({
        protocol: request.protocol,
        adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
      }));
      process.exit(0);
    });
  `);

  const result = await invokeAdapter(adapter, { operation: 'metadata' });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.response).toEqual({
      protocol: { major: 1, minor: 0 },
      adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
    });
  }
});

test('passes the given context through to the adapter process', async () => {
  const adapter = await scriptAdapter(`
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(data);
      process.stdout.write(JSON.stringify({
        detected: request.worktree.branch === 'feat/x',
        confidence: 1,
        evidence: [{ kind: 'file', value: request.repository.root }],
      }));
      process.exit(0);
    });
  `);

  const result = await invokeAdapter(adapter, {
    operation: 'detect',
    context: {
      workspace: { root: '/w' },
      repository: { root: '/w/repo', mainRoot: '/w/repo' },
      worktree: { root: '/w/repo', id: 3, branch: 'feat/x' },
    },
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.response).toEqual({ detected: true, confidence: 1, evidence: [{ kind: 'file', value: '/w/repo' }] });
  }
});

test('reports a nonzero exit as a failure, with stderr attached', async () => {
  const adapter = await scriptAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stderr.write('adapter refuses to run here\\n');
      process.exit(1);
    });
  `);

  const result = await invokeAdapter(adapter, { operation: 'metadata' });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('nonzero-exit');
    expect(result.stderr).toContain('adapter refuses to run here');
  }
});

test('reports a response that fails schema validation as invalid-response', async () => {
  const adapter = await scriptAdapter(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ nonsense: true }));
      process.exit(0);
    });
  `);

  const result = await invokeAdapter(adapter, { operation: 'metadata' });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('invalid-response');
});

test('reports a hung adapter as a timeout rather than waiting forever', async () => {
  const adapter = await scriptAdapter(`
    process.stdin.resume();
    setInterval(() => {}, 1_000);
  `);

  const result = await invokeAdapter(adapter, { operation: 'metadata', timeoutMs: 200 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('timeout');
});

test('does not crash the caller when a candidate adapter exits before a large request finishes writing to its stdin', () => {
  // Bun's own stdin/EPIPE handling is more forgiving than plain node's, so this only reproduces
  // (and only guards against a regression of) the crash under a real `node` process — exactly the
  // runtime this function's own doc comment promises to emulate for adapter authors testing
  // locally. Run out-of-process via `runScenario`, matching the store tests' `*.scenario.ts`
  // convention for behavior that depends on the actual node runtime rather than bun's.
  const scenarioPath = fileURLToPath(new URL('./invoke-adapter-epipe.scenario.ts', import.meta.url));
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: 'nonzero-exit' });
});

// Process-group semantics (the mechanism this test proves) are POSIX-only; win32 has no
// equivalent, the same reason `external-adapter.ts`'s own tests skip this class of assertion there.
test.skipIf(isWindowsTestHost)('a timeout kills the descendant a hung adapter spawned, not just the adapter itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-sdk-testing-'));
  roots.push(root);
  const pidFile = join(root, 'grandchild.pid');
  const adapter = await scriptAdapter(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.stdin.resume();
    const grandchild = spawn('sleep', ['9999'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    setInterval(() => {}, 1_000);
  `);

  const result = await invokeAdapter(adapter, { operation: 'metadata', timeoutMs: 200 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('timeout');

  const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
  // The signal itself is a no-op on Linux/macOS: `kill(pid, 0)` sends nothing, it only asks
  // whether the process still exists. A non-ESRCH result means the grandchild outlived the
  // timeout that was supposed to end it. SIGKILL delivery/reaping isn't instantaneous, so poll
  // briefly rather than asserting the very first check.
  const deadline = Date.now() + 2_000;
  let stillAlive = true;
  while (stillAlive && Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      stillAlive = false;
    }
  }
  expect(stillAlive).toBe(false);
});
