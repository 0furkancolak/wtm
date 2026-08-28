import { Command, CommanderError, Option } from 'commander';
import { constants } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonEnvelope, WtmErrorCode } from '@wtm/protocol';
import {
  createLaunchdLifecycle,
  createProductionDaemon,
  defaultProductionRuntimePaths,
  type LaunchdLifecycle,
} from '@wtm/daemon';
import {
  emptyDiagnosticDataSource,
  runDoctorCommand,
  runEnvCommand,
  runExplainCommand,
  runPlanCommand,
  runPortsCommand,
  runStatusCommand,
  type DiagnosticCommandInput,
  type DiagnosticDataSource,
} from './diagnostics';
import { renderEnvelope } from './output';
import { runStartCommand } from './commands/start';
import { runStopCommand } from './commands/stop';
import { runRestartCommand } from './commands/restart';
import { runPsCommand } from './commands/ps';
import { followLogs, runLogsCommand } from './commands/logs';
import { runExecCommand, type ForegroundExecutor } from './commands/exec';
import type { RuntimeDaemonClient } from './commands/runtime-client';
import { DaemonClient } from './client';
import {
  runDaemonLifecycleCommand,
  serveDaemon,
  type DaemonSignalSource,
  type ForegroundDaemonRuntime,
} from './commands/daemon';
import { runProductionDiskCommand, runProductionGcCommand } from './commands/resource-production';

export interface CliDependencies {
  dataSource?: DiagnosticDataSource;
  cwd?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  runtimeClient?: RuntimeDaemonClient;
  execForeground?: ForegroundExecutor;
  signal?: AbortSignal;
  daemonLifecycle?: LaunchdLifecycle;
  daemonRuntimeFactory?: () => Promise<ForegroundDaemonRuntime>;
  daemonSignals?: DaemonSignalSource;
  daemonProgramArguments?: readonly string[];
  diskRunner?: (input: { cwd: string }) => Promise<JsonEnvelope<unknown>>;
  gcRunner?: (input: { cwd: string; apply: boolean }) => Promise<JsonEnvelope<unknown>>;
  resourceDatabasePath?: string;
}

interface CliHooks {
  setExitCode?: (value: number) => void;
}

interface ScopeOptions {
  json?: boolean;
  global?: boolean;
}

type DiagnosticRunner = (
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
) => Promise<JsonEnvelope<unknown>>;

const commands: ReadonlyArray<[string, string, DiagnosticRunner]> = [
  ['status', 'Show resolved identity, state, endpoints, processes, and resources.', runStatusCommand],
  ['doctor', 'Run deterministic workspace diagnostics.', runDoctorCommand],
  ['explain', 'Explain resolved choices and provenance.', runExplainCommand],
  ['plan', 'Show desired declarative changes without applying them.', runPlanCommand],
  ['env', 'Show the resolved environment delta.', runEnvCommand],
  ['ports', 'Show endpoint leases.', runPortsCommand],
];

export function createCli(dependencies: CliDependencies = {}, hooks: CliHooks = {}): Command {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const followStdout = dependencies.stdout ?? writeStdoutWithBackpressure;
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const source = dependencies.dataSource ?? emptyDiagnosticDataSource;
  const cwd = dependencies.cwd ?? process.cwd();
  const program = new Command()
    .name('wtm')
    .description('Worktree Runtime Manager')
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });
  addScopeOptions(program);

  for (const [name, description, runner] of commands) {
    const command = program.command(`${name} [selector]`).description(description);
    addScopeOptions(command);
    command.action(async (selector: string | undefined, options: ScopeOptions) => {
      const rootOptions = program.opts<ScopeOptions>();
      const json = options.json === true || rootOptions.json === true;
      const global = options.global === true || rootOptions.global === true;
      const envelope = await runner({
        cwd,
        ...(selector === undefined ? {} : { selector }),
        ...(global ? { global: true } : {}),
      }, source);
      stdout(`${renderEnvelope(envelope, { json })}\n`);
      hooks.setExitCode?.(exitCodeForEnvelope(envelope));
    });
  }

  const renderRuntime = (envelope: JsonEnvelope<unknown>, json: boolean) => {
    stdout(`${renderEnvelope(envelope, { json })}\n`);
    hooks.setExitCode?.(exitCodeForEnvelope(envelope));
  };

  const start = program.command('start <task>').description('Start a managed background task.');
  addJsonOption(start);
  start.action(async (taskName: string, options: ScopeOptions) => {
    renderRuntime(await runStartCommand({ cwd, taskName }, dependencies.runtimeClient), runtimeJson(program, options));
  });

  const stop = program.command('stop [task]').description('Stop one or all managed tasks.');
  addJsonOption(stop);
  stop.action(async (taskName: string | undefined, options: ScopeOptions) => {
    renderRuntime(await runStopCommand({ cwd, ...(taskName === undefined ? {} : { taskName }) }, dependencies.runtimeClient), runtimeJson(program, options));
  });

  const restart = program.command('restart <task>').description('Safely stop and restart a managed task.');
  addJsonOption(restart);
  restart.action(async (taskName: string, options: ScopeOptions) => {
    renderRuntime(await runRestartCommand({ cwd, taskName }, dependencies.runtimeClient), runtimeJson(program, options));
  });

  const ps = program.command('ps').description('List WTM-managed process groups.');
  addJsonOption(ps);
  ps.action(async (options: ScopeOptions) => {
    renderRuntime(await runPsCommand({ cwd }, dependencies.runtimeClient), runtimeJson(program, options));
  });

  const logs = program.command('logs [task]').description('Read managed task logs.');
  addJsonOption(logs);
  logs.option('--follow', 'follow logs as a raw stream');
  logs.action(async (taskName: string | undefined, options: ScopeOptions & { follow?: boolean }) => {
    const input = { cwd, ...(taskName === undefined ? {} : { taskName }) };
    if (options.follow === true) {
      const result = await followLogs(input, followStdout, dependencies.runtimeClient, dependencies.signal);
      if (result.failure !== undefined) renderRuntime(result.failure, runtimeJson(program, options));
      else hooks.setExitCode?.(result.exitCode);
      return;
    }
    renderRuntime(await runLogsCommand(input, dependencies.runtimeClient), runtimeJson(program, options));
  });

  const exec = program.command('exec <argv...>').description('Execute raw argv in the foreground.');
  addJsonOption(exec);
  exec.action(async (argv: string[], options: ScopeOptions) => {
    renderRuntime(
      await runExecCommand({ cwd, argv }, dependencies.runtimeClient, dependencies.execForeground),
      runtimeJson(program, options),
    );
  });

  const daemon = program.command('daemon').description('Manage the per-user WTM daemon.');
  for (const action of ['install', 'uninstall', 'status'] as const) {
    const lifecycle = daemon.command(action).description(`${capitalize(action)} the per-user WTM LaunchAgent.`);
    addJsonOption(lifecycle);
    lifecycle.action(async (options: ScopeOptions) => {
      const manager = dependencies.daemonLifecycle ?? createLaunchdLifecycle({
        programArguments: dependencies.daemonProgramArguments ?? defaultDaemonProgramArguments(),
      });
      renderRuntime(await runDaemonLifecycleCommand(action, manager), runtimeJson(program, options));
    });
  }
  const serve = daemon.command('serve').description('Run the WTM daemon in the foreground.');
  addJsonOption(serve);
  serve.action(async (options: ScopeOptions) => {
    const result = await serveDaemon({
      runtimeFactory: dependencies.daemonRuntimeFactory ?? createProductionDaemon,
      ...(dependencies.daemonSignals === undefined ? {} : { signals: dependencies.daemonSignals }),
    });
    renderRuntime(result.envelope, runtimeJson(program, options));
    hooks.setExitCode?.(result.exitCode);
  });

  const disk = program.command('disk').description('Report logical and allocated WTM resource usage.');
  addJsonOption(disk);
  disk.action(async (options: ScopeOptions) => {
    const envelope = dependencies.diskRunner === undefined
      ? await runProductionDiskCommand({
        databasePath: dependencies.resourceDatabasePath ?? defaultProductionRuntimePaths().databasePath,
        cwd,
      })
      : await dependencies.diskRunner({ cwd });
    renderRuntime(envelope, runtimeJson(program, options));
  });

  const gc = program.command('gc').description('Plan or apply safe WTM resource garbage collection.');
  addJsonOption(gc);
  gc
    .addOption(new Option('--apply', 'apply the guarded GC plan').conflicts('dryRun'))
    .addOption(new Option('--dry-run', 'plan only (the default)').conflicts('apply'));
  gc.action(async (options: ScopeOptions & { apply?: boolean; dryRun?: boolean }) => {
    const apply = options.apply === true;
    const envelope = dependencies.gcRunner === undefined
      ? await runProductionGcCommand({
        databasePath: dependencies.resourceDatabasePath ?? defaultProductionRuntimePaths().databasePath,
        cwd,
        apply,
      })
      : await dependencies.gcRunner({ cwd, apply });
    renderRuntime(envelope, runtimeJson(program, options));
  });

  return program;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  let exitCode = 0;
  const jsonRequested = hasOptionIntent(argv, '--json');
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const defaultClient = dependencies.runtimeClient === undefined && isRuntimeInvocation(argv)
    ? new DaemonClient({ socketPath: defaultDaemonSocketPath() })
    : null;
  const cancellation = dependencies.signal === undefined && isFollowInvocation(argv)
    ? new AbortController()
    : null;
  const onInterrupt = () => cancellation?.abort();
  if (cancellation !== null) process.once('SIGINT', onInterrupt);
  if (defaultClient !== null) await defaultClient.start().catch(() => {});
  const program = createCli({
    ...dependencies,
    ...(defaultClient === null ? {} : { runtimeClient: defaultClient }),
    ...(cancellation === null ? {} : { signal: cancellation.signal }),
    ...(jsonRequested ? { stderr: () => {} } : {}),
  }, { setExitCode: (value) => { exitCode = value; } });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (jsonRequested) stdout(`${JSON.stringify(usageFailureEnvelope(argv, error.code))}\n`);
      return 2;
    }
    throw error;
  } finally {
    if (cancellation !== null) process.off('SIGINT', onInterrupt);
    await defaultClient?.close();
  }
}

function isFollowInvocation(argv: readonly string[]): boolean {
  const boundary = argv.indexOf('--');
  const commandArguments = boundary < 0 ? argv : argv.slice(0, boundary);
  return commandArguments.includes('logs') && commandArguments.includes('--follow');
}

function addScopeOptions(command: Command): void {
  command
    .addOption(new Option('--json', 'emit the stable JSON envelope'))
    .addOption(new Option('--global', 'aggregate registered workspaces only'));
}

function addJsonOption(command: Command): void {
  command.addOption(new Option('--json', 'emit the stable JSON envelope'));
}

function runtimeJson(program: Command, options: ScopeOptions): boolean {
  return options.json === true || program.opts<ScopeOptions>().json === true;
}

function exitCodeForEnvelope(envelope: JsonEnvelope<unknown>): number {
  if (envelope.ok) return 0;
  if (envelope.command === 'exec') {
    const context = envelope.errors[0]?.context;
    const signal = context?.signal;
    if (typeof signal === 'string' && Object.hasOwn(constants.signals, signal)) {
      return 128 + constants.signals[signal as keyof typeof constants.signals];
    }
    const exitCode = context?.exitCode;
    if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
      return exitCode;
    }
  }
  return envelope.errors.reduce((code, error) => Math.max(code, exitCodeForError(error.code)), 1);
}

export function defaultDaemonSocketPath(home = homedir()): string {
  return join(home, 'Library', 'Application Support', 'WTM', 'wtmd.sock');
}

function isRuntimeInvocation(argv: readonly string[]): boolean {
  const command = argv.find((argument) => !argument.startsWith('-'));
  return command !== undefined && ['start', 'stop', 'restart', 'ps', 'logs', 'exec'].includes(command);
}

function exitCodeForError(code: WtmErrorCode): number {
  if (code === 'WTM_DAEMON_UNAVAILABLE') return 4;
  if (code === 'ADAPTER_PROTOCOL_INCOMPATIBLE' || code === 'ADAPTER_INVALID_RESPONSE') return 5;
  if (code === 'WTM_CONFIG_INVALID' || code === 'WTM_WORKSPACE_NOT_FOUND' || code === 'WTM_NOT_INITIALIZED') return 2;
  if (
    code === 'GIT_MAIN_WORKTREE'
    || code === 'GIT_WORKTREE_LOCKED'
    || code === 'GIT_DIRTY_STAGED'
    || code === 'GIT_DIRTY_UNSTAGED'
    || code === 'GIT_UNTRACKED'
    || code === 'GIT_UNMERGED'
    || code === 'GIT_HEAD_NOT_REMOTE_PERSISTED'
    || code === 'RESOURCE_PATH_DENIED'
    || code === 'GC_ACTIVE_WORKTREE_PROTECTED'
  ) return 3;
  return 1;
}

function defaultDaemonProgramArguments(): readonly string[] {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('WTM CLI entry path is unavailable');
  return [resolve(process.execPath), resolve(entry), 'daemon', 'serve'];
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function usageFailureEnvelope(argv: readonly string[], commanderCode: string): JsonEnvelope<null> {
  const command = argv.find((argument) => !argument.startsWith('-')) ?? 'wtm';
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope: { mode: hasOptionIntent(argv, '--global') ? 'global' : 'local' },
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_CONFIG_INVALID',
      message: 'Invalid command-line usage.',
      severity: 'error',
      context: { commanderCode },
    }],
  };
}

function hasOptionIntent(argv: readonly string[], option: string): boolean {
  for (const argument of argv) {
    if (argument === '--') return false;
    if (argument === option) return true;
  }
  return false;
}

async function writeStdoutWithBackpressure(value: string): Promise<void> {
  if (process.stdout.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.stdout.off('drain', onDrain);
      process.stdout.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Standard output stream failed')); };
    process.stdout.once('drain', onDrain);
    process.stdout.once('error', onError);
  });
}
