import { randomUUID } from 'node:crypto';
import { InvalidArgumentError, type Command } from 'commander';
import { z } from 'zod';
import {
  enqueueAcceptanceSchema,
  jobArgumentSchemas,
  jobSchedulingSchema,
  jobStateSchema,
  sourceValiditySchema,
  type JsonEnvelope,
  type WtmErrorCode,
} from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

type JobCommand = keyof typeof jobArgumentSchemas;
interface JsonOptions { json?: boolean }

export interface JobCommandRegistration {
  client?: RuntimeDaemonClient;
  render(envelope: JsonEnvelope<unknown>, json: boolean): void;
}

/** The job ID is a global lookup key; inspecting a job never depends on the caller's cwd. */
export function registerJobCommands(program: Command, options: JobCommandRegistration): void {
  const jobs = program.command('jobs').description('Inspect and control the shared heavy-task queue.');
  jobs.option('--json', 'emit the stable JSON envelope');
  const render = (envelope: JsonEnvelope<unknown>, local: JsonOptions) => options.render(
    envelope, local.json === true || jobs.opts<JsonOptions>().json === true || program.opts<JsonOptions>().json === true,
  );

  const list = jobs.command('list').description('List recent jobs across all registered workspaces.');
  list.option('--json', 'emit the stable JSON envelope');
  list.option('--limit <count>', 'maximum number of jobs, from 1 to 100', boundedInteger(100, 'limit'));
  list.action(async (args: JsonOptions & { limit?: number }) => {
    render(await requestJobCommand('jobs.list', args.limit === undefined ? {} : { limit: args.limit }, options.client), args);
  });

  for (const [action, description] of [
    ['status', 'Read a job state and process cleanup status.'],
    ['result', 'Read a completed result and verify its source evidence.'],
    ['cancel', 'Cancel a queued job or safely stop its process tree.'],
  ] as const) {
    const command = jobs.command(`${action} <job-id>`).description(description);
    command.option('--json', 'emit the stable JSON envelope');
    command.action(async (jobId: string, args: JsonOptions) => {
      render(await requestJobCommand(`jobs.${action}`, { jobId }, options.client), args);
    });
  }

  const logs = jobs.command('logs <job-id>').description('Read a bounded tail of a job stdout and stderr.');
  logs.option('--json', 'emit the stable JSON envelope');
  logs.option('--tail <lines>', 'lines per stream, from 1 to 1000', boundedInteger(1000, 'tail'), 100);
  logs.action(async (jobId: string, args: JsonOptions & { tail: number }) => {
    render(await requestJobCommand('jobs.logs', { jobId, tail: args.tail }, options.client), args);
  });
}

export async function runEnqueueCommand(
  input: { cwd: string; taskName: string; idempotencyKey?: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  // Generate before sending so a lost acceptance response never forces a blind resubmission.
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const envelope = await requestJobCommand('jobs.enqueue', { ...input, idempotencyKey }, client);
  if (envelope.ok) return envelope;
  const [first, ...rest] = envelope.errors;
  const withRetryKey = (error: typeof first) => ({ ...error, context: { ...error.context, idempotencyKey } });
  return {
    ...envelope,
    errors: [withRetryKey(first), ...rest.map(withRetryKey)],
  };
}

export async function requestJobCommand(
  command: JobCommand,
  args: unknown,
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  const name = command === 'jobs.enqueue' ? 'run' : command.replace('.', ' ');
  const parsed = jobArgumentSchemas[command].safeParse(args);
  if (!parsed.success) return failure(name, null, 'WTM_CONFIG_INVALID', 'Invalid job command arguments.');
  const response = await requestRuntimeCommand(command, args, client);
  const envelope = { ...response, command: name };
  if (!envelope.ok) return envelope;
  if (command === 'jobs.enqueue') {
    const acceptance = enqueueAcceptanceSchema.safeParse(envelope.data);
    if (!acceptance.success || !('idempotencyKey' in parsed.data) || acceptance.data.idempotencyKey !== parsed.data.idempotencyKey) {
      return failure(name, envelope.data, 'WTM_DAEMON_REQUEST_FAILED', 'Daemon returned an invalid job acceptance.');
    }
  }
  if ('jobId' in parsed.data) {
    const identity = command === 'jobs.logs'
      ? logIdentitySchema.safeParse(envelope.data)
      : jobIdentitySchema.safeParse(envelope.data);
    if (!identity.success || ('job' in identity.data ? identity.data.job.jobId : identity.data.jobId) !== parsed.data.jobId) {
      return failure(name, envelope.data, 'WTM_DAEMON_REQUEST_FAILED', 'Daemon returned evidence for an invalid job identity.');
    }
  }
  if (command === 'jobs.list' && !jobListSchema.safeParse(envelope.data).success) {
    return failure(name, envelope.data, 'WTM_DAEMON_REQUEST_FAILED', 'Daemon returned invalid job scheduling evidence.');
  }
  if (command === 'jobs.result') return checkedJobResult(envelope);
  return envelope;
}

// Keep the daemon's complete result intact, but validate every field relied on for success.
const logIdentitySchema = z.object({ jobId: z.string().min(1) });
const scheduledJobSchema = logIdentitySchema.and(jobSchedulingSchema);
const jobIdentitySchema = z.object({ job: scheduledJobSchema });
const jobListSchema = z.object({ jobs: z.array(scheduledJobSchema).max(100) });
const resultEvidenceSchema = z.object({
  job: z.object({
    jobId: z.string().min(1), state: jobStateSchema, exitCode: z.number().int().nullable(),
    signal: z.string().nullable(), slotHeld: z.boolean(),
    stopReason: z.enum(['CANCELLED', 'TIMED_OUT', 'INTERRUPTED']).nullable().optional(),
  }).passthrough(),
  terminal: z.boolean(),
  successful: z.boolean(),
  sourceValidity: sourceValiditySchema,
}).passthrough();

function checkedJobResult(envelope: JsonEnvelope<unknown>): JsonEnvelope<unknown> {
  const parsed = resultEvidenceSchema.safeParse(envelope.data);
  if (!parsed.success) {
    return failure(envelope.command, envelope.data, 'WTM_DAEMON_REQUEST_FAILED', 'Daemon returned invalid job result evidence.');
  }
  const result = parsed.data;
  const code = !result.terminal || result.job.slotHeld ? 'WTM_JOB_NOT_COMPLETE'
    : !result.successful || result.job.state !== 'SUCCEEDED' || result.job.exitCode !== 0 || result.job.signal !== null || result.job.stopReason != null ? 'WTM_JOB_UNSUCCESSFUL'
      : result.sourceValidity !== 'UNCHANGED' ? 'WTM_JOB_SOURCE_CHANGED'
        : null;
  if (code === null) return envelope;
  const message = code === 'WTM_JOB_NOT_COMPLETE' ? 'Job has not completed.'
    : code === 'WTM_JOB_UNSUCCESSFUL' ? 'Job did not complete successfully.'
      : 'Job result does not validate the current source state.';
  return {
    ...envelope,
    ok: false,
    errors: [{ code, message, severity: 'error', context: { jobId: result.job.jobId } }],
  };
}

function failure(command: string, data: unknown, code: WtmErrorCode, message: string): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: false, command, data, warnings: [], errors: [{ code, message, severity: 'error' }] };
}

function boundedInteger(maximum: number, name: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new InvalidArgumentError(`${name} must be an integer from 1 to ${maximum}`);
    }
    return parsed;
  };
}
