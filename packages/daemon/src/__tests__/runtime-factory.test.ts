import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  inspectProcessGroup,
  inspectProcessIdentity,
  type ProcessIdentity,
} from '../process-supervisor';

const scenarioPath = fileURLToPath(new URL('./runtime-factory.scenario.ts', import.meta.url));
const privateDatabaseScenarioPath = fileURLToPath(new URL('./private-database.scenario.ts', import.meta.url));

describe('production daemon composition', () => {
  test('runs CLI start, ps, and stop through a real temporary socket and SQLite store', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      startExit: 0,
      startState: 'RUNNING',
      psRunning: true,
      stopExit: 0,
      stopState: 'STOPPED',
    });
  }, 20_000);

  test('default CLI client reaches the documented HOME socket without runtime injection', () => {
    const home = mkdtempSync('/tmp/wtm-default-home-');
    try {
      const result = spawnSync('node', ['--import', 'tsx', scenarioPath, 'default-client'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, HOME: home },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        startExit: 0,
        startState: 'RUNNING',
        psRunning: true,
        stopExit: 0,
        stopState: 'STOPPED',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('closing the daemon releases control handles while a detached task remains live', async () => {
    const child = spawn('node', ['--import', 'tsx', scenarioPath, 'close-live'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = waitForExit(child, 15_000);
    const output = await readJsonLine(child.stdout);
    const identity = output.identity as ProcessIdentity;
    try {
      expect(output).toMatchObject({ startExit: 0, startState: 'RUNNING' });
      expect(await inspectProcessIdentity(identity.pid)).toEqual(identity);
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null, stderr: '' });
      expect(await inspectProcessIdentity(identity.pid)).toEqual(identity);
    } finally {
      const current = await inspectProcessIdentity(identity.pid);
      if (current !== null && sameIdentity(current, identity)) {
        try { process.kill(-identity.pgid, 'SIGKILL'); } catch (error) {
          if (!isNoSuchProcess(error)) throw error;
        }
        await waitForGroupAbsent(identity.pgid);
      }
    }
  }, 20_000);

  test('uses the private custom database parent rather than only the data root', () => {
    const result = spawnSync('node', ['--import', 'tsx', privateDatabaseScenarioPath], {
      encoding: 'utf8', timeout: 20_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ created: true, unsafeParentRejected: true });
  }, 20_000);
});

async function readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  let value = '';
  for await (const chunk of stream) {
    value += String(chunk);
    const newline = value.indexOf('\n');
    if (newline >= 0) return JSON.parse(value.slice(0, newline)) as Record<string, unknown>;
  }
  throw new Error('Scenario closed stdout before its result');
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  watchdogMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stderr });
      return;
    }
    const timer = setTimeout(() => reject(new Error('Scenario exit watchdog expired')), watchdogMs);
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForGroupAbsent(pgid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await inspectProcessGroup(pgid)).status !== 'absent') {
    if (Date.now() >= deadline) throw new Error('Fixture group cleanup timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid
    && left.processStartTime === right.processStartTime
    && left.commandFingerprint === right.commandFingerprint;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
