import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { constants as fsConstants, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { access } from 'node:fs/promises';
import { constants, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';
import type { AdapterTrustStore } from '@wtm/core';
import {
  containsPath,
  listGitWorktrees,
  resolveWorkspaceConfig,
  SQLiteStateStore,
  type TaskResolutionInput,
} from '@wtm/core';
import type { GitWorktreeRecord } from '@wtm/core';
import {
  DaemonRegistrationError,
  branchName,
  createLaunchdLifecycle,
  createProductionDaemon,
  defaultProductionRuntimePaths,
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
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
  createDaemonErrorReporter,
  runDaemonLifecycleCommand,
  serveDaemon,
  type DaemonSignalSource,
  type ForegroundDaemonRuntime,
} from './commands/daemon';
import { runProductionDiskCommand, runProductionGcCommand } from './commands/resource-production';
import { runForgetCommand, type ForgetCommandEnvelope } from './commands/forget';
import { runAdapterCommand } from './commands/adapter';
import { runAnalyzeCommand } from './commands/analyze';
import { runRemoveCommand } from './commands/remove';
import { toGitSafetyError } from './commands/git-error';
import { runResolveCommand, toRuntimeCommandError } from './commands/resolve';
import { runRunCommand } from './commands/run';
import {
  runProductionInitCommand,
  type ProductionInitCommandInput,
} from './commands/init';
import { runDetectCommand, type DetectCommandInput } from './commands/detect';
import {
  createFilesystemSkillInstaller,
  readCanonicalSkill,
  runSkillInstallCommand,
  type SkillInstallResult,
  type SkillInstaller,
} from './commands/skill';
import { configureProductMetadata } from './product';
import { withAdapterTasks } from '@wtm/daemon/adapter-tasks';
import { createStateDiagnosticDataSource } from './state-diagnostics';

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
  runtimeInvocation?: RuntimeInvocation;
  diskRunner?: (input: { cwd: string }) => Promise<JsonEnvelope<unknown>>;
  gcRunner?: (input: { cwd: string; apply: boolean }) => Promise<JsonEnvelope<unknown>>;
  resourceDatabasePath?: string;
  adapterDatabasePath?: string;
  adapterTrustStore?: AdapterTrustStore;
  skillInstaller?: SkillInstaller;
  initRunner?: (input: ProductionInitCommandInput) => ReturnType<typeof runProductionInitCommand>;
  detectRunner?: (input: DetectCommandInput) => ReturnType<typeof runDetectCommand>;
  initDatabasePath?: string;
  initUserDataDir?: string;
  analysisDatabasePath?: string;
  diagnosticsDatabasePath?: string;
  resolveRunner?: (input: { cwd: string; taskName: string }) => Promise<JsonEnvelope<unknown>>;
  analyzeRunner?: (input: { repoPath: string; selector?: string }) => Promise<JsonEnvelope<unknown>>;
  removeRunner?: (input: { repoPath: string; selector: string }) => Promise<JsonEnvelope<unknown>>;
  forgetRunner?: (input: { cwd: string; selector?: string; force: boolean }) => Promise<JsonEnvelope<unknown>>;
}

export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
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
    // So that `wtm exec` can hand every remaining word to the command it runs.
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });
  configureProductMetadata(program);
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

  const resolveTaskCommand = program.command('resolve <task>').description('Resolve a task without running it.');
  addJsonOption(resolveTaskCommand);
  resolveTaskCommand.action(async (taskName: string, options: ScopeOptions) => {
    const envelope = dependencies.resolveRunner === undefined
      ? await runProductionResolve({ cwd, taskName })
      : await dependencies.resolveRunner({ cwd, taskName });
    renderRuntime(envelope, runtimeJson(program, options));
  });

  const runTaskCommand = program.command('run <task>').description('Run a configured task in the foreground.');
  addJsonOption(runTaskCommand);
  runTaskCommand.action(async (taskName: string, options: ScopeOptions) => {
    renderRuntime(await runProductionRun({ cwd, taskName }), runtimeJson(program, options));
  });

  const analyze = program.command('analyze [selector]').description('Analyze worktree removal safety.');
  addScopeOptions(analyze);
  analyze.option('--all', 'analyze every worktree in the current repository');
  analyze.option('--cleanup-candidates', 'analyze linked worktrees that may be cleanup candidates');
  analyze.action(async (selector: string | undefined, options: ScopeOptions & { all?: boolean; cleanupCandidates?: boolean }) => {
    const input = { repoPath: cwd, ...(selector === undefined ? {} : { selector }) };
    const envelope = dependencies.analyzeRunner === undefined
      ? await runProductionAnalyze({
        cwd,
        ...(selector === undefined ? {} : { selector }),
        global: options.global === true || program.opts<ScopeOptions>().global === true,
        all: options.all === true,
        cleanupCandidates: options.cleanupCandidates === true,
        databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      })
      : await dependencies.analyzeRunner(input);
    renderRuntime(envelope, runtimeJson(program, options));
  });

  const remove = program.command('remove <selector>').description('Safely remove one linked worktree.');
  addJsonOption(remove);
  remove.action(async (selector: string, options: ScopeOptions) => {
    const input = { repoPath: cwd, selector };
    const envelope = dependencies.removeRunner === undefined
      ? await runProductionRemove({
        cwd,
        selector,
        databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      })
      : await dependencies.removeRunner(input);
    renderRuntime(envelope, runtimeJson(program, options));
  });

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
  // Everything after the command word belongs to the command being run. Without this,
  // `wtm exec sh -c 'echo hi'` is refused for an unknown option `-c` that was never ours.
  exec.enablePositionalOptions().passThroughOptions().allowUnknownOption();
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
        programArguments: dependencies.daemonProgramArguments
          ?? daemonProgramArguments(dependencies.runtimeInvocation ?? defaultRuntimeInvocation()),
      });
      renderRuntime(
        await runDaemonLifecycleCommand(action, manager, () => daemonReachable(defaultDaemonSocketPath())),
        runtimeJson(program, options),
      );
    });
  }
  const serve = daemon.command('serve').description('Run the WTM daemon in the foreground.');
  addJsonOption(serve);
  serve.action(async (options: ScopeOptions) => {
    // One reporter for the whole daemon: startup failures and every error raised while it
    // runs land in the same log, which is the only place an unattended process can speak.
    const reportError = createDaemonErrorReporter();
    const result = await serveDaemon({
      reportError,
      runtimeFactory: dependencies.daemonRuntimeFactory
        ?? (() => createProductionDaemon({
          onError: reportError,
          runtimeInvocation: dependencies.runtimeInvocation ?? defaultRuntimeInvocation(),
        })),
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
        globalConfigPath: defaultProductionRuntimePaths().globalConfigPath,
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
        globalConfigPath: defaultProductionRuntimePaths().globalConfigPath,
        cwd,
        apply,
      })
      : await dependencies.gcRunner({ cwd, apply });
    renderRuntime(envelope, runtimeJson(program, options));
  });

  const forget = program
    .command('forget [selector]')
    .description('Retire a registration whose directory is gone: a workspace by name, or one repository by path.');
  addJsonOption(forget);
  forget.option('--force', 'retire a registration whose directory is still on disk');
  forget.action(async (selector: string | undefined, options: ScopeOptions & { force?: boolean }) => {
    const envelope = dependencies.forgetRunner === undefined
      ? await runProductionForget({
        cwd,
        ...(selector === undefined ? {} : { selector }),
        force: options.force === true,
        databasePath: dependencies.diagnosticsDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      })
      : await dependencies.forgetRunner({
        cwd,
        ...(selector === undefined ? {} : { selector }),
        force: options.force === true,
      });
    renderRuntime(envelope, runtimeJson(program, options));
    hooks.setExitCode?.(exitCodeForEnvelope(envelope));
  });

  const adapter = program.command('adapter').description('Manage trusted external adapters.');
  const adapterList = adapter.command('list').description('List trusted external adapters.');
  addJsonOption(adapterList);
  adapterList.action(async (options: ScopeOptions) => {
    renderRuntime(await runAdapterCommand({
      action: 'list',
      databasePath: dependencies.adapterDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      ...(dependencies.adapterTrustStore === undefined ? {} : { trust: dependencies.adapterTrustStore }),
    }), runtimeJson(program, options));
  });
  const adapterTrust = adapter.command('trust <adapter-id> <executable>').description('Trust an adapter executable by SHA-256.');
  addJsonOption(adapterTrust);
  adapterTrust.action(async (adapterId: string, executablePath: string, options: ScopeOptions) => {
    renderRuntime(await runAdapterCommand({
      action: 'trust',
      adapterId,
      executablePath,
      databasePath: dependencies.adapterDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      ...(dependencies.adapterTrustStore === undefined ? {} : { trust: dependencies.adapterTrustStore }),
    }), runtimeJson(program, options));
  });

  const init = program.command('init [path]').description('Initialize and register a WTM workspace.');
  addJsonOption(init);
  // `--global` selects a destination here, so it cannot borrow the read-scoping description.
  init.addOption(new Option('--global', 'register in user WTM data instead of wtm.toml'));
  init.option('--yes', 'accept non-destructive proposed defaults');
  init.option('--max-depth <n>', 'maximum discovery depth', parseNonNegativeInteger);
  init.option('--no-ai-skill', 'skip local Agent Skill installation');
  init.option('--no-detect', 'write only a name and a version, reading no repository');
  init.action(async (path: string | undefined, options: ScopeOptions & {
    yes?: boolean;
    maxDepth?: number;
    aiSkill?: boolean;
    detect?: boolean;
  }) => {
    const global = options.global === true || program.opts<ScopeOptions>().global === true;
    const databasePath = dependencies.initDatabasePath ?? defaultProductionRuntimePaths().databasePath;
    const userDataDir = dependencies.initUserDataDir ?? dirname(databasePath);
    const installer = dependencies.skillInstaller ?? defaultPortableSkillInstaller(cwd);
    const envelope = await (dependencies.initRunner ?? runProductionInitCommand)({
      root: resolve(cwd, path ?? '.'),
      userDataDir,
      databasePath,
      globalOnly: global,
      installAiSkill: options.aiSkill !== false,
      detect: options.detect !== false,
      acceptDefaults: options.yes === true,
      aiSkillInstaller: installer,
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });
    renderRuntime(envelope, runtimeJson(program, options));
  });

  const detect = program
    .command('detect [path]')
    .description('Read the repositories for the ports, allowlists, and service addresses they declare.');
  addJsonOption(detect);
  detect.option('--write', 'append the tables wtm.toml does not have yet');
  detect.option('--max-depth <n>', 'maximum discovery depth', parseNonNegativeInteger);
  detect.action(async (path: string | undefined, options: ScopeOptions & {
    write?: boolean;
    maxDepth?: number;
  }) => {
    // Without a path, `detect` answers for the workspace the current directory belongs to,
    // like every other command. Reading the current directory as if it were the workspace
    // root reported one repository of several, and called tables missing that the workspace's
    // own `wtm.toml` had already decided.
    const root = path === undefined ? await findWorkspaceRoot(cwd) ?? cwd : resolve(cwd, path);
    renderRuntime(await (dependencies.detectRunner ?? runDetectCommand)({
      root,
      ...(options.write === undefined ? {} : { write: options.write }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    }), runtimeJson(program, options));
  });

  const skill = program.command('skill').description('Print or install the WTM Agent Skill.');
  skill.command('print').description('Print the canonical WTM Agent Skill.').action(async () => {
    stdout(await readCanonicalSkill());
  });
  const skillInstall = skill.command('install').description('Install the canonical WTM Agent Skill.');
  addJsonOption(skillInstall);
  skillInstall.addOption(new Option('--global', 'install into ~/.agents/skills instead of the current workspace'));
  skillInstall.action(async (options: ScopeOptions) => {
    const global = options.global === true || program.opts<ScopeOptions>().global === true;
    const mode = global ? 'global' as const : 'local' as const;
    let envelope: JsonEnvelope<SkillInstallResult | null>;
    try {
      const result = await runSkillInstallCommand({
        scope: mode,
        installer: dependencies.skillInstaller ?? defaultPortableSkillInstaller(cwd),
      });
      envelope = {
        schemaVersion: 1,
        ok: true,
        command: 'skill install',
        scope: { mode },
        data: result,
        warnings: [],
        errors: [],
      };
    } catch {
      envelope = {
        schemaVersion: 1,
        ok: false,
        command: 'skill install',
        scope: { mode },
        data: null,
        warnings: [],
        errors: [{
          code: 'WTM_CONFIG_INVALID',
          message: 'WTM Agent Skill installation failed.',
          severity: 'error',
          context: { scope: mode },
        }],
      };
    }
    renderRuntime(envelope, runtimeJson(program, options));
  });

  return program;
}

function defaultPortableSkillInstaller(fallbackWorkspaceRoot: string): SkillInstaller {
  return {
    install(request) {
      return createFilesystemSkillInstaller({
        localAnchor: request.workspaceRoot ?? fallbackWorkspaceRoot,
        localSkills: join(request.workspaceRoot ?? fallbackWorkspaceRoot, '.agents', 'skills'),
        globalAnchor: homedir(),
        globalSkills: join(homedir(), '.agents', 'skills'),
      }).install(request);
    },
  };
}

async function runProductionAnalyze(input: {
  cwd: string;
  selector?: string;
  global: boolean;
  all: boolean;
  cleanupCandidates: boolean;
  databasePath: string;
}): Promise<JsonEnvelope<unknown>> {
  if (input.selector !== undefined && (input.global || input.all || input.cleanupCandidates)) {
    return analysisFailure(
      'WTM_CONFIG_INVALID', 'A selector cannot be combined with an aggregate analysis mode.', input.global,
    );
  }
  if ([input.global, input.all, input.cleanupCandidates].filter(Boolean).length > 1) {
    return analysisFailure('WTM_CONFIG_INVALID', 'Only one aggregate analysis mode may be selected.', input.global);
  }
  const selected: Array<{ repoPath: string; record: GitWorktreeRecord }> = [];
  let store: SQLiteStateStore | null = null;
  try {
    if (input.global || /^\d+$/.test(input.selector ?? '')) {
      try {
        store = new SQLiteStateStore(input.databasePath, { readonly: true });
      } catch {
        return stateFailure('analyze', input.global);
      }
    }
    if (input.global) {
      let repositories;
      try {
        repositories = store?.listRepositories() ?? [];
      } catch {
        return stateFailure('analyze', true);
      }
      for (const repository of repositories) {
        let topology: GitWorktreeRecord[];
        try {
          topology = await listGitWorktrees(repository.mainRoot);
        } catch (error) {
          return operationFailure('analyze', true, toGitSafetyError(error, 'analyze'));
        }
        for (const record of topology) selected.push({ repoPath: repository.mainRoot, record });
      }
    } else {
      let topology: GitWorktreeRecord[];
      try {
        topology = await listGitWorktrees(input.cwd);
      } catch (error) {
        return operationFailure('analyze', false, toGitSafetyError(error, 'analyze'));
      }
      const repositoryRoot = containingWorktreeRoot(topology, input.cwd);
      if (repositoryRoot === undefined) {
        return analysisFailure('WTM_WORKSPACE_NOT_FOUND', 'The current directory is not in a discovered worktree.', false);
      }
      if (input.all || input.cleanupCandidates) {
        for (const [index, record] of topology.entries()) {
          if (!input.cleanupCandidates || index > 0) selected.push({ repoPath: repositoryRoot, record });
        }
      } else {
        let record: GitWorktreeRecord | undefined;
        try {
          record = resolveAnalysisSelector(repositoryRoot, input.cwd, input.selector, topology, store);
        } catch {
          return stateFailure('analyze', false);
        }
        if (record !== undefined) selected.push({ repoPath: repositoryRoot, record });
      }
    }
  } finally {
    store?.close();
  }
  if (selected.length === 0) {
    return analysisFailure(
      'WTM_WORKSPACE_NOT_FOUND', 'The worktree selector did not resolve to one worktree.', input.global,
    );
  }
  const envelopes = await Promise.all(selected.map(({ repoPath, record }) => runAnalyzeCommand({
    repoPath,
    worktreePath: record.path,
  })));
  if (!input.global && !input.all && !input.cleanupCandidates) return envelopes[0] as JsonEnvelope<unknown>;
  const analyses = envelopes.flatMap(({ data }) => data === null ? [] : [data]);
  const errors = envelopes.flatMap(({ errors }) => errors);
  const common = {
    schemaVersion: 1 as const,
    command: 'analyze',
    scope: { mode: input.global ? 'global' as const : 'local' as const },
    data: { analyses },
    warnings: envelopes.flatMap(({ warnings }) => warnings),
  };
  return errors.length === 0
    ? { ...common, ok: true, errors: [] }
    : { ...common, ok: false, errors: [errors[0]!, ...errors.slice(1)] };
}

function resolveAnalysisSelector(
  repositoryRoot: string,
  cwd: string,
  selector: string | undefined,
  topology: readonly GitWorktreeRecord[],
  store: SQLiteStateStore | null,
): GitWorktreeRecord | undefined {
  if (selector === undefined) {
    const current = resolve(cwd);
    return topology.find(({ path }) => containsPath(path, current));
  }
  if (/^\d+$/.test(selector)) {
    const repository = store?.listRepositories().find(({ id }) =>
      store.listWorktrees(id).some(({ path }) => containsPath(path, cwd)));
    const registered = repository === undefined ? undefined : store?.listWorktrees(repository.id)
      .find(({ numericId }) => numericId === Number(selector));
    return topology.find(({ path }) => path === registered?.path);
  }
  const candidatePath = resolve(repositoryRoot, selector);
  const branchRef = selector.startsWith('refs/heads/') ? selector : `refs/heads/${selector}`;
  return topology.find(({ path, branch }) =>
    path === candidatePath || branch === selector || branch === branchRef);
}

async function runProductionRemove(input: {
  cwd: string;
  selector: string;
  databasePath: string;
}): Promise<JsonEnvelope<unknown>> {
  let topology: GitWorktreeRecord[];
  try {
    topology = await listGitWorktrees(input.cwd);
  } catch (error) {
    return operationFailure('remove', false, toGitSafetyError(error, 'remove'));
  }
  const repositoryRoot = containingWorktreeRoot(topology, input.cwd);
  if (repositoryRoot === undefined) {
    return operationFailure('remove', false, {
      code: 'WTM_WORKSPACE_NOT_FOUND',
      message: 'The current directory is not in a discovered worktree.',
      severity: 'error',
    });
  }
  if (!/^\d+$/.test(input.selector)) {
    return runRemoveCommand({ repoPath: repositoryRoot, selector: input.selector });
  }
  let store: SQLiteStateStore | null = null;
  try {
    store = new SQLiteStateStore(input.databasePath, { readonly: true });
    const repository = store.listRepositories().find(({ id }) =>
      store!.listWorktrees(id).some(({ path }) => containsPath(path, input.cwd)));
    const selected = repository === undefined
      ? undefined
      : store.listWorktrees(repository.id).find(({ numericId }) => numericId === Number(input.selector));
    if (selected === undefined) {
      return operationFailure('remove', false, {
        code: 'WTM_WORKSPACE_NOT_FOUND',
        message: 'The worktree selector did not resolve to one worktree.',
        severity: 'error',
      });
    }
    return runRemoveCommand({ repoPath: repositoryRoot, selector: selected.path });
  } catch {
    return stateFailure('remove', false);
  } finally {
    store?.close();
  }
}

function containingWorktreeRoot(topology: readonly GitWorktreeRecord[], cwd: string): string | undefined {
  return topology.filter(({ path }) => containsPath(path, cwd))
    .sort((left, right) => right.path.length - left.path.length)[0]?.path;
}

function analysisFailure(code: WtmErrorCode, message: string, global: boolean): JsonEnvelope<null> {
  return operationFailure('analyze', global, { code, message, severity: 'error' });
}

function stateFailure(command: 'analyze' | 'remove', global: boolean): JsonEnvelope<null> {
  return operationFailure(command, global, {
    code: 'WTM_NOT_INITIALIZED',
    message: 'WTM state is unavailable.',
    severity: 'error',
    context: { subsystem: 'state' },
  });
}

function operationFailure(
  command: 'analyze' | 'remove',
  global: boolean,
  error: WtmError,
): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope: { mode: global ? 'global' : 'local' },
    data: null,
    warnings: [],
    errors: [error],
  };
}

/** Retiring a registration is a write, so the state database is opened for one. */
async function runProductionForget(input: {
  cwd: string;
  selector?: string;
  force: boolean;
  databasePath: string;
}): Promise<ForgetCommandEnvelope> {
  if (!existsSync(input.databasePath)) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'forget',
      scope: { mode: 'local' },
      data: null,
      warnings: [],
      errors: [{ code: 'WTM_NOT_INITIALIZED', message: 'No WTM state is registered on this machine.', severity: 'error' }],
    };
  }
  const store = new SQLiteStateStore(input.databasePath);
  try {
    return await runForgetCommand({
      store,
      cwd: input.cwd,
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      force: input.force,
    });
  } finally {
    store.close();
  }
}

async function runProductionResolve(input: { cwd: string; taskName: string }): Promise<JsonEnvelope<unknown>> {
  try {
    return await runResolveCommand(await productionTaskResolution(input));
  } catch (error) {
    return resolutionFailure('resolve', input.taskName, error);
  }
}

async function runProductionRun(input: { cwd: string; taskName: string }): Promise<JsonEnvelope<unknown>> {
  try {
    return await runRunCommand(await productionTaskResolution({ ...input, prepare: true }));
  } catch (error) {
    return resolutionFailure('run', input.taskName, error);
  }
}

/**
 * Working out what a task is can fail before there is a task to report on — an endpoint range
 * with nothing free in it, a registry that cannot be read. Without this the failure escapes
 * the envelope entirely and a `--json` caller receives a bare line of prose.
 */
function resolutionFailure(
  command: 'resolve' | 'run',
  taskName: string,
  error: unknown,
): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [toRuntimeCommandError(error, command, taskName)],
  };
}

/**
 * `resolve` and `run` answer the same question; only one of them then executes the task, and
 * only that one may create the resources the task expects to find.
 */
async function productionTaskResolution(
  input: { cwd: string; taskName: string; prepare?: boolean },
  databasePath = defaultProductionRuntimePaths().databasePath,
): Promise<TaskResolutionInput & { workspaceId?: string }> {
  // The registry is what knows where the workspace root is, which in a directory holding
  // several repositories is nowhere near the current one. Resolving without it read the
  // wrong `wtm.toml` — or none — and answered differently from the supervised path.
  const store = openStateStore(databasePath);
  if (store !== null) {
    try {
      const runtime = await resolveWorktreeRuntime({
        store,
        cwd: input.cwd,
        globalConfigPath: defaultProductionRuntimePaths().globalConfigPath,
      });
      if (input.prepare === true) await prepareRuntimeResources(runtime);
      return {
        ...taskResolutionInput(runtime, input.taskName),
        workspaceId: runtime.registration.workspace.id,
      };
    } catch (error) {
      if (!(error instanceof DaemonRegistrationError)) throw error;
    } finally {
      store.close();
    }
  }
  return await unregisteredTaskResolution(input);
}

/**
 * Resolution for a repository WTM has not been asked to manage. Nothing is allocated and no
 * state is written, so `wtm resolve` still answers inside a clone someone is only visiting —
 * but the workspace root is still located by its `wtm.toml`, not assumed to be here.
 */
async function unregisteredTaskResolution(
  input: { cwd: string; taskName: string },
): Promise<TaskResolutionInput> {
  const topology = await listGitWorktrees(input.cwd);
  const worktree = topology.find(({ path }) => containsPath(path, input.cwd)) ?? topology[0];
  if (worktree === undefined) {
    return { config: {}, taskName: input.taskName, isMain: true, context: { env: process.env } };
  }
  const mainRoot = topology[0]?.path ?? worktree.path;
  const workspaceRoot = await findWorkspaceRoot(input.cwd) ?? worktree.path;
  const config = await resolveWorkspaceConfig({
    workspaceRoot,
    repoRoot: worktree.path,
    globalConfigPath: defaultProductionRuntimePaths().globalConfigPath,
  });
  const numericId = Math.max(1, topology.findIndex(({ path }) => path === worktree.path) + 1);
  const branch = branchName(worktree.branch);
  return {
    config: await withAdapterTasks(config.value, {
      workspace: { root: workspaceRoot },
      repository: { root: worktree.path, mainRoot },
      worktree: { root: worktree.path, id: numericId, branch: worktree.branch ?? null },
    }),
    taskName: input.taskName,
    isMain: worktree.path === topology[0]?.path,
    context: {
      workspace: { root: workspaceRoot, name: basename(workspaceRoot) },
      repo: { root: worktree.path, name: basename(mainRoot) },
      main: { root: mainRoot },
      worktree: { root: worktree.path },
      id: numericId,
      key: String(numericId),
      slug: basename(worktree.path),
      branch,
      branchSlug: branch.replace(/[^A-Za-z0-9._-]+/g, '-'),
      env: process.env,
    },
  };
}

/** The nearest enclosing directory holding a `wtm.toml`, which is what `wtm init` writes. */
async function findWorkspaceRoot(from: string): Promise<string | null> {
  let current = resolve(from);
  while (true) {
    if (await readable(join(current, 'wtm.toml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('max depth must be a non-negative integer');
  }
  return parsed;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  let exitCode = 0;
  const jsonRequested = hasOptionIntent(argv, '--json');
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const defaultClient = dependencies.runtimeClient === undefined && isRuntimeInvocation(argv)
    ? new DaemonClient({ socketPath: defaultDaemonSocketPath() })
    : null;
  const diagnosticStore = dependencies.dataSource === undefined && isDiagnosticInvocation(argv)
    ? openStateStore(dependencies.diagnosticsDatabasePath ?? defaultProductionRuntimePaths().databasePath)
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
    ...(diagnosticStore === null ? {} : {
      dataSource: createStateDiagnosticDataSource(diagnosticStore, {
        cwd: dependencies.cwd ?? process.cwd(),
        globalConfigPath: defaultProductionRuntimePaths().globalConfigPath,
      }),
    }),
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
    diagnosticStore?.close();
    await defaultClient?.close();
  }
}

function isDiagnosticInvocation(argv: readonly string[]): boolean {
  const command = argv.find((argument) => !argument.startsWith('-'));
  return command !== undefined && commands.some(([name]) => name === command);
}

/**
 * Opens the registry for writing, if it exists. Resolution allocates endpoints, so a
 * read-only handle would answer with the ports a worktree already has and fail for one that
 * has none yet. An absent file means nothing is registered, and a command that only reads
 * must not bring a state directory into being by asking.
 */
/** Whether anything is accepting on the daemon's socket right now. */
async function daemonReachable(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const socket = createConnection(socketPath);
    const finish = (reachable: boolean) => {
      socket.destroy();
      settle(reachable);
    };
    socket.once('connect', () => { finish(true); });
    socket.once('error', () => { finish(false); });
  });
}

function openStateStore(databasePath: string): SQLiteStateStore | null {
  if (!existsSync(databasePath)) return null;
  try {
    return new SQLiteStateStore(databasePath);
  } catch {
    // Unreadable, locked, or written by another user: the commands report nothing registered.
    return null;
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

export function defaultRuntimeInvocation(): RuntimeInvocation {
  // A standalone executable re-invokes itself; there is no separate entry script.
  if (process.getBuiltinModule?.('node:sea')?.isSea() === true) {
    return { executable: process.execPath, prefixArgs: [] };
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('WTM CLI entry path is unavailable');
  return { executable: resolve(process.execPath), prefixArgs: [resolve(entry)] };
}

export function daemonProgramArguments(invocation: RuntimeInvocation): readonly string[] {
  return [invocation.executable, ...invocation.prefixArgs, 'daemon', 'serve'];
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
