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
 * - `--parallel=1` is not forwarded because it has nothing left to say: it bounds how many test
 *   *files* bun runs at once, and this runner hands it exactly one;
 * - each file is announced before it starts and after it ends, with its duration;
 * - a file that has not exited within `--file-timeout` is reported as hung by name and its whole
 *   process group is killed; the remaining files still run;
 * - any failing or hung file makes the run exit 1, and the summary lists them.
 *
 * Two semantic differences from one `bun test` over everything, both accepted:
 * - isolation is stronger, not weaker. Each file gets its own module registry, its own globals and
 *   its own process, so a file can no longer be helped or harmed by what ran before it. A test
 *   that only passed because of a neighbour's leftover state now fails on its own merits;
 * - `--bail` bails that file, not the run. The remaining files still run, which is what makes a
 *   hung file survivable in the first place, and the summary still names everything that failed.
 *
 * Usage: bun scripts/run-tests.ts [--timeout ms] [--file-timeout ms] [bun test flags] [path patterns]
 * `--timeout` may repeat; the last one wins, which is what `bun run test --timeout N` relies on.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const defaultTestTimeoutMs = 30_000;

/** No file may hold the run longer than this, whatever the per-test bound is. */
export const fileTimeoutCeilingMs = 600_000;

/**
 * Five times the per-test bound, never under five minutes and never over ten.
 *
 * This is a hang detector, not a speed limit: the slowest honest file in this repository measures
 * an idle daemon for ~22 s and finishes well inside a minute. The ceiling is what makes the guard
 * real on the leg that needs it most -- win32 passes `--timeout 300000` for genuine per-call
 * PowerShell costs, and five times that is 25 minutes, exactly the cap `ci.yml` already puts on
 * that job. A guard that can only fire after the job has been killed is not a guard.
 */
export function defaultFileTimeoutMs(testTimeoutMs: number): number {
  return Math.min(Math.max(300_000, testTimeoutMs * 5), fileTimeoutCeilingMs);
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
  '-r', '--max-concurrency', '--parallel', '--parallel-delay', '--shard',
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
    // `timeout` alone sends SIGTERM and keeps waiting; the pair is what the guard requires of
    // every synchronous spawn in a test, and this runner obeys its own rule.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

/**
 * The file currently running, for the signal handlers below.
 *
 * Each child is spawned `detached`, into its own process group, so that a hang can be killed as a
 * group. The cost of that is the thing it buys: a SIGINT or SIGTERM delivered to *this* process's
 * group (Ctrl-C at a terminal, a cancelled CI job) no longer reaches the child, which under a
 * plain in-process `bun test` it did. The earlier hang logs show what that leaves behind -- the
 * runner reaping orphan `bun` processes after the job was cancelled -- so the runner forwards the
 * signal itself, to the whole group, and then leaves by it.
 */
let inFlight: ChildProcess | null = null;

/**
 * Installed by the entry point only. This module is also imported for its pure functions
 * (`parseRunnerArguments`, `discoverTestFiles`) by its own tests, and a module imported for those
 * has no business installing a `process.exit` handler in the importing process.
 */
function forwardTerminationSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (inFlight !== null) killTree(inFlight);
      process.stderr.write(`[run-tests] ${signal}, stopping\n`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

/** How long a killed group is given to actually die before the next file's output starts. */
const reapGraceMs = 10_000;

function runFile(parsed: RunnerArguments, file: string): Promise<FileOutcome> {
  return new Promise((resolve) => {
    // stdio is inherited, never piped: a leaked grandchild holding a pipe open must not be able to
    // keep this runner waiting for an end-of-file, and the 'exit' event does not wait for one.
    const child = spawn(process.execPath, bunTestArguments(parsed, file), {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    inFlight = child;
    let settled = false;
    const settle = (outcome: FileOutcome): void => {
      settled = true;
      // Only if this child is still the one in flight. A group that survives `SIGKILL` past the
      // reap grace -- uninterruptible I/O -- settles as hung, the loop starts the next file, and
      // this child's still-registered `exit` listener fires afterwards. Clearing the slot then
      // would disarm the signal forwarding for the file now running, exactly when things are
      // already going wrong.
      if (inFlight === child) inFlight = null;
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      // Waiting for the death it just ordered, rather than reporting over the top of it: on
      // inherited stdio a killed child's last bytes would otherwise land after the next file's
      // start line and blame the wrong file.
      const reap = setTimeout(() => { settle({ kind: 'hung' }); }, reapGraceMs);
      child.once('exit', () => { clearTimeout(reap); settle({ kind: 'hung' }); });
    }, parsed.fileTimeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      process.stderr.write(`[run-tests] could not start bun for ${file}: ${String(error)}\n`);
      settle({ kind: 'exit', code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      // Whatever the file left running in its process group dies with it, so it cannot
      // interfere with the files after it.
      //
      // This signals the group of a pid that has already been reaped, which on a busy machine the
      // kernel could in principle have recycled into an unrelated group. Deliberately kept: a
      // leaked child bleeding into the next file is the larger risk, and the observed one -- CI
      // reaped orphan `bun` processes after both hung legs. Do not "tidy" this away, and do not
      // narrow it to the hung path only; if it ever has to go, it goes together with `detached`.
      if (process.platform !== 'win32') killTree(child);
      settle({ kind: 'exit', code, signal });
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
  forwardTerminationSignals();
  process.exitCode = await main();
}
