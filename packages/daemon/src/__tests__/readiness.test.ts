import { describe, expect, test } from 'bun:test';
import type { ManagedProcessRecord, ResolvedHealthcheck } from '@wtm/core';
import { observeReadiness, type ReadinessFetch, type ReadinessOptions } from '../readiness';

const record: ManagedProcessRecord = {
  id: 'process-1', worktreeId: 'worktree-1', taskName: 'dev', pid: 42, pgid: 42,
  processStartTime: 'start-1', commandFingerprint: 'fingerprint-1', state: 'RUNNING',
  startedAt: '2026-09-10T00:00:00.000Z', stoppedAt: null,
  stdoutPath: '/private/stdout.log', stderrPath: '/private/stderr.log', cleanupRequired: false,
};
const healthcheck: ResolvedHealthcheck = {
  type: 'http', url: 'http://localhost:4321/health', timeoutMs: 300, intervalMs: 100,
};

function options(overrides: Partial<ReadinessOptions> = {}): ReadinessOptions {
  return {
    record, healthcheck,
    getCurrentRecord: () => record,
    inspectProcess: async () => ({ status: 'present', identity: record }),
    readCompletion: async () => null,
    fetch: async () => new Response(null, { status: 204 }),
    ...overrides,
  };
}

describe('bounded HTTP readiness observation', () => {
  test('retries a delayed endpoint and closes every response without following redirects', async () => {
    let attempts = 0;
    let closed = 0;
    const started = performance.now();
    const result = await observeReadiness(options({
      fetch: async (url, init) => {
        expect(url).toBe(healthcheck.url);
        expect(init.redirect).toBe('manual');
        expect(init.signal.aborted).toBe(false);
        attempts += 1;
        return new Response(new ReadableStream({ cancel() { closed += 1; } }), {
          status: attempts === 1 ? 302 : 200,
        });
      },
    }));
    expect(result.process).toEqual(record);
    expect(result.readiness).toMatchObject({ state: 'READY', probe: 'http', attempts: 2 });
    expect(result.readiness.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(Date.parse(result.readiness.observedAt!)).not.toBeNaN();
    expect(closed).toBe(2);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('a continuously failed endpoint times out and exposes no URL or request errors', async () => {
    const result = await observeReadiness(options({
      timeoutMs: 35,
      fetch: async () => { throw new Error('secret token in http://private.invalid'); },
    }));
    expect(result.readiness).toMatchObject({ state: 'TIMED_OUT', attempts: 1 });
    expect(JSON.stringify(result)).not.toContain('secret token');
    expect(JSON.stringify(result)).not.toContain('private.invalid');
  });

  test('aborts a hung HTTP request at the overall deadline', async () => {
    let aborted = false;
    const result = await observeReadiness(options({
      timeoutMs: 35,
      fetch: async (_url, init) => await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    }));
    expect(result.readiness.state).toBe('TIMED_OUT');
    expect(aborted).toBe(true);
  });

  test('a hanging response body cancellation cannot outlive the observation deadline', async () => {
    const result = await observeReadiness(options({
      timeoutMs: 35,
      fetch: async () => new Response(new ReadableStream({ cancel: async () => await new Promise(() => {}) }), { status: 200 }),
    }));
    expect(result.readiness.state).toBe('TIMED_OUT');
  });

  test('a record deleted during the probe cannot produce READY', async () => {
    let current: ManagedProcessRecord | null = record;
    const result = await observeReadiness(options({
      getCurrentRecord: () => current,
      fetch: async () => { current = null; return new Response(null, { status: 200 }); },
    }));
    expect(result.readiness.state).toBe('PROCESS_EXITED');
    expect(result.process.id).toBe(record.id);
  });

  test.each(['STOPPED', 'STOPPING', 'FAILED'] as const)('does not probe a %s managed record', async (state) => {
    let attempts = 0;
    const result = await observeReadiness(options({
      getCurrentRecord: () => ({ ...record, state }),
      fetch: async () => { attempts += 1; return new Response(null, { status: 200 }); },
    }));
    expect(result.readiness.state).toBe('PROCESS_EXITED');
    expect(attempts).toBe(0);
  });

  test.each(['id', 'pid', 'pgid', 'processStartTime', 'commandFingerprint'] as const)(
    'a successful probe cannot bless a replacement %s', async (field) => {
      let current = record;
      const result = await observeReadiness(options({
        getCurrentRecord: () => current,
        fetch: async () => {
          current = { ...record, [field]: typeof record[field] === 'number' ? 99 : 'different' };
          return new Response(null, { status: 200 });
        },
      }));
      expect(result.readiness.state).toBe('PROCESS_CHANGED');
      expect(result.readiness.attempts).toBe(1);
    },
  );

  test('rechecks record state after an awaited identity inspection', async () => {
    let current = record;
    let inspections = 0;
    const result = await observeReadiness(options({
      getCurrentRecord: () => current,
      inspectProcess: async () => {
        inspections += 1;
        if (inspections === 2) current = { ...record, state: 'STOPPING' };
        return { status: 'present', identity: record };
      },
    }));
    expect(result.readiness.state).toBe('PROCESS_EXITED');
  });

  test.each(['failed', 'absent', 'mismatch'] as const)('refuses %s process identity after HTTP success', async (status) => {
    let inspections = 0;
    const result = await observeReadiness(options({
      inspectProcess: async () => {
        inspections += 1;
        if (inspections === 1) return { status: 'present', identity: record };
        if (status === 'failed') return { status: 'failed', reason: 'SECRET_INSPECTION_DETAIL' };
        if (status === 'absent') return { status: 'absent' };
        return { status: 'present', identity: { ...record, processStartTime: 'reused-pid' } };
      },
    }));
    expect(result.readiness.state).toBe(status === 'failed' ? 'IDENTITY_UNCERTAIN' : status === 'absent' ? 'PROCESS_EXITED' : 'PROCESS_CHANGED');
    expect(JSON.stringify(result)).not.toContain('SECRET_INSPECTION_DETAIL');
  });

  test.each(['exited', 'unreadable'] as const)('refuses %s completion evidence published during the probe', async (mode) => {
    let completed = false;
    const result = await observeReadiness(options({
      fetch: async () => { completed = true; return new Response(null, { status: 200 }); },
      readCompletion: async () => {
        if (!completed) return null;
        if (mode === 'unreadable') throw new Error('private marker failure');
        return { pid: record.pid, exitCode: 0, signal: null, completedAt: record.startedAt, logFailed: false };
      },
    }));
    expect(result.readiness.state).toBe(mode === 'exited' ? 'PROCESS_EXITED' : 'EVIDENCE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('private marker failure');
  });

  test('fails closed without a completion reader', async () => {
    const input = options();
    delete input.readCompletion;
    const result = await observeReadiness(input);
    expect(result.readiness).toMatchObject({ state: 'EVIDENCE_UNAVAILABLE', attempts: 0 });
  });

  test('disconnect cancels the outstanding request and starts no retry', async () => {
    const abort = new AbortController();
    let observedAbort = false;
    const fetch: ReadinessFetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('cancelled')); }, { once: true });
      abort.abort();
    });
    const result = await observeReadiness(options({ signal: abort.signal, fetch }));
    expect(result.readiness).toMatchObject({ state: 'ABORTED', attempts: 1 });
    expect(observedAbort).toBe(true);
  });

  test('disconnect cancels the retry timer without a second request', async () => {
    const abort = new AbortController();
    let attempts = 0;
    const timer = setTimeout(() => abort.abort(), 20);
    try {
      const result = await observeReadiness(options({
        signal: abort.signal,
        fetch: async () => { attempts += 1; return new Response(null, { status: 503 }); },
      }));
      expect(result.readiness.state).toBe('ABORTED');
      expect(attempts).toBe(1);
    } finally { clearTimeout(timer); }
  });

  test('an already aborted observation never probes or reads process evidence', async () => {
    const result = await observeReadiness(options({
      signal: AbortSignal.abort(),
      inspectProcess: async () => { throw new Error('must not inspect'); },
      fetch: async () => { throw new Error('must not fetch'); },
    }));
    expect(result.readiness).toMatchObject({ state: 'ABORTED', attempts: 0 });
  });
});
