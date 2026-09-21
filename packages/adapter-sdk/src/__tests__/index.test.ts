import { expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import type { AdapterContext, AdapterMetadata } from '@wtm/protocol';
import { protocolVersion } from '@wtm/protocol';
import { defineAdapter, runAdapter, type AdapterHandlers, type AdapterIo } from '../index';

function ioFor(requestBody: unknown): AdapterIo & { stdoutText(): string; stderrText(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdin: Readable.from([JSON.stringify(requestBody)]) as unknown as NodeJS.ReadableStream,
    stdout: new Writable({
      write(chunk: Buffer, _encoding, callback) { stdout.push(chunk.toString()); callback(); },
    }) as unknown as NodeJS.WritableStream,
    stderr: new Writable({
      write(chunk: Buffer, _encoding, callback) { stderr.push(chunk.toString()); callback(); },
    }) as unknown as NodeJS.WritableStream,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

const metadata: AdapterMetadata = { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] };
const context: AdapterContext = {
  workspace: { root: '/w' },
  repository: { root: '/w/repo', mainRoot: '/w/repo' },
  worktree: { root: '/w/repo', id: 1, branch: 'main' },
};

function handlers(overrides: Partial<AdapterHandlers> = {}): AdapterHandlers {
  return defineAdapter({
    metadata: () => metadata,
    detect: () => ({ detected: true, confidence: 1, evidence: [] }),
    plan: () => ({ resources: [], actions: [], capabilities: {}, tasks: {} }),
    doctor: () => [],
    ...overrides,
  });
}

test('wraps metadata in the protocol envelope', async () => {
  const io = ioFor({ protocol: protocolVersion, operation: 'metadata' });
  expect(await runAdapter(handlers(), io)).toBe(true);
  expect(JSON.parse(io.stdoutText())).toEqual({ protocol: protocolVersion, adapter: metadata });
});

test('passes the request context through to detect', async () => {
  let received: AdapterContext | undefined;
  const io = ioFor({ protocol: protocolVersion, operation: 'detect', ...context });
  await runAdapter(handlers({
    detect: (ctx) => {
      received = ctx;
      return { detected: false, confidence: 0, evidence: [] };
    },
  }), io);
  expect(received).toEqual(context);
  expect(JSON.parse(io.stdoutText())).toEqual({ detected: false, confidence: 0, evidence: [] });
});

test('returns the plan response unwrapped', async () => {
  const plan = { resources: [], actions: [], capabilities: {}, tasks: {} };
  const io = ioFor({ protocol: protocolVersion, operation: 'plan', ...context });
  await runAdapter(handlers({ plan: () => plan }), io);
  expect(JSON.parse(io.stdoutText())).toEqual(plan);
});

test('wraps doctor findings in { findings }', async () => {
  // `code` is drawn from @wtm/protocol's shared `WtmErrorCode` enum, not a freeform string --
  // see the note in docs/19-adapter-authoring-guide.md.
  const finding = { code: 'ADAPTER_DETECTION_AMBIGUOUS' as const, message: 'looks off', severity: 'warning' as const };
  const io = ioFor({ protocol: protocolVersion, operation: 'doctor', ...context });
  await runAdapter(handlers({ doctor: () => [finding] }), io);
  expect(JSON.parse(io.stdoutText())).toEqual({ findings: [finding] });
});

test('cleanup-plan defaults to no actions when the handler is not implemented', async () => {
  const io = ioFor({ protocol: protocolVersion, operation: 'cleanup-plan', ...context });
  await runAdapter(handlers(), io);
  expect(JSON.parse(io.stdoutText())).toEqual({ actions: [] });
});

test('cleanup-plan calls the handler when implemented', async () => {
  const io = ioFor({ protocol: protocolVersion, operation: 'cleanup-plan', ...context });
  await runAdapter(handlers({
    cleanupPlan: () => ({ actions: [{ type: 'delete-owned-resource', resource: 'cache' }] }),
  }), io);
  expect(JSON.parse(io.stdoutText())).toEqual({ actions: [{ type: 'delete-owned-resource', resource: 'cache' }] });
});

test('reports a malformed request on stderr and resolves false, without touching process.exitCode', async () => {
  const io = ioFor('not an object');
  expect(await runAdapter(handlers(), io)).toBe(false);
  expect(io.stdoutText()).toBe('');
  expect(io.stderrText()).toContain('invalid adapter request');
});

test('rejects an incompatible protocol minor', async () => {
  // `protocolVersionSchema` pins `major` to the literal 1, so a major mismatch is already a schema
  // failure by the time it would reach `isProtocolVersionCompatible` -- only a minor mismatch
  // reaches this branch, and v1.0 (today's only minor) treats any other minor as incompatible too.
  const io = ioFor({ protocol: { major: 1, minor: 7 }, operation: 'metadata' });
  expect(await runAdapter(handlers(), io)).toBe(false);
  expect(io.stderrText()).toContain('incompatible protocol 1.7');
});

test('reports a handler that throws on stderr instead of crashing the process', async () => {
  const io = ioFor({ protocol: protocolVersion, operation: 'metadata' });
  expect(await runAdapter(handlers({
    metadata: () => { throw new Error('boom'); },
  }), io)).toBe(false);
  expect(io.stderrText()).toContain('adapter metadata failed: boom');
});
