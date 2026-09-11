import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { anchorSource } from '../process-anchor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fixture(options: { pendingOpen?: boolean; pendingCompletion?: boolean; deadlineMs?: number; rejectOpen?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-capability-'));
  const require = createRequire(import.meta.url);
  const stdoutLog = new PassThrough();
  const stderrLog = new PassThrough();
  stdoutLog.resume(); stderrLog.resume();
  const opened = deferred<{ stdout: PassThrough; stderr: PassThrough }>();
  const completionAllowed = deferred<void>();
  let completionCalls = 0;
  let now = Date.parse('2026-09-10T00:00:00.000Z');
  class Clock extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static override now() { return now; }
  }
  let ready = '';
  let status = '';
  let starts = 0;
  let opens = 0;
  let factories = 0;
  let kills = 0;
  const completions: unknown[] = [];
  const timers = new Set<{ at: number; callback: () => void }>();
  const input = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
  const paths = { root, stdoutPath: join(root, 'stdout.log'), stderrPath: join(root, 'stderr.log'),
    launchMarkerPath: join(root, 'launch.json'), completionMarkerPath: join(root, 'completion.json'),
    rotationBytes: 128, retainedFiles: 3 };
  const anchorProcess = Object.assign(new EventEmitter(), {
    pid: 100, env: { WTM_ANCHOR_SPEC: JSON.stringify({ platform: 'win32', argv: ['fixture-task'],
      deadlineAt: options.deadlineMs === undefined ? undefined : now + options.deadlineMs, logs: paths }) },
    stdin: input, stdout: { end(value = '') { ready += value; } },
    stderr: { end(value = '') { status += value; } }, cwd: () => root, exitCode: 0,
  });
  const capability = {
    async open() {
      opens++;
      if (options.rejectOpen) throw new Error('UNSAFE_LOG_DIRECTORY');
      return options.pendingOpen ? opened.promise : { stdout: stdoutLog, stderr: stderrLog };
    },
    async publishLaunch() {},
    async publishCompletion(value: unknown) {
      completionCalls++;
      if (options.pendingCompletion) await completionAllowed.promise;
      completions.push(typeof value === 'function' ? value() : value);
    },
    async close() { stdoutLog.destroy(); stderrLog.destroy(); },
  };
  const childProcess = {
    spawn() {
      starts++;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.end('verified output'); child.stderr.end(); child.emit('exit', 0, null);
      });
      return child;
    },
    execFile(file: string, _args: string[], _options: unknown, callback: (error: null, output: string) => void) {
      if (file === 'taskkill.exe') kills++;
      queueMicrotask(() => callback(null, JSON.stringify([{ ProcessId: 100, ParentProcessId: 1,
        CreationDate: '2026-09-10T00:00:00.000Z', Name: 'node.exe', CommandLine: 'verified-anchor' }])));
      return { pid: 999 };
    },
  };
  runInNewContext(anchorSource, {
    process: anchorProcess, Date: Clock, Buffer, AbortController,
    createAnchorLogStore(platform: string, logs: unknown) {
      factories++; expect(platform).toBe('win32'); expect(logs).toEqual(paths); return capability;
    },
    require(name: string) {
      if (name === 'node:child_process') return childProcess;
      if (name !== 'node:fs') return require(name);
      // Model the native Windows mode bits that cannot express a POSIX 0700 directory.
      // This is a capability-dispatch fixture, not native ACL evidence.
      return { ...fs, lstatSync(path: fs.PathLike) {
        const stat = fs.lstatSync(path);
        if (stat.isDirectory()) stat.mode |= 0o077;
        return stat;
      } };
    },
    setTimeout(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback }; timers.add(timer);
      return Object.assign(timer, { unref() {} });
    },
    clearTimeout(timer: { at: number; callback: () => void }) { timers.delete(timer); },
    setInterval() { return { unref() {} }; },
  });
  await flush();
  expect(ready).toStartWith('READY ');
  return {
    go() { input.emit('data', 'GO\n'); },
    cancel() { anchorProcess.emit('SIGTERM'); },
    openResolved() { opened.resolve({ stdout: stdoutLog, stderr: stderrLog }); },
    completionResolved() { completionAllowed.resolve(); },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
    },
    read() { return { factories, opens, starts, kills, status, completions, completionCalls, exitCode: anchorProcess.exitCode }; },
    async close() { stdoutLog.destroy(); stderrLog.destroy(); await rm(root, { recursive: true, force: true }); },
  };
}

test('the anchor uses the selected log-trust capability instead of POSIX mode bits on Windows', async () => {
  const run = await fixture();
  try {
    run.go(); await flush(); run.advance(250); await flush();
    expect(run.read()).toMatchObject({ factories: 1, opens: 1, starts: 1, status: 'LAUNCHED\n' });
    expect(run.read().completions).toContainEqual(expect.objectContaining({ exitCode: 0, logFailed: false }));
  } finally { await run.close(); }
});

test('an ACL refusal never starts the task or reports launch success', async () => {
  const run = await fixture({ rejectOpen: true });
  try {
    run.go(); await flush();
    expect(run.read()).toMatchObject({ factories: 1, opens: 1, starts: 0, status: 'ERROR LOG_SETUP_FAILED\n' });
  } finally { await run.close(); }
});

test('deadline expiry during asynchronous log authorization cannot resume a stale GO', async () => {
  const run = await fixture({ pendingOpen: true, deadlineMs: 100 });
  try {
    run.go(); await flush();
    expect(run.read()).toMatchObject({ opens: 1, starts: 0 });
    run.advance(101); await flush();
    run.openResolved(); await flush();
    expect(run.read().starts).toBe(0);
    expect(run.read().status).not.toContain('LAUNCHED');
    expect(run.read().completions).toContainEqual(expect.objectContaining({ timedOut: true }));
  } finally { await run.close(); }
});

test('SIGTERM cancellation during asynchronous log authorization cannot resume a stale GO', async () => {
  const run = await fixture({ pendingOpen: true });
  try {
    run.go(); await flush();
    expect(run.read()).toMatchObject({ opens: 1, starts: 0 });
    run.cancel(); run.openResolved(); await flush(); run.advance(250); await flush();
    expect(run.read()).toMatchObject({ starts: 0, status: 'ERROR ANCHOR_ABORTED\n', exitCode: 143 });
    expect(run.read().completions).toContainEqual(expect.objectContaining({ signal: 'SIGTERM', exitCode: null }));
  } finally { await run.close(); }
});

test('deadline during completion authorization publishes one late-evaluated timeout result', async () => {
  const run = await fixture({ pendingCompletion: true, deadlineMs: 500 });
  try {
    run.go(); await flush(); run.advance(250); await flush();
    expect(run.read()).toMatchObject({ starts: 1, completionCalls: 1, completions: [] });
    run.advance(251); await flush();
    expect(run.read().completionCalls).toBe(1);
    run.completionResolved(); await flush();
    expect(run.read()).toMatchObject({ exitCode: 124, completionCalls: 1 });
    expect(run.read().completions).toEqual([expect.objectContaining({ timedOut: true, exitCode: null, signal: null })]);
  } finally { run.completionResolved(); await run.close(); }
});
