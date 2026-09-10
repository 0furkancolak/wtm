import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDarwinProcessPlatform, selectPlatformRuntime, type ObservedProcessIdentity } from '@wtm/platform';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { fixtureIpcAddress } from '../../../testkit/src/ipc-address';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { DaemonClient } from '../../../cli/src/client';
import { runCli } from '../../../cli/src/main';
import { createProductionDaemon } from '../runtime-factory';

const fixture = await createWorkspaceFixture();
const socketDirectory = await mkdtemp(join(shortTmpRoot(), 'wtm-socket-'));
const useDefaultClient = process.argv[2] === 'default-client';
const closeWithLiveTask = process.argv[2] === 'close-live';
const runtimeInvocation = developmentRuntimeInvocation();
// Failure-only evidence from the actual observations used by the supervisor. A second ps
// after a failure cannot explain an earlier identity mismatch. Keep argv and environment out.
const trace: Record<string, unknown>[] = [];
let expected: ObservedProcessIdentity | undefined;
let firstMismatch: Record<string, unknown> | undefined;
function record(entry: Record<string, unknown>): void {
  trace.push({ at: Date.now(), ...entry });
  if (trace.length > 16) trace.shift();
}
const selected = selectPlatformRuntime();
const execFileAsync = promisify(execFile);
const nativeProcess = selected.id === 'darwin' ? createDarwinProcessPlatform({
  runCommand: async (file, args, options) => {
    const started = performance.now();
    const result = await execFileAsync(file, [...args], options);
    if (args.includes('command=')) {
      const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const row = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+?)\s*$/.exec(lines[0] ?? '');
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      record({ operation: 'ps-identity', pid: args[2], durationMs: performance.now() - started,
        lineCount: lines.length, ...(row === null ? {} : {
          pgid: row[1], state: row[2], start: row[3],
          commHash: digest(row[4]!), commandHash: digest(row[5]!), commandBytes: Buffer.byteLength(row[5]!),
        }) });
    }
    return result;
  },
}) : selected.process;
const platformRuntime = { ...selected, process: {
  ...nativeProcess,
  inspectProcess: async (pid: number) => {
    const started = performance.now();
    const result = await nativeProcess.inspectProcess(pid);
    const entry = { operation: 'inspect', pid, durationMs: performance.now() - started, result };
    record(entry);
    if (expected?.pid === pid && result.status === 'present'
      && (result.identity.pgid !== expected.pgid || result.identity.processStartTime !== expected.processStartTime
        || result.identity.commandFingerprint !== expected.commandFingerprint)) firstMismatch ??= { ...entry, preceding: [...trace] };
    return result;
  },
  inspectProcessGroup: async (pgid: number) => {
    const started = performance.now();
    const result = await nativeProcess.inspectProcessGroup(pgid);
    record({ operation: 'group', pgid, durationMs: performance.now() - started,
      result: result.status === 'present' ? { ...result, pids: result.pids.slice(0, 64), count: result.pids.length } : result });
    return result;
  },
  signalProcessGroup: (pgid: number, signal: NodeJS.Signals) => {
    record({ operation: 'signal', pgid, signal, phase: 'before' });
    try { nativeProcess.signalProcessGroup(pgid, signal); record({ operation: 'signal', pgid, signal, phase: 'sent' }); }
    catch (error) { record({ operation: 'signal', pgid, signal, phase: 'failed', code: errorCode(error) }); throw error; }
  },
} };
const runtime = await createProductionDaemon(useDefaultClient ? {
  platformRuntime,
  gracePeriodMs: 100,
  pollIntervalMs: 10,
  runtimeInvocation,
} : {
  platformRuntime,
  dataRoot: join(fixture.userDataDir, 'production'),
  socketPath: fixtureIpcAddress(socketDirectory),
  logRoot: join(fixture.userDataDir, 'logs'),
  gracePeriodMs: 100,
  pollIntervalMs: 10,
  runtimeInvocation,
});
const client = new DaemonClient({ socketPath: runtime.paths.socketPath });
try {
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '[tasks.hold]',
    closeWithLiveTask
      ? 'run = ["/bin/sleep", "30"]'
      : 'run = ["node", "-e", "setInterval(() => {}, 1000)"]',
    'background = true',
    'singleton = true',
  ].join('\n'));
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'fixture', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: identity.commonGitDir,
    mainRoot: fixture.firstRepoPath,
    remoteIdentity: null,
  });
  runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  await runtime.start();
  if (!useDefaultClient) await client.start();

  const start = await invoke(['start', 'hold', '--json']);
  if (!start.envelope.ok) throw new Error(JSON.stringify({ stage: 'start', ...start, trace }));
  const processRecord = start.envelope.data.process;
  expected = { pid: processRecord.pid, pgid: processRecord.pgid,
    processStartTime: processRecord.processStartTime, commandFingerprint: processRecord.commandFingerprint };
  if (closeWithLiveTask) {
    await runtime.close();
    const processRecord = start.envelope.data.process;
    console.log(JSON.stringify({
      startExit: start.exitCode,
      startState: processRecord.state,
      identity: {
        pid: processRecord.pid,
        pgid: processRecord.pgid,
        processStartTime: processRecord.processStartTime,
        commandFingerprint: processRecord.commandFingerprint,
      },
    }));
  } else {
    const ps = await invoke(['ps', '--json']);
    if (ps.exitCode !== 0 || ps.envelope.ok !== true) {
      throw new Error(JSON.stringify({ stage: 'ps', ...ps }));
    }
    const stop = await invoke(['stop', 'hold', '--json']);
    if (stop.exitCode !== 0 || stop.envelope.ok !== true) {
      const terminal = runtime.stateStore.getManagedProcess(processRecord.id);
      const completion = await runtime.logs.readCompletion(processRecord.stdoutPath, processRecord.pid)
        .catch((error: unknown) => ({ inspectionFailed: errorCode(error) }));
      throw new Error(JSON.stringify({ stage: 'stop', ...stop, expected, firstMismatch, trace,
        terminal: terminal === null ? null : { state: terminal.state, stoppedAt: terminal.stoppedAt }, completion }));
    }
    console.log(JSON.stringify({
      startExit: start.exitCode,
      startState: start.envelope.data.process.state,
      psRunning: ps.envelope.data.processes.some((process: { taskName: string; state: string }) =>
        process.taskName === 'hold' && process.state === 'RUNNING'),
      stopExit: stop.exitCode,
      stopState: stop.envelope.data.processes[0].state,
      // Reported only by the default-client run, because that is the only one whose socket is
      // derived rather than handed in — the others would be reading back their own argument. The
      // parent checks every disk root is confined and the IPC address matches the isolated
      // production derivation. Windows pipes are names, not entries beneath a home directory.
      ...(useDefaultClient ? { socketPath: runtime.paths.socketPath, paths: runtime.paths } : {}),
    }));
  }
} finally {
  await client.close();
  await runtime.close();
  await rm(socketDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNCLASSIFIED';
}

async function invoke(argv: string[]) {
  let stdout = '';
  const exitCode = await runCli(argv, {
    cwd: fixture.firstRepoPath,
    ...(useDefaultClient ? {} : { runtimeClient: client }),
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  return { exitCode, envelope: JSON.parse(stdout) };
}
