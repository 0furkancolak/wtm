import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
