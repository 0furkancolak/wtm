import { parseWtmConfig, WtmConfigError, type WtmConfig } from '../config/schema';
import { resolveTemplate, type TemplateContext } from '../templates/resolve';
import { resolveEnvironment } from './environment';

export interface ResolvedTask {
  argv: string[];
  shell: boolean;
  cwd: string;
  envDelta: Record<string, string>;
  background: boolean;
  singleton: boolean;
}

export interface TaskResolutionInput {
  config: WtmConfig;
  taskName: string;
  isMain: boolean;
  context: TemplateContext;
}

export class WtmTaskResolutionError extends Error {
  readonly code = 'WTM_CONFIG_INVALID' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WtmTaskResolutionError';
    this.context = context;
  }
}

export function resolveTask(input: TaskResolutionInput): ResolvedTask {
  const config = validatedConfig(input);
  const task = config.tasks?.[input.taskName];
  if (task === undefined) {
    throw new WtmTaskResolutionError(`Unknown task: ${input.taskName}`, { taskName: input.taskName });
  }

  const command = task.run ?? (input.isMain ? task.main : task.worktree);
  if (command === undefined) {
    const target = input.isMain ? 'main-worktree' : 'linked-worktree';
    throw new WtmTaskResolutionError(`Task ${input.taskName} does not define a ${target} command.`, {
      taskName: input.taskName,
      target,
    });
  }

  const envDelta = resolveEnvironment({
    ...(config.environment === undefined ? {} : { workspace: config.environment }),
    ...(task.env === undefined ? {} : { task: task.env }),
    context: input.context,
  });
  const context = {
    ...input.context,
    env: { ...input.context.env, ...envDelta },
  };
  const argv = (typeof command === 'string' ? [command] : command)
    .map((argument) => resolveTemplate(argument, context));
  const rawCwd = task.cwd ?? input.context.worktree?.root;
  if (rawCwd === undefined) {
    throw new WtmTaskResolutionError(`Task ${input.taskName} has no resolvable working directory.`, {
      taskName: input.taskName,
    });
  }

  return {
    argv,
    shell: task.shell === true,
    cwd: resolveTemplate(rawCwd, context),
    envDelta,
    background: task.background ?? false,
    singleton: task.singleton ?? true,
  };
}

function validatedConfig(input: TaskResolutionInput): WtmConfig {
  try {
    return parseWtmConfig(input.config);
  } catch (error) {
    if (!(error instanceof WtmConfigError)) throw error;
    const issues = Array.isArray(error.context.issues) ? error.context.issues : [];
    const firstIssue = issues[0];
    const message = typeof firstIssue === 'object'
      && firstIssue !== null
      && 'message' in firstIssue
      && typeof firstIssue.message === 'string'
      ? firstIssue.message
      : error.message;
    throw new WtmTaskResolutionError(message, { ...error.context, taskName: input.taskName });
  }
}
