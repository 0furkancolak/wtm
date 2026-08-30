import type { AdapterContext, AdapterPlan } from '@wtm/protocol';
import { detectBuiltInAdapters } from './registry';

export type AdapterTasks = AdapterPlan['tasks'];

/**
 * The tasks the detected built-in adapters contribute for one worktree.
 *
 * A repository usually describes its own commands already — Makefile targets, Compose
 * services — and these surface them under WTM without asking for a second copy in
 * `wtm.toml`. The project's own configuration always wins over anything named here.
 */
export async function detectAdapterTasks(context: AdapterContext): Promise<AdapterTasks> {
  const graph = await detectBuiltInAdapters(context);
  const tasks: Record<string, AdapterTasks[string]> = {};
  for (const activation of graph.active) {
    const plan = await activation.adapter.plan(context);
    for (const [name, task] of Object.entries(plan.tasks)) {
      // An earlier adapter in the registry order keeps the name it claimed first.
      tasks[name] ??= task;
    }
  }
  return tasks;
}
