import { basename, dirname, join } from 'node:path';
import {
  ensurePrivateDirectory,
  initializeWorkspace,
  SQLiteStateStore,
  verifyPrivateDirectory,
  type InitInput,
  type InitResult,
  type StateStore,
} from '@wtm/core';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';
import { runSkillInstallCommand, type SkillInstaller } from './skill';

export type InitAiSkillStatus =
  | { status: 'installed'; path: string }
  | { status: 'skipped' }
  | { status: 'failed' };

export interface InitCommandResult extends InitResult {
  aiSkill: InitAiSkillStatus;
  confirmation: { defaultsAccepted: boolean };
}

export type InitCommandEnvelope = JsonEnvelope<InitCommandResult | null>;

export interface InitCommandInput extends InitInput {
  aiSkillInstaller?: SkillInstaller;
  installAiSkill?: boolean;
  /** Records explicit acceptance of non-destructive defaults; init remains non-interactive. */
  acceptDefaults?: boolean;
}

export async function runInitCommand(input: InitCommandInput): Promise<InitCommandEnvelope> {
  const mode = input.globalOnly === true ? 'global' as const : 'local' as const;
  let result: InitResult;
  try {
    result = await initializeWorkspace(input);
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'init',
      scope: { mode },
      data: null,
      warnings: [],
      errors: [toInitError(error)],
    };
  }

  let aiSkill: InitAiSkillStatus = { status: 'skipped' };
  const warnings: WtmError[] = result.outOfRangePorts.map((port) => ({
    code: 'WTM_CONFIG_INVALID' as const,
    message: `${port.service} asks for port ${port.preferred}, outside [ports].range = "${port.range}". `
      + `Widen it to "${port.suggested}" to give it that port.`,
    severity: 'warning' as const,
    context: { service: port.service, port: port.preferred, range: port.range },
  }));
  if (input.installAiSkill !== false && input.aiSkillInstaller !== undefined) {
    try {
      const installed = await runSkillInstallCommand({
        scope: 'local',
        installer: input.aiSkillInstaller,
        workspaceRoot: result.discovery.root,
      });
      aiSkill = { status: 'installed', path: installed.path };
    } catch {
      aiSkill = { status: 'failed' };
      warnings.push({
        code: 'WTM_CONFIG_INVALID',
        message: 'Workspace initialized, but the WTM Agent Skill was not installed.',
        severity: 'warning',
        context: { component: 'ai-skill' },
        remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'skill', 'install'] }],
      });
    }
  }

  return {
    schemaVersion: 1,
    ok: true,
    command: 'init',
    scope: { mode, workspaceId: result.workspace.id },
    data: {
      ...result,
      aiSkill,
      confirmation: { defaultsAccepted: input.acceptDefaults === true },
    },
    warnings,
    errors: [],
  };
}

export interface ProductionInitCommandInput {
  root: string;
  maxDepth?: number;
  globalOnly?: boolean;
  userDataDir: string;
  databasePath: string;
  workspaceName?: string;
  aiSkillInstaller?: SkillInstaller;
  installAiSkill?: boolean;
  /** Whether to read the repositories and write what they declare. On by default. */
  detect?: boolean;
  /** Explicit `--yes` intent forwarded into the init result contract. */
  acceptDefaults?: boolean;
}

export interface ProductionInitDependencies {
  openStateStore?(databasePath: string): { stateStore: StateStore; close(): void };
  runInit?(input: InitCommandInput): Promise<InitCommandEnvelope>;
}

export async function runProductionInitCommand(
  input: ProductionInitCommandInput,
  dependencies: ProductionInitDependencies = {},
): Promise<InitCommandEnvelope> {
  const databaseParent = await ensurePrivateDirectory(dirname(input.databasePath));
  const databasePath = join(databaseParent.path, basename(input.databasePath));
  await verifyPrivateDirectory(databaseParent);
  const opened = dependencies.openStateStore?.(databasePath) ?? openSqliteStateStore(databasePath);
  try {
    await verifyPrivateDirectory(databaseParent);
    return await (dependencies.runInit ?? runInitCommand)({
      root: input.root,
      userDataDir: input.userDataDir,
      stateStore: opened.stateStore,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.globalOnly === undefined ? {} : { globalOnly: input.globalOnly }),
      ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
      ...(input.aiSkillInstaller === undefined ? {} : { aiSkillInstaller: input.aiSkillInstaller }),
      ...(input.installAiSkill === undefined ? {} : { installAiSkill: input.installAiSkill }),
      ...(input.detect === undefined ? {} : { detect: input.detect }),
      ...(input.acceptDefaults === undefined ? {} : { acceptDefaults: input.acceptDefaults }),
    });
  } finally {
    opened.close();
  }
}

function openSqliteStateStore(databasePath: string): { stateStore: StateStore; close(): void } {
  const stateStore = new SQLiteStateStore(databasePath);
  return { stateStore, close: () => stateStore.close() };
}

function toInitError(error: unknown): WtmError {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return {
    code,
    message,
    severity: 'error',
    context: { ...errorContext(error), command: 'init' },
  };
}

function errorCode(error: unknown): WtmErrorCode {
  if (hasStringCode(error)) {
    if (error.code === 'WTM_CONFIG_INVALID' || error.code === 'GIT_COMMAND_FAILED') return error.code;
  }
  return 'WTM_CONFIG_INVALID';
}

function errorContext(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const context = 'context' in error && isRecord(error.context) ? error.context : {};
  if (!hasStringCode(error) || error.code !== 'GIT_COMMAND_FAILED') return context;
  return {
    ...context,
    ...('argv' in error && Array.isArray(error.argv) ? { argv: error.argv } : {}),
    ...('exitCode' in error ? { exitCode: error.exitCode } : {}),
    ...('signal' in error ? { signal: error.signal } : {}),
    ...('stderr' in error && typeof error.stderr === 'string' ? { stderr: error.stderr } : {}),
  };
}

function hasStringCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
