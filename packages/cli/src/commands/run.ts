import { spawn } from 'node:child_process';
import {
  resolveTask,
  type ResolvedTask,
  type TaskResolutionInput,
} from '@wtm/core';
import type { JsonEnvelope } from '@wtm/protocol';
import { commandScope, toRuntimeCommandError } from './resolve';

export interface RunCommandInput extends TaskResolutionInput {
  workspaceId?: string;
}

export interface RunCommandResult {
  task: ResolvedTask;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export type RunCommandEnvelope = JsonEnvelope<RunCommandResult | null>;

class ForegroundTaskError extends Error {
  readonly code = 'RUNTIME_START_FAILED' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = 'ForegroundTaskError';
    this.context = context;
  }
}

export async function runRunCommand(input: RunCommandInput): Promise<RunCommandEnvelope> {
  try {
    const task = resolveTask(input);
    const result = await runForegroundTask(task);
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new ForegroundTaskError(
        `Task ${input.taskName} exited unsuccessfully.`,
        { exitCode: result.exitCode, signal: result.signal },
      );
    }
    return {
      schemaVersion: 1,
      ok: true,
      command: 'run',
      scope: commandScope(input),
      data: { task, ...result },
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'run',
      scope: commandScope(input),
      data: null,
      warnings: [],
      errors: [toRuntimeCommandError(error, 'run', input.taskName)],
    };
  }
}

async function runForegroundTask(
  task: ResolvedTask,
): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> {
  const executable = task.argv[0];
  if (executable === undefined) throw new ForegroundTaskError('Resolved task command is empty.', {});

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, task.shell ? [] : task.argv.slice(1), {
      cwd: task.cwd,
      env: { ...process.env, ...task.envDelta },
      shell: task.shell,
      stdio: 'inherit',
    });
    child.once('error', (error) => reject(new ForegroundTaskError(error.message, {
      executable,
      code: 'code' in error ? error.code : undefined,
    })));
    child.once('exit', (exitCode, signal) => resolve({
      exitCode: exitCode ?? 1,
      signal,
    }));
  });
}
