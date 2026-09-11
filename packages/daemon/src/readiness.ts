import type { ManagedProcessRecord, ResolvedHealthcheck } from '@wtm/core';
import type { ReadinessObservation } from '@wtm/protocol';
import type { ManagedProcessCompletion } from './logs';
import type { ProcessInspection } from './process-supervisor';

export type ReadinessFetch = (
  url: string,
  options: { signal: AbortSignal; redirect: 'manual' },
) => Promise<Pick<Response, 'status' | 'body'>>;

export interface ReadinessOptions {
  record: ManagedProcessRecord;
  healthcheck: ResolvedHealthcheck;
  timeoutMs?: number;
  signal?: AbortSignal;
  getCurrentRecord(): ManagedProcessRecord | null;
  inspectProcess(pid: number): Promise<ProcessInspection>;
  readCompletion?(stdoutPath: string, pid: number): Promise<ManagedProcessCompletion | null>;
  fetch?: ReadinessFetch;
}

export interface ReadinessResult {
  /** The originally observed process, never a replacement that happens to use its task name. */
  process: ManagedProcessRecord;
  readiness: ReadinessObservation;
}

type ObservedState = Exclude<ReadinessObservation['state'], 'NOT_CHECKED'>;
type EvidenceFailure = Exclude<ObservedState, 'READY' | 'TIMED_OUT' | 'ABORTED'>;

export function uncheckedReadiness(): ReadinessObservation {
  return { state: 'NOT_CHECKED', probe: null, attempts: 0, elapsedMs: 0, observedAt: null };
}

/**
 * A short observation owned by one request, with no supervisor lock or persistent monitor.
 * HTTP success is checked against the same live owner and its authenticated completion file
 * both before and after the request. It describes that instant, not future service health or
 * proof that another process could not have answered the configured endpoint.
 */
export async function observeReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const expected = { ...options.record };
  let current = expected;
  let attempts = 0;
  const started = performance.now();
  const deadline = started + (options.timeoutMs ?? options.healthcheck.timeoutMs);
  const observation = new AbortController();
  const abort = () => observation.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));

  const interrupted = (): 'ABORTED' | 'TIMED_OUT' | null => {
    if (options.signal?.aborted) return 'ABORTED';
    return observation.signal.aborted || performance.now() >= deadline ? 'TIMED_OUT' : null;
  };
  const finish = (state: ObservedState): ReadinessResult => ({
    process: current,
    readiness: {
      state, probe: 'http', attempts,
      elapsedMs: Math.max(0, performance.now() - started),
      observedAt: new Date().toISOString(),
    },
  });

  const checkRecord = (): EvidenceFailure | null => {
    let record: ManagedProcessRecord | null;
    try { record = options.getCurrentRecord(); }
    catch { return 'EVIDENCE_UNAVAILABLE'; }
    if (record === null) return 'PROCESS_EXITED';
    if (record.id !== expected.id || !sameIdentity(expected, record)) return 'PROCESS_CHANGED';
    current = { ...record };
    if (record.state === 'STALE_IDENTITY') return 'IDENTITY_UNCERTAIN';
    if (record.state !== 'RUNNING' || record.cleanupRequired) return 'PROCESS_EXITED';
    return null;
  };

  const checkEvidence = async (): Promise<EvidenceFailure | null> => {
    const recordFailure = checkRecord();
    if (recordFailure !== null) return recordFailure;
    if (options.readCompletion === undefined) return 'EVIDENCE_UNAVAILABLE';
    let identity: ProcessInspection;
    try {
      identity = await abortable(() => options.inspectProcess(expected.pid), observation.signal);
    } catch {
      return 'IDENTITY_UNCERTAIN';
    }
    if (identity.status === 'failed') return 'IDENTITY_UNCERTAIN';
    if (identity.status === 'absent') return 'PROCESS_EXITED';
    if (!sameIdentity(expected, identity.identity)) return 'PROCESS_CHANGED';
    try {
      const read = options.readCompletion;
      const completion = await abortable(() => read(expected.stdoutPath, expected.pid), observation.signal);
      if (completion !== null) return 'PROCESS_EXITED';
    } catch {
      return 'EVIDENCE_UNAVAILABLE';
    }
    // stop/restart may have completed while either reader awaited filesystem/platform IO.
    return checkRecord();
  };

  try {
    while (true) {
      const interruption = interrupted();
      if (interruption !== null) return finish(interruption);
      const before = await checkEvidence();
      if (interrupted() !== null) return finish(interrupted()!);
      if (before !== null) return finish(before);
      attempts += 1;
      let ready = false;
      try {
        const response = await abortable(
          () => (options.fetch ?? fetch)(options.healthcheck.url, { signal: observation.signal, redirect: 'manual' }),
          observation.signal,
        );
        try { ready = response.status >= 200 && response.status < 300; }
        finally {
          // Do not buffer bodies from health endpoints, even unsuccessful/redirect responses.
          await abortable(async () => { await response.body?.cancel(); }, observation.signal);
        }
      } catch {
        // Connection failures and non-2xx responses retry within the same overall deadline.
        // URL, response content and transport errors never enter the public observation.
      }
      if (interrupted() !== null) return finish(interrupted()!);
      const after = await checkEvidence();
      if (interrupted() !== null) return finish(interrupted()!);
      if (after !== null) return finish(after);
      if (ready) return finish('READY');
      await delay(Math.min(options.healthcheck.intervalMs, Math.max(0, deadline - performance.now())), observation.signal);
    }
  } catch {
    return finish(interrupted() ?? 'EVIDENCE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    observation.abort();
  }
}

function sameIdentity(
  record: ManagedProcessRecord,
  identity: Pick<ManagedProcessRecord, 'pid' | 'pgid' | 'processStartTime' | 'commandFingerprint'>,
): boolean {
  return record.pid === identity.pid && record.pgid === identity.pgid
    && record.processStartTime === identity.processStartTime
    && record.commandFingerprint === identity.commandFingerprint;
}

/** Readers cannot all be cancelled, but a disconnected request must stop awaiting them. */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Readiness observation ended.'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Readiness observation ended.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('Readiness observation ended.');
      return operation();
    }).then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
