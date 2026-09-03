import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

/**
 * How long a scenario child may run before the test that spawned it gives up on it.
 *
 * Every scenario is driven with `spawnSync`, which blocks the thread it runs on. A test runner's
 * per-test timeout cannot interrupt a blocking call, so a child that never exits does not fail its
 * test — it stops the entire run, for as long as whatever is above it will wait. Twice this took a
 * release job past forty minutes on a suite whose slowest honest scenario finishes in twenty-two
 * seconds.
 *
 * The bound is generous on purpose: it is there to end a hang, not to measure anything. A scenario
 * that legitimately approaches it has changed enough to be looked at.
 */
export const scenarioTimeoutMs = 120_000;

export interface RunScenarioOptions extends Omit<SpawnSyncOptions, 'timeout' | 'killSignal' | 'encoding'> {
  /** Overrides {@link scenarioTimeoutMs}. Only tests measuring the bound itself should need this. */
  timeoutMs?: number;
}

/**
 * Runs a scenario child and returns its parsed stdout, or throws.
 *
 * `spawnSync`'s `timeout` sends `killSignal` and then keeps waiting for the child to exit —
 * `SIGTERM`, the default, is a request a child can ignore, and one that does turns the deadline
 * into nothing: the call never returns, and neither does the test that made it, nor the suite
 * around that test. This is what stopped a darwin arm64 CI leg for 29 minutes on a commit that
 * changed no product code. `SIGKILL` cannot be caught, which is what makes the deadline real
 * (measured in `docs/superpowers/specs/2026-09-03-a-hang-that-cannot-hide.md`, F1).
 *
 * Every scenario spawn goes through this function rather than calling `spawnSync` with the same
 * options written out by hand, so the bound cannot be dropped one call site at a time.
 */
export function runScenario(
  command: string,
  args: readonly string[],
  options: RunScenarioOptions = {},
): { status: number | null; stdout: string; stderr: string } {
  const { timeoutMs = scenarioTimeoutMs, ...rest } = options;
  const result = spawnSync(command, args, {
    ...rest,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const commandLine = [command, ...args].join(' ');
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(
      `scenario did not finish inside ${String(timeoutMs)}ms and was killed: ${commandLine}`,
    );
  }
  if (result.error !== undefined) {
    throw new Error(`could not run scenario: ${commandLine}\n${String(result.error)}`);
  }
  if (result.signal !== null) {
    throw new Error(`scenario ${commandLine} was killed by ${result.signal}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
