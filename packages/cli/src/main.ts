import { Command, CommanderError, Option } from 'commander';
import type { JsonEnvelope, WtmErrorCode } from '@wtm/protocol';
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

export interface CliDependencies {
  dataSource?: DiagnosticDataSource;
  cwd?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
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

  return program;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  let exitCode = 0;
  const jsonRequested = hasOptionIntent(argv, '--json');
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const program = createCli({
    ...dependencies,
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
  }
}

function addScopeOptions(command: Command): void {
  command
    .addOption(new Option('--json', 'emit the stable JSON envelope'))
    .addOption(new Option('--global', 'aggregate registered workspaces only'));
}

function exitCodeForEnvelope(envelope: JsonEnvelope<unknown>): number {
  if (envelope.ok) return 0;
  return envelope.errors.reduce((code, error) => Math.max(code, exitCodeForError(error.code)), 1);
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
    || code === 'GC_ACTIVE_WORKTREE_PROTECTED'
  ) return 3;
  return 1;
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
