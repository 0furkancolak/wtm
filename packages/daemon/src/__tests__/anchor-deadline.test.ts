import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ManagedLogStore } from '../logs';
import { anchorSource } from '../process-anchor';
import { createAnchorLogStore } from '../anchor-log-trust';

test('an anchor whose READY-to-GO handshake consumes its deadline never spawns the task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-deadline-'));
  const logs = new ManagedLogStore({ root: join(root, 'logs') });
  const paths = await logs.prepare('worktree', 'job-deadline');
  const require = createRequire(import.meta.url);
  let now = Date.parse('2026-09-09T00:00:00.000Z');
  class ControlledDate extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static override now() { return now; }
  }
  const input = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
  let ready = '';
  let status = '';
  let spawns = 0;
  let timers = 0;
  const anchorProcess = Object.assign(new EventEmitter(), {
    pid: 100,
    env: { WTM_ANCHOR_SPEC: JSON.stringify({ platform: 'darwin', argv: ['would-mutate-source'], deadlineAt: now + 50, logs: paths }) },
    stdin: input,
    stdout: { end: (value: string) => { ready += value; } },
    stderr: { end: (value: string) => { status += value; } },
    cwd: () => root,
    getuid: () => process.getuid?.(),
    exitCode: 0,
  });
  try {
    // Execute the same anchor source shipped to child processes. Only the clock, process
    // boundary and native ps response are controlled; completion uses the real private files.
    runInNewContext(anchorSource, {
      process: anchorProcess, Date: ControlledDate, Buffer, AbortController, createAnchorLogStore,
      require: (name: string) => name !== 'node:child_process' ? require(name) : {
        spawn: () => { spawns++; throw new Error('TASK_SPAWNED_AFTER_DEADLINE'); },
        execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
          queueMicrotask(() => callback(null, '100 S Wed Sep 9 00:00:00 2026 node verified-anchor\n'));
          return { pid: 99999 };
        },
      },
      setTimeout: () => { timers++; return { unref() {} }; },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ready).toStartWith('READY ');
    now += 51; // The task was eligible before READY, but its ownership handshake used the budget.
    expect(() => input.emit('data', 'GO\n')).not.toThrow();
    expect(spawns).toBe(0);
    expect(timers).toBe(0);
    expect(status).toBe('ERROR ANCHOR_DEADLINE_EXPIRED\n');
    // ACL-backed publication is asynchronous; launch refusal above remains synchronous.
    for (let turn = 0; turn < 12; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await logs.readCompletion(paths.stdoutPath, 100)).toMatchObject({ timedOut: true, exitCode: null, signal: null });
    expect(anchorProcess.exitCode).not.toBe(0);
  } finally { await logs.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
