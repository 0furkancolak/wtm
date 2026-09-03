/**
 * Measures both halves of the claim that `runScenario` bounds a scenario child.
 *
 * This runs out of process because half of what it measures is a call that does not return. The
 * test that spawns this file bounds it with an explicit `killSignal: 'SIGKILL'` written literally
 * there, so a regression in `runScenario` fails that test instead of stopping the run — which is
 * the whole subject of this measurement.
 */
import { spawnSync } from 'node:child_process';
import { runScenario } from '../scenario-child';

/** A child that installs an empty `SIGTERM` handler: it hears the signal and declines to die. */
const deafChild = ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);'];

if (process.argv[2] === 'sigterm-attempt') {
  // Deliberately the *old* behaviour: the deadline with the default kill signal. If this returns,
  // the parent below records how long it took; if it does not, the parent's SIGKILL ends it and
  // records that. Either way nothing here is allowed to run unbounded.
  const started = Date.now();
  spawnSync(process.execPath, deafChild, { timeout: 500, killSignal: 'SIGTERM', encoding: 'utf8' });
  process.stdout.write(JSON.stringify({ returnedAfterMs: Date.now() - started }));
  process.exit(0);
}

// Half one: the deadline with `SIGKILL`, through the helper.
const bounded = { deadlineMs: 1_500, elapsedMs: 0, threw: false, message: '' };
const boundedStarted = Date.now();
try {
  runScenario(process.execPath, deafChild, { timeoutMs: bounded.deadlineMs });
} catch (error) {
  bounded.threw = true;
  bounded.message = error instanceof Error ? error.message : String(error);
}
bounded.elapsedMs = Date.now() - boundedStarted;

// Half two: the same deadline with the default kill signal, bounded from out here.
const attemptDeadlineMs = 5_000;
const attempt = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'sigterm-attempt'], {
  timeout: attemptDeadlineMs, killSignal: 'SIGKILL', encoding: 'utf8',
});

process.stdout.write(JSON.stringify({
  bounded,
  sigtermAttempt: {
    deadlineMs: attemptDeadlineMs,
    // `ETIMEDOUT` here means the inner 500 ms deadline never ended the call and this outer
    // `SIGKILL` had to.
    returned: attempt.error === undefined,
    killedByOuterBound: (attempt.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  },
}));
