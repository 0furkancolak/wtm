/**
 * The bound `runScenario` exists to provide, measured on this host rather than asserted.
 *
 * A scenario child that will not die on `SIGTERM` once stopped a darwin arm64 CI leg for 29
 * minutes 31 seconds on a commit that changed no product code (run `33658769131`). Two guards were
 * in place and both were requests rather than bounds: `spawnSync`'s `timeout`, which sends
 * `SIGTERM` and then waits indefinitely, and the runner's per-test timeout, which cannot fire while
 * `spawnSync` is blocking the thread it would fire on.
 *
 * So this file measures the fix instead of trusting it, on every platform and every run.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { isWindowsTestHost } from '../platform';
import { scenarioTestSlackMs, scenarioTestTimeoutMs, scenarioTimeoutMs } from '../scenario-child';

const childPath = fileURLToPath(new URL('./scenario-bound.child.ts', import.meta.url));

interface Report {
  bounded: { deadlineMs: number; elapsedMs: number; threw: boolean; message: string };
  sigtermAttempt: { deadlineMs: number; returned: boolean; killedByOuterBound: boolean };
}

/**
 * The one bound in this file that is written out by hand rather than taken from the code under
 * test. It has to be: if `runScenario` regresses to the default kill signal, the child below stops
 * returning, and this is what turns that into a failing test instead of a stopped run.
 */
const outerDeadlineMs = 30_000;

function measure(): Report {
  const result = spawnSync('node', ['--import', 'tsx', childPath], {
    timeout: outerDeadlineMs, killSignal: 'SIGKILL', encoding: 'utf8',
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(
      `the measurement child did not return inside ${String(outerDeadlineMs)}ms, which is what a `
      + 'scenario deadline that no longer kills with SIGKILL looks like from out here',
    );
  }
  if (result.error !== undefined) throw new Error(`could not run the measurement child: ${String(result.error)}`);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as Report;
}

const report = measure();

describe('a scenario child that will not die on SIGTERM', () => {
  test('is ended by its deadline rather than outliving it', () => {
    // The slack is for process start-up and for a loaded CI runner, not for a second attempt at
    // killing anything: `SIGKILL` is delivered once and cannot be declined.
    expect(report.bounded.elapsedMs).toBeLessThan(report.bounded.deadlineMs + 10_000);
  });

  test('fails the test that spawned it, naming the deadline it exceeded', () => {
    expect(report.bounded.threw).toBe(true);
    expect(report.bounded.message).toContain(String(report.bounded.deadlineMs));
    expect(report.bounded.message).toMatch(/did not finish|timed out/i);
  });

  /**
   * This is the reason `killSignal` is set at all — on a platform where a process can decline a
   * signal. Windows is not one: Node documents `subprocess.kill()` as terminating the child
   * unconditionally there, whatever signal name it is handed, so no child can be made to survive
   * the default and the fixture this measurement needs cannot exist.
   *
   * The expectation therefore states the platform rather than a single answer. It is not a
   * weakening: the Windows branch asserts the *opposite* result, so a Windows runner that started
   * honouring `SIGTERM` the POSIX way would fail here just as loudly as a POSIX runner that
   * stopped. And `killSignal` stays set regardless, because the platforms that need it still do.
   */
  test('would not have been ended by the same deadline with the default kill signal', () => {
    if (isWindowsTestHost) {
      expect(report.sigtermAttempt.returned).toBe(true);
      expect(report.sigtermAttempt.killedByOuterBound).toBe(false);
      return;
    }
    expect(report.sigtermAttempt.returned).toBe(false);
    expect(report.sigtermAttempt.killedByOuterBound).toBe(true);
  });
});

/**
 * Which of a scenario test's two deadlines is allowed to fire.
 *
 * Only the scenario bound can end the child, and only it names what it killed; the per-test bound
 * blocks on the same `spawnSync` and can do nothing but report afterwards. A per-test bound set
 * below the scenario bound therefore reports a bare timeout for a run that took the scenario's
 * full bound anyway — which is what the win32 leg printed for the 9e scenario files, at POSIX
 * numbers on a platform whose process observation is budgeted at fifteen times the POSIX one.
 */
describe('the per-test bound that pairs with a scenario bound', () => {
  test('leaves the scenario deadline the one that can fire', () => {
    expect(scenarioTestTimeoutMs()).toBeGreaterThan(scenarioTimeoutMs);
    for (const bound of [1_000, 30_000, scenarioTimeoutMs]) {
      expect(scenarioTestTimeoutMs(bound)).toBeGreaterThan(bound);
    }
  });

  test('is that bound plus one fixed slack, not a number per call site', () => {
    expect(scenarioTestTimeoutMs(30_000)).toBe(30_000 + scenarioTestSlackMs);
    expect(scenarioTestTimeoutMs()).toBe(scenarioTimeoutMs + scenarioTestSlackMs);
  });
});
