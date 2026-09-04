import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { constants as fsConstants, existsSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { access } from 'node:fs/promises';
import { constants, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';
import { exitCodeForError } from './exit-codes';
import {
  DaemonSocketPathTooLongError,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import { selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import type { AdapterTrustStore } from '@wtm/core';
import {
  containsPath,
  GitCommandError,
  listGitWorktrees,
  refreshRemoteTrackingRefs,
  resolveWorkspaceConfig,
  SQLiteStateStore,
  type TaskResolutionInput,
} from '@wtm/core';
import type { GitWorktreeRecord } from '@wtm/core';
import {
  DaemonRegistrationError,
  branchName,
  createProductionDaemon,
  defaultProductionRuntimePaths,
  findRegistration,
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
} from '@wtm/daemon';
import { createServiceLifecycle } from '@wtm/daemon/service-lifecycle';
import type { ServiceLifecycle } from '@wtm/daemon/service-lifecycle';
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
import { runRemoveCommand, type RemovalRuntimeBinding } from './commands/remove';
import { createProductionRemovalCoordinator } from './removal-coordinator';
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
  daemonLifecycle?: ServiceLifecycle;
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
  /** The global configuration layer a removal's ephemeral resource cleanup resolves against. */
  removalGlobalConfigPath?: string;
  diagnosticsDatabasePath?: string;
  /** The daemon socket to reach, for tests that need a path this host does not have. */
  daemonSocketPath?: string;
  resolveRunner?: (input: { cwd: string; taskName: string }) => Promise<JsonEnvelope<unknown>>;
  analyzeRunner?: (input: { repoPath: string; selector?: string; refreshRemotes?: boolean }) => Promise<JsonEnvelope<unknown>>;
  removeRunner?: (input: { repoPath: string; selector: string; refreshRemotes?: boolean; resume?: boolean }) => Promise<JsonEnvelope<unknown>>;
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
  analyze.option('--refresh-remotes', refreshRemotesDescription);
  analyze.action(async (selector: string | undefined, options: ScopeOptions & { all?: boolean; cleanupCandidates?: boolean; refreshRemotes?: boolean }) => {
    const json = runtimeJson(program, options);
    const refreshRemotes = options.refreshRemotes === true;
    const input = {
      repoPath: cwd,
      ...(selector === undefined ? {} : { selector }),
      ...(refreshRemotes ? { refreshRemotes } : {}),
    };
    const envelope = dependencies.analyzeRunner === undefined
      ? await runProductionAnalyze({
        cwd,
        ...(selector === undefined ? {} : { selector }),
        global: options.global === true || program.opts<ScopeOptions>().global === true,
        all: options.all === true,
        cleanupCandidates: options.cleanupCandidates === true,
        refreshRemotes,
        ...(json ? {} : { notify: humanNotice }),
        databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      })
      : await dependencies.analyzeRunner(input);
    renderRuntime(envelope, json);
  });

  const remove = program.command('remove <selector>').description('Safely remove one linked worktree.');
  addJsonOption(remove);
  remove.option('--refresh-remotes', refreshRemotesDescription);
  remove.option('--resume', resumeDescription);
  remove.action(async (selector: string, options: ScopeOptions & { refreshRemotes?: boolean; resume?: boolean }) => {
    const json = runtimeJson(program, options);
    const refreshRemotes = options.refreshRemotes === true;
    const resume = options.resume === true;
    const input = {
      repoPath: cwd,
      selector,
      ...(refreshRemotes ? { refreshRemotes } : {}),
      ...(resume ? { resume } : {}),
    };
    const envelope = dependencies.removeRunner === undefined
      ? await runProductionRemove({
        cwd,
        selector,
        refreshRemotes,
        resume,
        ...(json ? {} : { notify: humanNotice }),
        databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
        globalConfigPath: dependencies.removalGlobalConfigPath ?? defaultProductionRuntimePaths().globalConfigPath,
        ...(dependencies.runtimeClient === undefined ? {} : { client: dependencies.runtimeClient }),
      })
      : await dependencies.removeRunner(input);
    renderRuntime(envelope, json);
  });

  const renderRuntime = (envelope: JsonEnvelope<unknown>, json: boolean) => {
    stdout(`${renderEnvelope(envelope, { json })}\n`);
    hooks.setExitCode?.(exitCodeForEnvelope(envelope));
  };

  /**
   * Prose that stands beside the envelope rather than inside it. The refreshed remote names are
   * something the person who typed the flag is owed; the envelope is a compatibility contract, so
   * a new key there would be the wrong place to put them — and it is suppressed under `--json`,
   * where stdout must parse as exactly one envelope.
   */
  const humanNotice: CommandNotifier = (message) => stdout(`${message}\n`);

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
    // Not "LaunchAgent". The subcommand is driven by whichever service manager the selected
    // platform names — launchd on macOS, systemd on Linux — and `wtm doctor`'s `platform` check
    // reports that by name, so a help text that says LaunchAgent contradicts a diagnostic the same
    // binary prints. The wording is deliberately the neutral one rather than a per-platform string:
    // help output is rendered before a platform has been selected, and a description that had to
    // ask the host which OS it is would be a second place that decides.
    const lifecycle = daemon.command(action)
      .description(`${capitalize(action)} the per-user WTM daemon service.`);
    addJsonOption(lifecycle);
    lifecycle.action(async (options: ScopeOptions) => {
      // Built from the *selected* backend, not from launchd.
      //
      // `createLaunchdLifecycle` hard-wires `darwinServiceBackend`, so while it was called here the
      // Linux service backend was unreachable from the CLI entirely: `wtm daemon install` on Linux
      // would have driven launchd's argument vectors against a host that has no `launchctl`. That
      // is the failure this increment's opening section names — code that looks like Linux support,
      // passes a thousand tests, and does not start — and it is pure wiring, so it is decidable
      // here rather than on a kernel.
      //
      // `env` is left to default to the process environment, because the Linux backend's paths are
      // XDG-derived and reading `{}` would put its unit in the wrong directory. macOS ignores it.
      const manager = dependencies.daemonLifecycle ?? createServiceLifecycle({
        backend: hostPlatformRuntime().service,
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
  init.option('--ai-skill', 'also install the local Agent Skill, as `wtm skill install` does');
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
      installAiSkill: options.aiSkill === true,
      detect: options.detect !== false,
      acceptDefaults: options.yes === true,
      aiSkillInstaller: installer,
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });
    if (envelope.ok) await announceRegistration(dependencies.runtimeClient);
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

/**
 * How the refreshed remote names reach a human without entering the JSON envelope, which is a
 * compatibility contract and additive only.
 */
type CommandNotifier = (message: string) => void;

const refreshRemotesDescription = 'refresh remote-tracking refs first (network access)';

const resumeDescription = 'continue a removal whose process died, adopting its abandoned lease';

/**
 * Refreshes each distinct repository exactly once, before any analysis runs.
 *
 * The aggregate modes analyze many worktrees that share one repository, and a refresh hung off the
 * per-worktree analysis would multiply one honest fetch round by the number of worktrees — ten
 * repositories of ten worktrees would send a hundred. Keying the work by repository path is what
 * keeps the cost proportional to what is actually being refreshed.
 */
async function refreshRepositories(
  repoPaths: readonly string[],
  command: 'analyze' | 'remove',
  notify: CommandNotifier | undefined,
): Promise<{ refreshedAt: Map<string, string> } | { error: WtmError }> {
  const refreshedAt = new Map<string, string>();
  const remotes = new Set<string>();
  for (const repoPath of new Set(repoPaths)) {
    try {
      const result = await refreshRemoteTrackingRefs(repoPath);
      refreshedAt.set(repoPath, result.refreshedAt);
      for (const remote of result.remotes) remotes.add(remote);
    } catch (error) {
      // The user asked for fresh remote knowledge. Continuing on stale refs is the dangerous
      // outcome — it is what deletes work that only exists on a branch this repository last saw
      // a week ago — so a failed fetch fails the command instead of quietly downgrading it.
      return { error: toGitSafetyError(error, command) };
    }
  }
  notify?.(remotes.size === 0
    ? 'Refreshed remote-tracking refs: no configured remote matched the allowed remote-ref patterns.'
    : `Refreshed remote-tracking refs from ${[...remotes].sort().join(', ')}.`);
  return { refreshedAt };
}

async function runProductionAnalyze(input: {
  cwd: string;
  selector?: string;
  global: boolean;
  all: boolean;
  cleanupCandidates: boolean;
  refreshRemotes: boolean;
  notify?: CommandNotifier;
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
  let refreshedAt = new Map<string, string>();
  if (input.refreshRemotes) {
    const refresh = await refreshRepositories(selected.map(({ repoPath }) => repoPath), 'analyze', input.notify);
    if ('error' in refresh) return operationFailure('analyze', input.global, refresh.error);
    refreshedAt = refresh.refreshedAt;
  }
  const envelopes = await Promise.all(selected.map(({ repoPath, record }) => {
    const refreshed = refreshedAt.get(repoPath);
    return runAnalyzeCommand({
      repoPath,
      worktreePath: record.path,
      ...(refreshed === undefined ? {} : { remoteRefresh: { refreshedAt: refreshed } }),
    });
  }));
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
  refreshRemotes: boolean;
  resume: boolean;
  notify?: CommandNotifier;
  databasePath: string;
  globalConfigPath: string;
  client?: RuntimeDaemonClient;
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
  // One refresh for the one repository, before any selector is resolved and before analysis, so
  // that both selector spellings below reach `runRemoveCommand` with the same remote knowledge.
  const refresh = input.refreshRemotes
    ? await refreshRepositories([repositoryRoot], 'remove', input.notify)
    : { refreshedAt: new Map<string, string>() };
  if ('error' in refresh) return operationFailure('remove', false, refresh.error);
  const refreshed = refresh.refreshedAt.get(repositoryRoot);
  const remoteRefresh = refreshed === undefined ? {} : { remoteRefresh: { refreshedAt: refreshed } };
  // Read-write, because removal stops processes, releases endpoint leases and reconciles — all
  // of them writes. An absent file means nothing is registered on this machine, and a removal
  // must no more bring a state directory into being by asking than a read does.
  let store: SQLiteStateStore | null = null;
  try {
    if (existsSync(input.databasePath)) {
      try {
        store = new SQLiteStateStore(input.databasePath);
      } catch {
        return stateFailure('remove', false);
      }
    }
    let selector = input.selector;
    if (/^\d+$/.test(selector)) {
      // A number is a WTM identifier and nothing else, so with no state there is no question to
      // answer — "state is unavailable" is the honest reply, not "that worktree does not exist".
      if (store === null) return stateFailure('remove', false);
      let resolved: string | undefined;
      try {
        resolved = numericSelectorPath(store, input.cwd, selector);
      } catch {
        return stateFailure('remove', false);
      }
      if (resolved === undefined) {
        return operationFailure('remove', false, {
          code: 'WTM_WORKSPACE_NOT_FOUND',
          message: 'The worktree selector did not resolve to one worktree.',
          severity: 'error',
        });
      }
      selector = resolved;
    }
    const runtimeWarnings: WtmError[] = [];
    const envelope = await runRemoveCommand({
      repoPath: repositoryRoot,
      selector,
      ...remoteRefresh,
      bindRuntime: (worktreePath) => bindRemovalRuntime({
        store,
        worktreePath,
        globalConfigPath: input.globalConfigPath,
        adopt: input.resume,
        ...(input.client === undefined ? {} : { client: input.client }),
        warn: (warning) => runtimeWarnings.push(warning),
      }),
    });
    // The coordinator's own notes reach the caller through the envelope it never sees.
    return runtimeWarnings.length === 0
      ? envelope
      : { ...envelope, warnings: [...envelope.warnings, ...runtimeWarnings] };
  } finally {
    store?.close();
  }
}

function numericSelectorPath(
  store: SQLiteStateStore,
  cwd: string,
  selector: string,
): string | undefined {
  const repository = store.listRepositories().find(({ id }) =>
    store.listWorktrees(id).some(({ path }) => containsPath(path, cwd)));
  if (repository === undefined) return undefined;
  return store.listWorktrees(repository.id).find(({ numericId }) => numericId === Number(selector))?.path;
}

/**
 * The registration the runtime side of a removal acts through, or null when there is none.
 *
 * A worktree WTM has no record of has no managed processes, no endpoint leases and no resources
 * WTM materialized, so Git removal really is the whole job — but silence about that is
 * indistinguishable from cleanup having run and found nothing, so it says so instead.
 */
function bindRemovalRuntime(options: {
  store: SQLiteStateStore | null;
  worktreePath: string;
  globalConfigPath: string;
  adopt: boolean;
  client?: RuntimeDaemonClient;
  warn: (warning: WtmError) => void;
}): RemovalRuntimeBinding | null {
  const store = options.store;
  const worktree = store?.listWorktrees()
    .find(({ path }) => resolve(path) === resolve(options.worktreePath));
  if (store === null || worktree === undefined) {
    options.warn({
      code: 'WTM_WORKSPACE_NOT_FOUND',
      message: 'Runtime cleanup was skipped: this worktree is not registered with WTM, so it has '
        + 'no managed processes, endpoint leases or resources on record. Only Git removal ran.',
      severity: 'warning',
      context: { worktreePath: options.worktreePath },
    });
    return null;
  }
  return {
    repositoryId: worktree.repositoryId,
    worktreeId: worktree.id,
    coordinator: createProductionRemovalCoordinator({
      store,
      globalConfigPath: options.globalConfigPath,
      warn: options.warn,
      ...(options.client === undefined ? {} : { client: options.client }),
    }),
    leaseStore: store,
    /**
     * The platform reader the repository operation lease measures a colliding holder with.
     *
     * It is chosen here because the CLI is a composition root: `@wtm/core` states the question as
     * a port and refuses to answer it, so somebody has to choose, and the only correct place to
     * choose is the process entry point. It is the *selected* runtime rather than a hard-wired
     * macOS one, so a lease holder is measured with the reader for the operating system actually
     * running — `ps -o lstart=` on macOS, `/proc/<pid>/stat` on Linux — and the two identity
     * strings can never be confused for one another.
     */
    readProcessStartTime: (pid) => hostPlatformRuntime().process.readStartTime(pid),
    adopt: options.adopt,
  };
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
  let topology: GitWorktreeRecord[];
  try {
    topology = await listGitWorktrees(input.cwd);
  } catch (error) {
    throw workspaceRootNotRepositoryError(input.cwd, error);
  }
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

/**
 * Turns "`cwd` is not a Git repository" into `WTM_WORKSPACE_NOT_FOUND`, for exactly the layout
 * README's multi-repo example describes: a workspace root that holds several repositories as
 * subdirectories without being one itself. `git worktree list` fails that case with exit 128,
 * before it ever produces the porcelain output this function's caller wants, and its stderr is
 * git's own -- locale-dependent, so a Turkish install reports "ölümcül", never "fatal". Only the
 * exit code is read; nothing here branches on what git printed. Any other failure (a corrupted
 * repository, a timeout) is not this condition and is returned unchanged for the caller to throw.
 */
function workspaceRootNotRepositoryError(cwd: string, error: unknown): unknown {
  if (!(error instanceof GitCommandError) || error.exitCode !== 128) return error;
  const repositories = discoverableRepositories(cwd);
  const guidance = repositories.length === 0
    ? 'No Git repositories were found in its immediate subdirectories.'
    : `Repositories found here: ${repositories.join(', ')}.`;
  return new DaemonRegistrationError(
    `${cwd} is not a Git repository. This looks like a multi-repo workspace root; cd into one of `
    + `its repositories and run this command there. ${guidance}`,
    { cwd, discoveredRepositories: repositories },
  );
}

/**
 * The immediate subdirectories of `root` that are themselves Git repositories, so a person
 * standing in the wrong place is told where the right place is instead of just that this is not
 * it. Code-unit order rather than `localeCompare`, so the list this ships in a message is the
 * same on every machine regardless of the reader's locale -- the same discipline this function
 * exists to apply to the error itself.
 */
function discoverableRepositories(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, '.git')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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
  const socketPath = dependencies.daemonSocketPath ?? defaultDaemonSocketPath();
  // The connect side gets the same preflight the daemon's bind side gets. Without it a home
  // too deep for a socket address answered `WTM_DAEMON_UNAVAILABLE`, which sends the reader
  // to look for a daemon that is missing for a reason no amount of restarting will change.
  const socketPathMeasurement = measureDaemonSocketPath(socketPath, hostPlatformRuntime().socket.limitBytes);
  const socketPathRefusal = socketPathMeasurement.fits
    ? null
    : new DaemonSocketPathTooLongError(socketPathMeasurement);
  // A help invocation is not a runtime invocation. `wtm remove --help` was opening a socket to the
  // daemon in order to print static text, then discarding the failure — invisible in normal use,
  // but it made `refresh-remotes.test.ts` pass or fail according to whether the developer running
  // it happened to have a daemon up, and it would have been red on every CI runner regardless of
  // platform. Nothing downstream of `--help` can reach the daemon, so the connection had no reader
  // even when it succeeded.
  const wantsRuntimeClient = dependencies.runtimeClient === undefined
    && isRuntimeInvocation(argv)
    && !isHelpInvocation(argv);
  const defaultClient = wantsRuntimeClient && socketPathRefusal === null
    ? new DaemonClient({ socketPath })
    : null;
  const refusingClient: RuntimeDaemonClient | null = wantsRuntimeClient && socketPathRefusal !== null
    ? { request: (command) => Promise.resolve(socketPathRefusalEnvelope(command, socketPathRefusal)) }
    : null;
  const runtimeClient = defaultClient ?? refusingClient;
  const diagnosticStore = dependencies.dataSource === undefined && isDiagnosticInvocation(argv)
    ? openStateStore(dependencies.diagnosticsDatabasePath ?? defaultProductionRuntimePaths().databasePath)
    : null;
  if (diagnosticStore !== null) {
    // The fallback saves the reader a manual `wtm init`; it is never a precondition for
    // answering. Whatever it cannot do, the command still reports what the registry holds.
    await reconcileContainingRepository({
      store: diagnosticStore,
      cwd: dependencies.cwd ?? process.cwd(),
      // A path too long for an address cannot hold a daemon at all, so there is nothing to
      // probe: `socket-path` is the check that explains that one.
      socketPath: socketPathRefusal === null ? socketPath : null,
      // The warning stands beside the envelope, not inside it: a read command's stdout is one
      // envelope under `--json`, and the diagnostic envelope carries no warning channel.
      warn: (item) => {
        (dependencies.stderr ?? ((value: string) => { process.stderr.write(value); }))(
          `[${item.code}] ${item.message}\n`,
        );
      },
    }).catch(() => {});
  }
  const cancellation = dependencies.signal === undefined && isFollowInvocation(argv)
    ? new AbortController()
    : null;
  const onInterrupt = () => cancellation?.abort();
  if (cancellation !== null) process.once('SIGINT', onInterrupt);
  if (defaultClient !== null) await defaultClient.start().catch(() => {});
  const program = createCli({
    ...dependencies,
    ...(runtimeClient === null ? {} : { runtimeClient }),
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

function socketPathRefusalEnvelope(
  command: string,
  error: DaemonSocketPathTooLongError,
): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    data: null,
    warnings: [],
    errors: [{
      code: error.code,
      message: error.message,
      severity: error.severity,
      context: { command, ...error.context },
      remediation: [...error.remediation],
    }],
  };
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
/**
 * Tells a running daemon that the registrations have changed.
 *
 * The daemon builds both its reconcile list and its watchers from a snapshot taken when it
 * started, so a workspace registered afterwards was invisible: `git worktree add` in a
 * freshly initialised workspace discovered nothing, and `wtm status` inside the new worktree
 * answered about a different one, until the daemon happened to restart. Nothing about `init`
 * needs the daemon, so a daemon that is down or slow to answer is not an error here.
 */
async function announceRegistration(client: RuntimeDaemonClient | undefined): Promise<void> {
  if (client === undefined) return;
  try { await client.request('reconcile'); }
  catch { /* The registration is on disk; the next pass will find it. */ }
}

/**
 * Makes a worktree the registry has not heard of visible to a read command, without a second
 * `wtm init`.
 *
 * `git worktree add` writes nothing WTM owns, so a worktree created after `wtm init` exists in
 * Git and nowhere else until something reconciles its repository. The daemon does that — on
 * every start, and on every structural change it watches — and while it is running it is the
 * only writer the registry should have. With the daemon down there is nobody, and the read
 * commands answered about a directory they could not identify: `wtm status` reported the
 * workspace root as though the reader were standing in it, and `wtm env` failed outright. Both
 * then told the reader to run `wtm init` for a worktree WTM could have found itself, from one
 * `git worktree list`.
 *
 * The pass is the containing repository's, not the workspace's. `wtm init` walks five levels of
 * directory tree looking for repositories, which is the right price for registering a workspace
 * and far too much for reporting on one; listing the current repository's worktrees is a single
 * `git` call that names the whole topology at once.
 */
async function reconcileContainingRepository(input: {
  store: SQLiteStateStore;
  cwd: string;
  socketPath: string | null;
  warn: (item: WtmError) => void;
}): Promise<void> {
  if (isRegisteredDirectory(input.store, input.cwd)) return;
  // A daemon that is answering owns this: it reconciles the repository itself, and a second
  // writer working behind it is how two processes come to disagree about one registry.
  if (input.socketPath !== null && await daemonReachable(input.socketPath)) return;

  let topology: GitWorktreeRecord[];
  try {
    topology = await listGitWorktrees(input.cwd);
  } catch {
    // Not a repository, or one Git cannot read. There is nothing to reconcile, and a read
    // command run in an ordinary directory must not be made to talk about it.
    return;
  }
  const mainRoot = topology[0]?.path;
  const repository = mainRoot === undefined
    ? undefined
    : input.store.listRepositories().find((candidate) => candidate.mainRoot === mainRoot);
  // A repository nobody registered stays unregistered: discovering one is what `wtm init` is
  // for, and a read command must not enrol a clone the reader is only visiting.
  if (repository === undefined) return;

  try {
    input.store.reconcileWorktrees(repository.id, topology);
  } catch (error) {
    input.warn({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'The daemon is unreachable and the repository could not be reconciled either, '
        + `so this answer may be out of date: ${errorMessage(error)}`,
      severity: 'warning',
      context: { repositoryId: repository.id, cwd: input.cwd },
    });
    return;
  }
  // Silent when the pass changed nothing about this directory — `wtm status` in the workspace
  // root beside a repository is an ordinary thing to do, and has nothing to be told.
  if (!isRegisteredDirectory(input.store, input.cwd)) return;
  input.warn({
    code: 'WTM_DAEMON_UNAVAILABLE',
    message: 'The daemon is unreachable, so this repository was reconciled locally; the '
      + 'worktree you are in is registered now, and the daemon adopts it when it returns.',
    severity: 'warning',
    context: { repositoryId: repository.id, cwd: input.cwd },
  });
}

/**
 * Whether this directory is inside a worktree the registry holds.
 *
 * Deliberately the same lookup `doctor`'s `registration` check makes, so the fallback cannot
 * decide a directory is unregistered that the check then reports as registered, or the reverse.
 */
function isRegisteredDirectory(store: SQLiteStateStore, cwd: string): boolean {
  try {
    findRegistration(store, cwd);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The host WTM is running on, chosen once for the whole process.
 *
 * Memoized because it is asked for on every command and the answer cannot change while the
 * process lives; selected lazily rather than at module load because `selectPlatformRuntime`
 * *refuses* a host it has no backend for, and a refusal thrown during `import` would take down
 * `wtm --help` along with everything else.
 *
 * It deliberately has no fallback. A host WTM cannot name is reported as `WTM_PLATFORM_UNSUPPORTED`
 * — the coded refusal `UnsupportedPlatformError` carries — rather than quietly answered with
 * macOS's roots, which is what every call site replaced by this function used to do.
 */
let selectedHostPlatform: PlatformRuntime | null = null;
function hostPlatformRuntime(): PlatformRuntime {
  return (selectedHostPlatform ??= selectPlatformRuntime());
}

/**
 * Where this user's daemon publishes its socket.
 *
 * The root is the platform's: `~/Library/Application Support/WTM` on macOS, `$XDG_RUNTIME_DIR/wtm`
 * on Linux. `home` stays an argument so a caller can ask about a home that is not this process's,
 * which is how the macOS answer is pinned to the exact path every installed daemon is already
 * listening on.
 */
export function defaultDaemonSocketPath(home = homedir()): string {
  return publishedDaemonSocketPath(selectPlatformRuntime({ home }).paths.socketRoot);
}

/**
 * Which commands need the daemon.
 *
 * `init` is here not to be served by it but to tell it: a workspace registered while the
 * daemon is running is in no watcher, so nothing in it raises an event, so nothing ever
 * refreshes the registrations that would have added the watcher. Registering a workspace and
 * creating a worktree in it discovered nothing at all until the daemon happened to restart.
 */
function isRuntimeInvocation(argv: readonly string[]): boolean {
  const command = argv.find((argument) => !argument.startsWith('-'));
  // `remove` is here because stopping this worktree's managed processes is the daemon's job and
  // no other process may do it: the supervisor holds the child handle, the start reservation and
  // the identity quadruple its escalation ladder depends on.
  return command !== undefined && ['start', 'stop', 'restart', 'ps', 'logs', 'exec', 'init', 'remove'].includes(command);
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

function isHelpInvocation(argv: readonly string[]): boolean {
  return hasOptionIntent(argv, '--help') || hasOptionIntent(argv, '-h');
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
