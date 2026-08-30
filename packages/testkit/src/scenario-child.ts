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
