import { detectAdapterTasks } from '@wtm/adapters';
import type { WtmConfig } from '@wtm/core';
import type { AdapterContext } from '@wtm/protocol';

/**
 * Returns the configuration a supervised task resolves against, with the tasks the
 * detected adapters contribute placed underneath it, so `wtm start` reaches the same
 * task names as `wtm run`. Anything `wtm.toml` names keeps its own definition.
 */
export async function withAdapterTasks(config: WtmConfig, context: AdapterContext): Promise<WtmConfig> {
  let adapterTasks: Awaited<ReturnType<typeof detectAdapterTasks>>;
  try {
    adapterTasks = await detectAdapterTasks(context);
  } catch {
    // Detection reads the worktree; a task the project itself defines must still resolve.
    return config;
  }
  if (Object.keys(adapterTasks).length === 0) return config;
  return { ...config, tasks: { ...adapterTasks, ...config.tasks } };
}
