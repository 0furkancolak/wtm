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

  test('would not have been ended by the same deadline with the default kill signal', () => {
    // This is the reason `killSignal` is set at all. If this ever reports `returned: true`, the
    // platform has changed underneath the fix and the comment in `scenario-child.ts` needs redoing.
    expect(report.sigtermAttempt.returned).toBe(false);
    expect(report.sigtermAttempt.killedByOuterBound).toBe(true);
  });
});
