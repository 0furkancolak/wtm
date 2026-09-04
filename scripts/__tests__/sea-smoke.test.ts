import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPlatformRuntime } from '../../packages/platform/src/select';
import { createFakeAdapter, type FakeAdapter } from '../../packages/testkit/src/fake-adapter';
import { isolatedHomeEnvironment } from '../../packages/testkit/src/isolated-home';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../../packages/core/src/plan/adapter-trust';
import { invokeExternalAdapter } from '../../packages/core/src/plan/external-adapter';
import { ManagedLogStore } from '../../packages/daemon/src/logs';
import { ManagedProcessSupervisor } from '../../packages/daemon/src/process-supervisor';
import { MemoryManagedProcessStore } from '../../packages/testkit/src/managed-process-store';
import { seaAssetKeys } from '../build-sea';

const windows = process.platform === 'win32';
const root = fileURLToPath(new URL('../..', import.meta.url));
// `build-sea.ts` keeps the `.exe` extension Windows requires the copied runtime to carry.
const executable = join(root, `dist/sea/wtm${windows ? '.exe' : ''}`);
/**
 * A standalone installation may not have Node, Bun, or any developer tooling on PATH.
 *
 * The Windows list is not the POSIX list translated: it names the directories the standalone
 * executable itself needs on `PATH` to shell out to `powershell.exe` (trust/ACL, named pipes) and
 * `taskkill.exe`/`schtasks.exe` (process and service supervision) — the Windows analogue of
 * `/usr/bin`+`/bin` carrying `sh`, `ps`, and the other tools the POSIX backends shell out to.
 */
const systemPath = windows
  ? [
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
    process.env.SystemRoot ?? 'C:\\Windows',
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0`,
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\Wbem`,
  ].join(';')
  : '/usr/bin:/bin:/usr/sbin:/sbin';
const runtimeInvocation = { executable, prefixArgs: [] as readonly string[] };
const cleanups: Array<() => Promise<void>> = [];
const adapters: FakeAdapter[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.cleanup()));
});

async function isolatedHome(): Promise<{ home: string; repository: string; temporary: string }> {
  // Every supported platform caps Unix socket paths — 104 bytes on macOS, 108 on Linux — and the
  // daemon's address is built under the home, so the home has to be short on either of them.
  // macOS caps a Unix socket address at 104 bytes and the daemon's socket lives under `home`, so
  // POSIX keeps the shortest possible root (`/tmp`) rather than `os.tmpdir()`'s real, much longer
  // per-user directory (e.g. `/var/folders/.../T`) — swapping it in here silently overflowed that
  // limit and hung the daemon at bind. Windows has no such path-length-derived socket limit (its
  // pipe address is a fixed-length hash, independent of `home`) and has no `/tmp`, so it alone uses
  // `os.tmpdir()`.
  const home = await mkdtemp(windows ? join(tmpdir(), 'wtm-sea-') : '/tmp/wtm-sea-');
  await chmod(home, 0o700);
  const repository = join(home, 'repository');
  const temporary = join(home, 'tmp');
  await mkdir(repository, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  // macOS resolves /tmp through a symlink to /private/tmp and WTM reports real paths, so the
  // fixture has to report them too. On Linux /tmp is a real directory and this resolves to itself.
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }); });
  return { home, repository: realpathSync(repository), temporary };
}

/**
 * The environment every standalone child runs under.
 *
 * Deliberately built rather than inherited: `systemPath` is the whole point of the smoke test, and
 * `isolatedHomeEnvironment` is what makes the home an actual confinement instead of only a `HOME`
 * — on Linux an ambient `XDG_RUNTIME_DIR` would otherwise send the daemon's socket to the
 * runner's `/run/user/<uid>` and out of the directory this fixture deletes.
 */
function standaloneEnvironment(options: { home: string; temporary: string }): Record<string, string> {
  return {
    PATH: systemPath,
    ...isolatedHomeEnvironment(options.home),
    TMPDIR: options.temporary,
    LC_ALL: 'C',
    LANG: 'C',
  };
}

function runStandalone(
  args: readonly string[],
  options: { cwd: string; home: string; temporary: string },
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: standaloneEnvironment(options),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(cwd: string, args: readonly string[]): void {
  // Resolved through PATH rather than a hardcoded absolute path: there is no `/usr/bin/git` on
  // Windows, and this call inherits the full test-runner environment (no `env` override), so PATH
  // already has whatever `git` the CI image installed — the same trust `quick-start.test.ts`
  // already places in a bare `git`.
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function initializedWorkspace() {
  const paths = await isolatedHome();
  git(paths.repository, ['init', '-q', '-b', 'main', '.']);
  git(paths.repository, ['config', 'user.email', 'smoke@example.invalid']);
  git(paths.repository, ['config', 'user.name', 'WTM Smoke']);
  await writeFile(join(paths.repository, 'README.md'), 'standalone\n');
  git(paths.repository, ['add', '-A']);
  git(paths.repository, ['commit', '-qm', 'init']);
  return paths;
}

// `bun run binary:verify` builds the executable first; the default suite has nothing to check.
function spawnDaemon(options: { cwd: string; home: string; temporary: string }): ChildProcess {
  const daemon = spawn(executable, ['daemon', 'serve'], {
    cwd: options.cwd,
    stdio: 'ignore',
    env: standaloneEnvironment(options),
  });
  cleanups.push(async () => {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => { daemon.once('exit', resolve); });
  });
  return daemon;
}

async function waitForDaemon(options: { cwd: string; home: string; temporary: string }): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (runStandalone(['ps', '--json'], options).status === 0) return;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error('the standalone daemon did not accept requests');
}

describe.skipIf(!existsSync(executable))('standalone executable', () => {
  test('reports its branded version and help without any runtime on PATH', async () => {
    const paths = await isolatedHome();

    const version = runStandalone(['--version'], { cwd: paths.home, ...paths });
    const help = runStandalone(['--help'], { cwd: paths.home, ...paths });

    expect(version.status).toBe(0);
    expect(version.stdout).not.toContain('Powered by https://nafru.com');
    expect(version.stdout.split('\n')[0])
      .toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Powered by https://nafru.com');
    expect(help.stdout).not.toContain('__wtm_internal');
  });

  test('initializes a workspace on embedded migrations and reads it back', async () => {
    const paths = await initializedWorkspace();
    const options = { cwd: paths.repository, home: paths.home, temporary: paths.temporary };

    const init = runStandalone(['init', '--yes', '--json'], options);
    const analyze = runStandalone(['analyze', '--global', '--json'], options);

    expect(init.status, init.stderr || init.stdout).toBe(0);
    const initialized = JSON.parse(init.stdout);
    expect(initialized.ok).toBe(true);
    expect(initialized.data.workspace.root).toBe(paths.repository);
    // A second process reads the same persistent database through the embedded schema.
    expect(analyze.status, analyze.stderr || analyze.stdout).toBe(0);
    expect(JSON.parse(analyze.stdout).ok).toBe(true);
    // Derived, not spelled: this test exercises the host, so `~/Library/Application Support` is a
    // macOS answer to the question rather than the question. The executable resolved its own data
    // root from the same policy and the same environment, so reading it back through
    // `selectPlatformRuntime` asserts the two agree instead of asserting one platform's layout.
    const dataRoot = selectPlatformRuntime({
      home: paths.home,
      env: isolatedHomeEnvironment(paths.home),
    }).paths.dataRoot;
    expect(statSync(join(dataRoot, 'state.db')).isFile()).toBe(true);
  });

  test('prints the embedded canonical agent skill', async () => {
    const paths = await isolatedHome();

    const printed = runStandalone(['skill', 'print'], { cwd: paths.home, ...paths });

    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(readFileSync(join(root, 'skills/wtm/SKILL.md'), 'utf8'));
  });

  test('rejects its private modes without leaking detail and never lists them', async () => {
    const paths = await isolatedHome();
    const options = { cwd: paths.home, ...paths };

    expect(runStandalone(['__wtm_internal_anchor'], options).status).toBe(2);
    expect(runStandalone(['__wtm_internal_anchor', 'not-a-marker'], options).status).toBe(2);
    expect(runStandalone(['__wtm_internal_adapter', '2', 'adapter.mjs'], options).status).toBe(2);
  });

  test('owns a managed task through its own process anchor', async () => {
    const paths = await isolatedHome();
    const commands = join(paths.home, 'commands');
    await mkdir(commands, { mode: 0o700 });
    // `ping`, not a shell built-in or `node`, so this keeps working under `standaloneEnvironment`'s
    // point — a `PATH` with no dev tooling on it — the same way `/bin/sleep` does on POSIX.
    const fixtureTaskFile = windows ? 'fixture-task.cmd' : 'fixture-task';
    await writeFile(
      join(commands, fixtureTaskFile),
      windows ? '@ping -n 31 127.0.0.1 >nul\r\n' : '#!/bin/sh\nexec /bin/sleep 30\n',
    );
    if (!windows) await chmod(join(commands, fixtureTaskFile), 0o700);
    const store = new MemoryManagedProcessStore();
    const supervisor = new ManagedProcessSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(paths.home, 'logs') }),
      pollIntervalMs: 10,
      runtimeInvocation,
    });
    cleanups.push(async () => { await supervisor.close(); });

    const started = await supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'fixture',
      argv: [fixtureTaskFile],
      cwd: paths.home,
      env: { PATH: `${commands}${delimiter}${systemPath}` },
    });

    expect(started.record.state).toBe('RUNNING');
    expect((await supervisor.stop({ worktreeId: 'worktree-1', taskName: 'fixture' })).state).toBe('STOPPED');
    expect(readdirSync(paths.temporary).filter((entry) => entry.endsWith('.node'))).toEqual([]);
  });

  test('serves its daemon and owns a configured task end to end', async () => {
    const paths = await initializedWorkspace();
    const options = { cwd: paths.repository, home: paths.home, temporary: paths.temporary };
    await writeFile(join(paths.repository, 'wtm.toml'), [
      'version = 1',
      '',
      '[workspace]',
      'name = "smoke"',
      '',
      '[tasks.hold]',
      'description = "Hold a process for the standalone smoke test."',
      // A plain argv array, not a shell command line — so the Windows substitute has to be one
      // real executable plus arguments, not `sleep`-with-redirection. `ping` ships with every
      // Windows install and, unlike `timeout.exe`, does not refuse a redirected/non-console stdin,
      // which is exactly the stdio this task's supervised child runs under.
      windows ? 'run = ["ping", "-n", "31", "127.0.0.1"]' : 'run = ["/bin/sleep", "30"]',
      'cwd = "{worktree.root}"',
      '',
    ].join('\n'));
    expect(runStandalone(['init', '--yes', '--json'], options).status).toBe(0);

    const daemon = spawnDaemon(options);
    await waitForDaemon(options);

    const started = JSON.parse(runStandalone(['start', 'hold', '--json'], options).stdout);
    const listed = JSON.parse(runStandalone(['ps', '--json'], options).stdout);
    const stopped = JSON.parse(runStandalone(['stop', 'hold', '--json'], options).stdout);

    expect(started.data.process.state).toBe('RUNNING');
    expect(listed.data.processes.map((entry: { taskName: string }) => entry.taskName)).toContain('hold');
    expect(stopped.data.processes[0].state).toBe('STOPPED');
    expect(daemon.exitCode).toBeNull();
  });

  test('runs a trusted external adapter through its own guarded child', async () => {
    const response = {
      protocol: { major: 1 as const, minor: 0 },
      adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom' as const, provides: [] },
    };
    const adapter = await createFakeAdapter({ type: 'response', response });
    adapters.push(adapter);
    const trust = createAdapterTrustStore();
    await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });

    await expect(invokeExternalAdapter({
      adapterId: 'fake',
      executablePath: adapter.executablePath,
      repositoryRoot: adapter.root,
      operation: 'metadata',
      trust,
      runtimeInvocation,
    })).resolves.toEqual(response);
  });

  test('ships a stripped runtime', () => {
    // The pinned Node version fixes the runtime size, so the bound only moves when a build
    // regresses — or when reviewed new functionality lands. Raised 2026-09-03 (Increment D1,
    // the Windows trust-and-transport seam) after the added FileTrustPolicy/Windows-backend
    // code pushed the Linux SEA binary to 110,037,760 bytes, just over the previous 110MB bound;
    // the darwin arm64 binary measured on this host stayed at 97,667,584 bytes. Raised with
    // headroom rather than nudged to the exact new size, so the next small, legitimate addition
    // does not immediately retrip it.
    expect(statSync(executable).size).toBeLessThan(115_000_000);
  });

  test('embeds its assets instead of shipping a native SQLite addon', () => {
    const binary = readFileSync(executable);

    for (const key of seaAssetKeys) expect(binary.includes(Buffer.from(key))).toBe(true);
    expect(binary.includes(Buffer.from('better_sqlite3.node'))).toBe(false);
    expect(binary.includes(Buffer.from('node_modules/bindings'))).toBe(false);
    // The npm driver is replaced at bundle time, so its only trace is the loud stub.
    expect(binary.includes(Buffer.from('stores state through node:sqlite'))).toBe(true);
  });
});
