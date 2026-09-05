/**
 * Keeps a raw `spawnSync('node' | 'bun' | process.execPath, ...)` from coming back into a test or
 * scenario file (spec `2026-09-03-a-hang-that-cannot-hide.md`, D5).
 *
 * That call shape is how a test drives a scenario written as its own file, and it is also the
 * shape that hung a darwin arm64 CI leg for 29 minutes on a commit that changed no product code:
 * `spawnSync`'s `timeout` sends `SIGTERM` by default, a child can ignore `SIGTERM`, and nothing
 * else in the call was watching the clock. `runScenario` fixes that once, in one place — this test
 * is what keeps a new call site from writing the fix by hand and forgetting the one part
 * (`killSignal: 'SIGKILL'`) that makes it real.
 *
 * The exception list is a literal array with a reason on every entry, the same shape
 * `platform-independence.test.ts` uses and for the same reason: widening the guard means editing
 * prose a reviewer will read, not a regular expression nobody will.
 */
import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scannedRoots = ['packages', 'scripts'] as const;

/** The call shape this guard exists to catch: spawning another JS/TS runtime synchronously. */
const pattern = /spawnSync\(\s*(?:'node'|"node"|'bun'|"bun"|process\.execPath)(?=[,)])/;

interface ReviewedException {
  file: string;
  /** Every excepted line must contain this, so an exception cannot silently widen its own scope. */
  requires: string;
  reason: string;
}

/** One entry per excepted line, not per file: two different lines need two different reasons. */
const reviewedExceptions: readonly ReviewedException[] = [
  {
    file: 'packages/testkit/src/__tests__/scenario-child.test.ts',
    requires: "spawnSync('node', ['--import', 'tsx', childPath]",
    reason:
      'Measures runScenario from outside with a hand-written bound (F1\'s outer deadline), so it '
      + 'cannot go through the function it is checking.',
  },
  {
    file: 'packages/testkit/src/__tests__/scenario-bound.child.ts',
    requires: "killSignal: 'SIGTERM'",
    reason:
      'Deliberately raw and deliberately the default kill signal: reproduces the exact pre-fix '
      + 'shape to prove it never returns inside the deadline runScenario would have honoured.',
  },
  {
    file: 'packages/testkit/src/__tests__/scenario-bound.child.ts',
    requires: "'sigterm-attempt'",
    reason: 'The deaf child spawned for both halves of the measurement above.',
  },
  {
    file: 'packages/daemon/src/__tests__/idle-daemon.scenario.ts',
    requires: "spawnSync('bun', [",
    reason: 'A `bun build` bundling step, not a scenario that can hang on a refusal path.',
  },
  {
    file: 'packages/daemon/src/__tests__/idle-daemon.scenario.ts',
    requires: 'benchmarkSource, bundlePath',
    reason:
      'Runs a benchmark, not an assertion-bearing scenario. Wall-clock is bounded transitively: '
      + 'the outer `runScenario` call in idle-daemon.test.ts kills this whole process with SIGKILL '
      + 'at its deadline regardless of what this child is doing (spec D7).',
  },
  {
    file: 'scripts/__tests__/package-contents.test.ts',
    requires: "['run', 'build']",
    reason: 'A build step, not a scenario that can hang on a refusal path; already reviewed in C2.',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * `path.relative` follows the host separator, so a Windows run of this guard produced
 * `packages\...\foo.ts` -- neither matching `reviewedExceptions`' forward-slash `file` values nor
 * the `'__tests__/'` substring below, which silently dropped every `.test.ts` file (not ending in
 * `.scenario.ts`) from the scan on that host rather than merely failing to except it. `git` itself
 * settled on forward slashes as the one true separator for a repo-relative identifier regardless of
 * host (`1a2c4cf`); this guard's own identifiers follow the same rule.
 */
function repoRelative(path: string): string {
  return relative(repositoryRoot, path).split(sep).join('/');
}

const selfPath = repoRelative(fileURLToPath(import.meta.url));

async function scannedFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of scannedRoots) await collect(join(repositoryRoot, root), found);
  return found
    .map((path) => repoRelative(path))
    .filter((path) => path !== selfPath)
    .filter((path) => path.includes('__tests__/') || path.endsWith('.scenario.ts'))
    .sort();
}

async function collect(directory: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, found);
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
}

async function findViolations(): Promise<{ violations: Violation[]; unmatchedExceptions: ReviewedException[] }> {
  const violations: Violation[] = [];
  const unmatchedExceptions = [...reviewedExceptions];
  for (const file of await scannedFiles()) {
    const lines = (await readFile(join(repositoryRoot, file), 'utf8')).split('\n');
    lines.forEach((text, index) => {
      if (!pattern.test(text)) return;
      const matchIndex = unmatchedExceptions.findIndex((entry) => entry.file === file && text.includes(entry.requires));
      if (matchIndex !== -1) {
        unmatchedExceptions.splice(matchIndex, 1);
        return;
      }
      violations.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return { violations, unmatchedExceptions };
}

test('no test or scenario file spawns node, bun, or itself synchronously outside runScenario', async () => {
  const { violations } = await findViolations();

  expect(violations.map(({ file, line, text }) => `${file}:${String(line)} ${text}`)).toEqual([]);
});

test('every reviewed exception still matches a line in its file', async () => {
  // An exception nothing matches any more is stale: the line it excused was fixed, renamed, or
  // moved, and the exception is now excusing nothing. A regex could hide that; this cannot.
  const { unmatchedExceptions } = await findViolations();

  expect(unmatchedExceptions.map((entry) => `${entry.file}: ${JSON.stringify(entry.requires)}`)).toEqual([]);
});

test('the guard actually looks at test and scenario files', async () => {
  const files = await scannedFiles();
  expect(files.length).toBeGreaterThan(30);
});
