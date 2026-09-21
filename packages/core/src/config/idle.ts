import { z } from 'zod';
import { idleTimeoutMs } from './task-timeout';

/**
 * `[tasks.<name>.idle]`: opt one managed task into automatic suspension after a period with no
 * WTM interaction.
 *
 * It is per task rather than a root `[runtime.idle]` table for two reasons. The root schema is
 * strict and states that it has no `runtime` table ([`docs/07`](../../../../docs/07-process-port-runtime.md)
 * — "WTM ... never starts runtime tasks automatically ... not a configuration key"), so a root
 * table would contradict a documented invariant. And a global switch would need a heuristic for
 * which tasks are interactive enough to spare; per-task opt-in needs none, because a debug session
 * or a dev server somebody watches simply never writes this block.
 */
export const idleSchema = z.object({
  /** Off unless written. Nothing WTM starts is suspended by default. */
  enabled: z.boolean().optional(),
  /** How long without WTM interaction counts as idle: `ms`, `s`, `m` or `h`, 1s to 24h. */
  timeout: z.string().min(1).optional(),
}).strict();

export type IdleConfig = z.infer<typeof idleSchema>;

/** One task's resolved idle window, carrying the configured text for the log line that cites it. */
export interface IdlePolicy {
  timeoutMs: number;
  /** Verbatim, so the note in the task's log says `30m` rather than `1800000`. */
  timeout: string;
}

/**
 * The idle window of one task, or null when the task has not opted in.
 *
 * A queued task can never have one: the schema refuses `idle` beside `queue = true`, because a
 * heavy job terminates on its own and is not a `wtm start`-managed long-running process at all.
 * This function repeats that refusal rather than trusting it, so a policy read from a
 * configuration some other path validated cannot admit a job to the sweep.
 */
export function taskIdlePolicy(task: IdleTaskView | undefined): IdlePolicy | null {
  if (task?.idle?.enabled !== true || task.queue === true) return null;
  const timeoutMs = idleTimeoutMs(task.idle.timeout);
  if (timeoutMs === null || task.idle.timeout === undefined) return null;
  return { timeoutMs, timeout: task.idle.timeout };
}

/** The two fields an idle policy is read from, so a caller may pass any parsed task table. */
export interface IdleTaskView {
  idle?: IdleConfig | undefined;
  queue?: boolean | undefined;
}

/** Every task of one workspace configuration that opted in, by task name. */
export function idlePolicies(
  config: { tasks?: Record<string, IdleTaskView> | undefined },
): Map<string, IdlePolicy> {
  const policies = new Map<string, IdlePolicy>();
  for (const [taskName, task] of Object.entries(config.tasks ?? {})) {
    const policy = taskIdlePolicy(task);
    if (policy !== null) policies.set(taskName, policy);
  }
  return policies;
}
