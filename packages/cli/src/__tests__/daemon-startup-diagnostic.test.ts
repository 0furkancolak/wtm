import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonStartupDiagnostic } from '../daemon-startup-diagnostic';

/**
 * The daemon questions `doctor` answers without a state database (todo item 52): is anything
 * listening, and if not, what did the daemon record about why.
 */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'wtm-startup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const unsafeHome = '/home/x/.local/state/wtm';

function failedRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    state: 'failed',
    at: '2026-09-11T10:05:00.000Z',
    pid: 4242,
    since: '2026-09-11T10:00:00.000Z',
    attempts: 3,
    code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
    condition: 'private directory unsafe',
    message: `WTM private directory is unsafe: ${unsafeHome} is readable by others (mode 755); run chmod 700 on it.`,
    remediation: ['chmod', '700', unsafeHome],
    permanent: true,
    ...overrides,
  };
}

/** A diagnostic reading `status` (or no file, for `null`) and dialing an address nothing is on. */
function diagnosticWith(status: object | null, socketPath: string | null = join(tempDir(), 'absent.sock')) {
  const statusPath = join(tempDir(), 'daemon-status.json');
  if (status !== null) writeFileSync(statusPath, JSON.stringify(status));
  return createDaemonStartupDiagnostic({ socketPath: () => socketPath, statusPath: () => statusPath });
}

async function listeningSocket(): Promise<string> {
  const path = join(tempDir(), 'wtmd.sock');
  const server = createServer();
  await new Promise<void>((done) => server.listen(path, done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return path;
}

describe('the daemon failure doctor reports without a registry', () => {
  test('a daemon that is down with a failure on record is reported with its code and its remedy', async () => {
    const item = await diagnosticWith(failedRecord()).failureItem();

    expect(item).toEqual({
      code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      message: expect.stringContaining('The daemon is not running: it failed to start 3 times since 2026-09-11T10:00:00.000Z.'),
      // Beside the answer, not the answer: on a registered machine the same record is a finding,
      // and neither may move the exit code.
      severity: 'warning',
      context: {
        startupFailedSince: '2026-09-11T10:00:00.000Z',
        startupAttempts: 3,
        startupPermanent: true,
      },
      remediation: [{ kind: 'command-suggestion', argv: ['chmod', '700', unsafeHome] }],
    });
    expect(item?.message).toContain('is readable by others (mode 755)');
    expect(item?.message).toContain(`Run \`chmod 700 ${unsafeHome}\`, then \`wtm daemon install\` to start it again.`);
  });

  test('a failure with no remedy on record points only at wtm daemon install', async () => {
    const item = await diagnosticWith(failedRecord({ remediation: null })).failureItem();

    expect(item?.remediation).toBeUndefined();
    expect(item?.message).toEndWith('Run `wtm daemon install` to start it again.');
  });

  test('a long recorded message never pushes the remedy past the envelope message limit', async () => {
    const item = await diagnosticWith(failedRecord({ message: `${'x'.repeat(3000)} tail` })).failureItem();

    expect(item?.message.length).toBeLessThanOrEqual(1024);
    expect(item?.message).not.toContain('tail');
    expect(item?.message).toEndWith(`Run \`chmod 700 ${unsafeHome}\`, then \`wtm daemon install\` to start it again.`);
  });

  test('nothing on record is no answer, because a daemon never installed is not a failure', async () => {
    expect(await diagnosticWith(null).failureItem()).toBeNull();
  });

  test('a record of a daemon that started is not a failure', async () => {
    const running = failedRecord({
      state: 'running', attempts: 1, code: null, condition: null, message: null, remediation: null, permanent: false,
    });

    expect(await diagnosticWith(running).failureItem()).toBeNull();
  });

  test('a daemon that answers is never reported down, whatever its file still says', async () => {
    // The record outlives the crash that wrote it. Once something is listening, it is history.
    expect(await diagnosticWith(failedRecord(), await listeningSocket()).failureItem()).toBeNull();
  });

  test('a code the record claims but WTM does not define is not repeated as one', async () => {
    const item = await diagnosticWith(failedRecord({ code: 'WTM_NOT_A_REAL_CODE' })).failureItem();

    expect(item?.code).toBe('WTM_DAEMON_UNAVAILABLE');
  });

  test('no address to dial is a daemon that is not running', async () => {
    const item = await diagnosticWith(failedRecord(), null).failureItem();

    expect(item?.code).toBe('WTM_PRIVATE_DIRECTORY_UNSAFE');
  });
});
