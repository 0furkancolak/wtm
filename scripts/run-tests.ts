/**
 * Runs the test suite one file per `bun test` process, sequentially, under a wall-clock limit.
 *
 * Why not one `bun test` over everything: three macOS CI legs sat silent until the 30 minute job
 * limit inside a synchronous child spawn (`spawnSync`). Neither bun's per-test `--timeout` nor the
 * spawn's own `timeout`/`SIGKILL` deadline ended them, because both are enforced by the very thread
 * that was stuck. Only a process outside it can end such a hang, and only a per-file process can
 * say which file it was. This runner is that process:
 *
 * - the file set is the one `bun test` discovers (same name patterns, same exclusions), sorted;
 * - each file runs as `bun test --max-concurrency=1 --timeout=<same bound> ./file`, with its output
 *   passed straight through, so a file still gets bun's own report and CI annotations;
 * - each file is announced before it starts and after it ends, with its duration;
 * - a file that has not exited within `--file-timeout` is reported as hung by name and its whole
 *   process group is killed; the remaining files still run;
 * - any failing or hung file makes the run exit 1, and the summary lists them.
 *
 * Usage: bun scripts/run-tests.ts [--timeout ms] [--file-timeout ms] [bun test flags] [path patterns]
 * `--timeout` may repeat; the last one wins, which is what `bun run test --timeout N` relies on.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const defaultTestTimeoutMs = 30_000;

/** Five times the per-test bound, never under five minutes: the slowest honest file takes ~95 s. */
export function defaultFileTimeoutMs(testTimeoutMs: number): number {
  return Math.max(300_000, testTimeoutMs * 5);
}

export interface RunnerArguments {
  testTimeoutMs: number;
  fileTimeoutMs: number;
  /** Substrings a test file path must contain, like `bun test <patterns>`. */
  patterns: string[];
  /** Everything else, handed to each `bun test` unchanged. */
  forwarded: string[];
  /** A `-t` filter matches nothing in most files; those files must not count as failures. */
  nameFilter: boolean;
}

/** bun test flags that consume the following argument when not written as `--flag=value`. */
const valueFlags = new Set([
  '-t', '--test-name-pattern', '--rerun-each', '--retry', '--seed', '--coverage-reporter',
  '--coverage-dir', '--reporter', '--reporter-outfile', '--path-ignore-patterns', '--preload',
  '-r', '--max-concurrency', '--parallel', '--parallel-delay', '--shard', '--changed',
]);

export function parseRunnerArguments(argv: readonly string[]): RunnerArguments {
  let testTimeoutMs = defaultTestTimeoutMs;
  let fileTimeoutMs: number | undefined;
  const patterns: string[] = [];
  const forwarded: string[] = [];
  let nameFilter = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inline] = argument.startsWith('--') && argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined];
    if (flag === '--timeout' || flag === '--file-timeout') {
      const raw = inline ?? argv[(index += 1)];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${flag} needs a positive whole number of milliseconds, got ${JSON.stringify(raw)}`);
      }
      if (flag === '--timeout') testTimeoutMs = value;
      else fileTimeoutMs = value;
      continue;
    }
    if (flag === '-t' || flag === '--test-name-pattern') nameFilter = true;
    if (!argument.startsWith('-')) {
      patterns.push(argument);
      continue;
    }
    forwarded.push(argument);
    if (inline === undefined && valueFlags.has(flag)) {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      forwarded.push(value);
    }
  }
  return {
    testTimeoutMs,
    fileTimeoutMs: fileTimeoutMs ?? defaultFileTimeoutMs(testTimeoutMs),
    patterns,
    forwarded,
    nameFilter,
  };
}

export function bunTestArguments(parsed: RunnerArguments, file: string): string[] {
  return [
    'test',
    '--max-concurrency=1',
    `--timeout=${String(parsed.testTimeoutMs)}`,
    ...(parsed.nameFilter ? ['--pass-with-no-tests'] : []),
    ...parsed.forwarded,
    `./${file}`,
  ];
}

/** bun test's own discovery rule: `.test`, `_test`, `.spec` or `_spec` before a JS/TS extension. */
const testFileName = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Repository-relative, forward-slash paths, sorted, filtered by `patterns` (any may match). */
export async function discoverTestFiles(root: string, patterns: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  await collect(root, root, found);
  return found
    .filter((file) => patterns.length === 0 || patterns.some((pattern) => file.includes(pattern.replace(/^\.\//, ''))))
    .sort();
}

async function collect(root: string, directory: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(root, path, found);
    else if (entry.isFile() && testFileName.test(entry.name)) found.push(relative(root, path).split(sep).join('/'));
  }
}

type FileOutcome = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'hung' };

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 30_000 });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

function runFile(parsed: RunnerArguments, file: string): Promise<FileOutcome> {
  return new Promise((resolve) => {
    // stdio is inherited, never piped: a leaked grandchild holding a pipe open must not be able to
    // keep this runner waiting for an end-of-file, and the 'exit' event does not wait for one.
    const child = spawn(process.execPath, bunTestArguments(parsed, file), {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve({ kind: 'hung' });
    }, parsed.fileTimeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stderr.write(`[run-tests] could not start bun for ${file}: ${String(error)}\n`);
      resolve({ kind: 'exit', code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever the file left running in its process group dies with it, so it cannot
      // interfere with the files after it.
      if (process.platform !== 'win32') killTree(child);
      resolve({ kind: 'exit', code, signal });
    });
  });
}

async function main(): Promise<number> {
  let parsed: RunnerArguments;
  try {
    parsed = parseRunnerArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[run-tests] ${(error as Error).message}\n`);
    return 2;
  }
  const files = await discoverTestFiles(process.cwd(), parsed.patterns);
  if (files.length === 0) {
    process.stderr.write(`[run-tests] no test files match ${JSON.stringify(parsed.patterns)}\n`);
    return 1;
  }
  const failures: string[] = [];
  const runStarted = Date.now();
  for (const [index, file] of files.entries()) {
    const position = `${String(index + 1)}/${String(files.length)}`;
    process.stdout.write(`[run-tests] start ${position} ${file}\n`);
    const started = Date.now();
    const outcome = await runFile(parsed, file);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (outcome.kind === 'hung') {
      const message = `${file}: no exit within ${String(parsed.fileTimeoutMs)}ms, killed`;
      process.stdout.write(`[run-tests] HUNG ${message}\n`);
      if (process.env['GITHUB_ACTIONS'] === 'true') process.stdout.write(`::error title=Test file hung::${message}\n`);
      failures.push(`${file} (hung)`);
      continue;
    }
    const status = outcome.signal === null ? `exit=${String(outcome.code)}` : `signal=${outcome.signal}`;
    process.stdout.write(`[run-tests] end ${position} ${file} ${status} ${seconds}s\n`);
    if (outcome.code !== 0) {
      failures.push(`${file} (${outcome.signal === null ? `exit ${String(outcome.code)}` : outcome.signal})`);
    }
  }
  const total = ((Date.now() - runStarted) / 1000).toFixed(1);
  if (failures.length > 0) {
    process.stdout.write(
      `[run-tests] ${String(failures.length)} of ${String(files.length)} files failed:\n${failures.map((line) => `  ${line}`).join('\n')}\n`,
    );
    return 1;
  }
  process.stdout.write(`[run-tests] ${String(files.length)} files passed in ${total}s\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
