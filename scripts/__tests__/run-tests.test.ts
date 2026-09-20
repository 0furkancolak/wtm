import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/testkit/src/scenario-child';
import {
  bunTestArguments,
  defaultFileTimeoutMs,
  discoverTestFiles,
  fileTimeoutCeilingMs,
  parseRunnerArguments,
} from '../run-tests';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const runnerPath = fileURLToPath(new URL('../run-tests.ts', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-run-tests-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('parseRunnerArguments', () => {
  test('keeps the last --timeout, the way bun does when `bun run test --timeout N` appends one', () => {
    const parsed = parseRunnerArguments(['--timeout', '30000', '--timeout', '60000']);
    expect(parsed.testTimeoutMs).toBe(60_000);
    expect(parsed.fileTimeoutMs).toBe(defaultFileTimeoutMs(60_000));
    expect(parsed.patterns).toEqual([]);
    expect(parsed.forwarded).toEqual([]);
  });

  test('accepts the = form and an explicit per-file wall-clock limit', () => {
    const parsed = parseRunnerArguments(['--timeout=300000', '--file-timeout=90000']);
    expect(parsed.testTimeoutMs).toBe(300_000);
    expect(parsed.fileTimeoutMs).toBe(90_000);
  });

  test('never lets the per-file limit undercut a single test, nor outlive the job that runs it', () => {
    expect(defaultFileTimeoutMs(1_000)).toBe(300_000);
    expect(defaultFileTimeoutMs(60_000)).toBe(300_000);
    // win32 CI passes --timeout 300000, and ci.yml caps that job at 25 minutes. Five times the
    // per-test bound would be exactly 25 minutes: a guard that can only fire after the job has
    // already been killed. The ceiling is what keeps it a guard there.
    expect(defaultFileTimeoutMs(300_000)).toBe(fileTimeoutCeilingMs);
    expect(fileTimeoutCeilingMs).toBe(600_000);
  });

  test('forwards a boolean flag without eating the argument after it', () => {
    // --changed takes no value; treating it as if it did swallowed the path pattern behind it.
    const parsed = parseRunnerArguments(['--changed', 'packages/core']);
    expect(parsed.forwarded).toEqual(['--changed']);
    expect(parsed.patterns).toEqual(['packages/core']);
  });

  test('separates path patterns from bun flags it forwards, including flags that take a value', () => {
    const parsed = parseRunnerArguments(['-t', 'daemon close', 'process-supervisor', '--bail', '--only-failures', 'remove']);
    expect(parsed.patterns).toEqual(['process-supervisor', 'remove']);
    expect(parsed.forwarded).toEqual(['-t', 'daemon close', '--bail', '--only-failures']);
    expect(parsed.nameFilter).toBe(true);
  });

  test('takes a whole-run budget, and leaves it unset when nobody asks for one', () => {
    expect(parseRunnerArguments(['--budget', '1200000']).budgetMs).toBe(1_200_000);
    expect(parseRunnerArguments(['--budget=1200000']).budgetMs).toBe(1_200_000);
    expect(parseRunnerArguments(['--timeout', '60000']).budgetMs).toBeUndefined();
  });

  test('refuses a non-numeric bound instead of running unbounded', () => {
    expect(() => parseRunnerArguments(['--timeout', 'soon'])).toThrow(/--timeout/);
    expect(() => parseRunnerArguments(['--file-timeout', '0'])).toThrow(/--file-timeout/);
    expect(() => parseRunnerArguments(['--timeout'])).toThrow(/--timeout/);
  });
});

describe('bunTestArguments', () => {
  test('runs exactly one file, sequentially, with the same per-test bound', () => {
    const parsed = parseRunnerArguments(['--timeout', '60000']);
    expect(bunTestArguments(parsed, 'packages/a/src/__tests__/a.test.ts'))
      .toEqual(['test', '--max-concurrency=1', '--timeout=60000', './packages/a/src/__tests__/a.test.ts']);
  });

  test('lets a name filter skip files it matches nothing in, instead of failing each of them', () => {
    const parsed = parseRunnerArguments(['-t', 'x']);
    expect(bunTestArguments(parsed, 'a.test.ts'))
      .toEqual(['test', '--max-concurrency=1', '--timeout=30000', '--pass-with-no-tests', '-t', 'x', './a.test.ts']);
  });
});

describe('discoverTestFiles', () => {
  test('finds the file set bun test finds, sorted, and nothing under node_modules or hidden directories', async () => {
    const root = await fixture({
      'b/__tests__/two.test.ts': '',
      'a/__tests__/one.test.ts': '',
      'a/__tests__/one.scenario.ts': '',
      'a/__tests__/helper.ts': '',
      'c/x_test.js': '',
      'c/y.spec.tsx': '',
      'c/z_spec.mjs': '',
      'node_modules/pkg/dep.test.ts': '',
      '.worktrees/other/copy.test.ts': '',
      'c/readme.test.md': '',
    });

    expect(await discoverTestFiles(root, [])).toEqual([
      'a/__tests__/one.test.ts',
      'b/__tests__/two.test.ts',
      'c/x_test.js',
      'c/y.spec.tsx',
      'c/z_spec.mjs',
    ]);
    expect(await discoverTestFiles(root, ['two', 'spec'])).toEqual([
      'b/__tests__/two.test.ts',
      'c/y.spec.tsx',
      'c/z_spec.mjs',
    ]);
  });

  test('covers this repository, including itself', async () => {
    const files = await discoverTestFiles(repositoryRoot, []);
    expect(files).toContain('scripts/__tests__/run-tests.test.ts');
    expect(files.length).toBeGreaterThan(200);
    expect(files.every((file) => !file.includes('node_modules'))).toBe(true);
  });
});

describe('the repository test command', () => {
  test('goes through the per-file runner, so a hang names its file', async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['test']).toBe('bun scripts/run-tests.ts --timeout 30000');
    expect(manifest.scripts['test:e2e']).toStartWith('bun scripts/run-tests.ts --timeout 30000 ');
  });
});

describe('run-tests.ts', () => {
  test('importing the module installs nothing in the importing process', async () => {
    // The signal handlers belong to the entry point. This module is also imported for its pure
    // functions -- this file does exactly that, above -- and an import that quietly installs a
    // `process.exit` handler on SIGINT/SIGTERM changes the behaviour of whoever imported it.
    const script = [
      `await import(${JSON.stringify(runnerPath)});`,
      "process.stdout.write(JSON.stringify(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))));",
    ].join('\n');
    const result = runScenario('bun', ['-e', script], { cwd: repositoryRoot, timeoutMs: 60_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([0, 0]);
  }, 90_000);

  test('names and kills a file that never finishes, keeps going, and fails the run', async () => {
    const root = await fixture({
      // A synchronous spin cannot be interrupted by bun's own per-test timeout: exactly the class of
      // hang that used to hold a CI leg until the job limit.
      'a/__tests__/hang.test.ts': "import { test } from 'bun:test';\ntest('spins', () => { for (;;) {} });\n",
      'b/__tests__/pass.test.ts': "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
    });

    const started = Date.now();
    const result = runScenario('bun', [runnerPath, '--timeout', '1000', '--file-timeout', '3000'], {
      cwd: root,
      timeoutMs: 60_000,
    });

    expect(Date.now() - started).toBeLessThan(45_000);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('[run-tests] start 1/2 a/__tests__/hang.test.ts');
    expect(result.stdout).toContain('[run-tests] HUNG a/__tests__/hang.test.ts: no exit within 3000ms, killed');
    expect(result.stdout).toMatch(/\[run-tests\] end 2\/2 b\/__tests__\/pass\.test\.ts exit=0 \d+\.\d+s/);
    expect(result.stdout).toContain('[run-tests] 1 of 2 files failed:\n  a/__tests__/hang.test.ts (hung)');
  }, 90_000);

  test('passes when every file passes, and reports a failing file by name', async () => {
    const root = await fixture({
      'a/__tests__/pass.test.ts': "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
      'b/__tests__/fail.test.ts': "import { expect, test } from 'bun:test';\ntest('fails', () => { expect(1).toBe(2); });\n",
    });

    const passing = runScenario('bun', [runnerPath, 'pass'], { cwd: root, timeoutMs: 60_000 });
    expect(passing.status, passing.stdout + passing.stderr).toBe(0);
    expect(passing.stdout).toContain('[run-tests] 1 files passed');

    const failing = runScenario('bun', [runnerPath], { cwd: root, timeoutMs: 60_000 });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('[run-tests] 1 of 2 files failed:\n  b/__tests__/fail.test.ts (exit 1)');
  }, 90_000);

  test('stops on its own when the whole-run budget is spent, and says what it never measured', async () => {
    // The failure this exists for: the win32 leg reached ci.yml's `timeout-minutes` and GitHub
    // *cancelled* the job. `continue-on-error` absorbs a job that failed, not one that was
    // cancelled, so every CI run on the repository reported `cancelled` however green the four
    // deciding legs were. A run that ends itself fails normally, which is absorbed -- and unlike a
    // platform kill, it still gets to say what it did and did not measure.
    const root = await fixture({
      'a/__tests__/slow.test.ts':
        "import { test } from 'bun:test';\ntest('spins', () => { for (;;) {} });\n",
      'b/__tests__/pass.test.ts':
        "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
    });

    const started = Date.now();
    const result = runScenario('bun', [runnerPath, '--timeout', '1000', '--file-timeout', '30000', '--budget', '6000'], {
      cwd: root,
      timeoutMs: 60_000,
    });

    // The point of the budget: back inside its own bound, not at the file bound behind it.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('[run-tests] BUDGET stopped a/__tests__/slow.test.ts');
    // The file that outran the clock is not slandered as a hang: it never got the wall clock a
    // hang is judged against.
    expect(result.stdout).not.toContain('HUNG');
    expect(result.stdout).toContain('2 of 2 files not measured, from a/__tests__/slow.test.ts');
    expect(result.stdout).not.toContain('files passed');
  }, 90_000);

  test('runs to completion when the budget is never reached, and stays silent about it', async () => {
    const root = await fixture({
      'a/__tests__/pass.test.ts':
        "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
    });

    const result = runScenario('bun', [runnerPath, '--budget', '120000'], { cwd: root, timeoutMs: 60_000 });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('[run-tests] 1 files passed');
    expect(result.stdout).not.toContain('BUDGET');
  }, 90_000);

  test('fails instead of passing vacuously when a pattern matches no file', async () => {
    const root = await fixture({ 'a/__tests__/pass.test.ts': '' });
    const result = runScenario('bun', [runnerPath, 'nothing-like-this'], { cwd: root, timeoutMs: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no test files match');
  }, 90_000);
});
