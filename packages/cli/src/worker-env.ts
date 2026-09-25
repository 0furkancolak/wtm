import { relative, resolve } from 'node:path';
import {
  analyzeWorkerEnvironment,
  findWranglerConfig,
  readWorkerDefinitions,
  resolveTemplate,
  wranglerDevCommand,
  type WorkerEnvironmentReport,
} from '@wtm/core';
import type { WorktreeRuntime } from '@wtm/daemon';

/** One `wrangler dev` task, and which of the variables WTM sets for it reach its worker. */
export interface WorkerTaskReport {
  task: string;
  /** The task's working directory, relative to the worktree (`.` for its root). */
  directory: string;
  report: WorkerEnvironmentReport;
}

/**
 * One worker configuration in this worktree -- a wrangler config file and the wrangler
 * environment it is read under -- with every task that runs it.
 */
export interface WorkerLocationReport {
  directory: string;
  /** The `wrangler dev` tasks that run this worker, sorted. Empty for a config nothing here runs. */
  tasks: string[];
  /** Of those, the ones that leave a variable in {@link shadowed} unforwarded -- the ones to fix. */
  unforwardedBy: string[];
  /**
   * Variables WTM sets that this worker's own files also define and that do not reach it: some
   * task running it leaves them unforwarded, or no task runs it and whatever reads the file does
   * not see WTM's value either.
   */
  shadowed: Array<{ name: string; file: string }>;
}

export interface WorkerEnvironmentInspection {
  tasks: WorkerTaskReport[];
  locations: WorkerLocationReport[];
}

/**
 * Every Cloudflare worker configuration in this worktree, and the WTM variables that never reach
 * it. Answers from variable *names* alone: nothing is resolved, so no port is leased to answer,
 * and nothing is read out of `.dev.vars` but the names it assigns.
 *
 * Tasks are workspace-wide, so a `wrangler dev` task written for one repository also resolves in
 * every other; the report is grouped by the worker it would run rather than by task name, which
 * is what keeps its advice right in a repository that task was never meant for.
 */
export async function inspectWorkerEnvironments(runtime: WorktreeRuntime): Promise<WorkerEnvironmentInspection> {
  const root = runtime.registration.worktree.path;
  const baseNames = [
    ...Object.keys(runtime.automaticEnvironment),
    ...Object.keys(runtime.config.environment ?? {}),
    ...Object.keys(runtime.repoEnvironment ?? {}),
  ];
  const locations = new Map<string, {
    directory: string;
    configFile: string;
    definitions: Record<string, string>;
    tasks: WorkerTaskReport[];
  }>();
  const locate = async (cwd: string, configPath: string | undefined, environment: string | undefined) => {
    const configFile = await findWranglerConfig({ cwd, ...(configPath === undefined ? {} : { configPath }) });
    if (configFile === undefined) return undefined;
    const key = `${configFile}\u0000${environment ?? ''}`;
    let location = locations.get(key);
    if (location === undefined) {
      const definitions = await readWorkerDefinitions({
        cwd: root,
        configPath: configFile,
        ...(environment === undefined ? {} : { environment }),
      });
      location = { directory: relative(root, cwd) || '.', configFile: relative(root, configFile) || configFile, definitions, tasks: [] };
      locations.set(key, location);
    }
    return location;
  };

  // The worktree's own configuration comes first, whether or not a task runs it: app code that
  // reads `wrangler.json` itself is just as blind to the process environment as a worker is.
  await locate(root, undefined, undefined);

  const tasks: WorkerTaskReport[] = [];
  for (const [name, task] of Object.entries(runtime.config.tasks ?? {}).sort(([left], [right]) => compare(left, right))) {
    const command = task.run ?? (runtime.registration.worktree.isMain ? task.main : task.worktree);
    if (command === undefined) continue;
    const dev = wranglerDevCommand(command);
    if (dev === null) continue;
    let cwd: string;
    try {
      cwd = resolve(root, resolveTemplate(task.cwd ?? '{worktree.root}', runtime.context));
    } catch {
      continue;
    }
    const location = await locate(cwd, dev.configPath, dev.environment);
    if (location === undefined) continue;
    const report: WorkerTaskReport = {
      task: name,
      directory: location.directory,
      report: analyzeWorkerEnvironment({
        environmentNames: [...baseNames, ...Object.keys(task.env ?? {})],
        forwarded: [...dev.forwarded, ...(task.worker_vars ?? [])],
        definitions: location.definitions,
      }),
    };
    location.tasks.push(report);
    tasks.push(report);
  }

  return {
    tasks,
    locations: [...locations.values()].map((location) => ({
      directory: location.directory,
      tasks: location.tasks.map(({ task }) => task),
      unforwardedBy: location.tasks.filter(({ report }) => report.shadowed.length > 0).map(({ task }) => task),
      // With no `wrangler dev` here, `.dev.vars` and `.env` are read by nothing that ranks them above
      // the process environment (a framework loading `.env` lets the environment win); only code
      // that reads the wrangler configuration itself can miss WTM's value.
      shadowed: location.tasks.length === 0
        ? analyzeWorkerEnvironment({
          environmentNames: baseNames,
          forwarded: [],
          definitions: Object.fromEntries(Object.entries(location.definitions).filter(([, file]) => file === location.configFile)),
        }).shadowed
        : uniqueByName(location.tasks.flatMap(({ report }) => report.shadowed)),
    })),
  };
}

/** `wtm doctor`'s `worker-env` finding, from an inspection. */
export function workerEnvironmentFinding(inspection: WorkerEnvironmentInspection): {
  check: 'worker-env';
  status: 'pass' | 'warning';
  message: string;
  details: Record<string, string | number>;
} {
  const { locations } = inspection;
  const tasks = [...new Set(locations.flatMap((location) => location.tasks))].sort(compare);
  const unforwardedBy = [...new Set(locations.flatMap((location) => location.unforwardedBy))].sort(compare);
  const shadowed = [...new Set(locations.flatMap((location) => location.shadowed.map(({ name }) => name)))].sort(compare);
  const details = {
    workers: locations.length,
    tasks: tasks.join(', '),
    unforwardedBy: unforwardedBy.join(', '),
    shadowed: shadowed.join(', '),
  };
  const problems = locations.filter((location) => location.shadowed.length > 0);
  if (problems.length === 0) {
    return {
      check: 'worker-env',
      status: 'pass',
      message: locations.length === 0
        ? 'No Cloudflare worker configuration in this worktree.'
        : `${locations.length} worker ${locations.length === 1 ? 'configuration' : 'configurations'}; `
          + 'every variable WTM sets that its files also define is forwarded.',
      details,
    };
  }
  return { check: 'worker-env', status: 'warning', message: problems.map(locationMessage).join(' '), details };
}

function locationMessage(location: WorkerLocationReport): string {
  const names = location.shadowed.map(({ name }) => name);
  const where = location.directory === '.' ? '' : ` in ${location.directory}`;
  const files = [...new Set(location.shadowed.map(({ file }) => file))];
  const defines = files
    .map((file) => `${file} defines ${location.shadowed.filter((entry) => entry.file === file).map(({ name }) => name).join(', ')}`)
    .join(' and ');
  if (location.tasks.length === 0) {
    return `${defines}${where}, which WTM also sets for this worktree. WTM's value reaches the process `
      + `environment only: anything that reads ${names.length === 1 ? 'it' : 'them'} from `
      + `${files.join(' or ')} instead (a build script, a framework config) sees the file's value.`;
  }
  // Only the tasks that leave something behind: one that already forwards everything is not the
  // one to edit, even when it runs the same worker.
  const offenders = location.unforwardedBy;
  const runners = offenders.length === 1 ? `${offenders[0]} runs` : `${offenders.join(', ')} run`;
  const target = offenders.length === 1
    ? `[tasks.${JSON.stringify(offenders[0])}]`
    : offenders.map((task) => `[tasks.${JSON.stringify(task)}]`).join(' and ');
  return `${runners} \`wrangler dev\`${where}, where ${defines}, and WTM sets ${names.length === 1 ? 'it' : 'them'} too. `
    + 'wrangler builds a worker\'s env from its config vars and .dev.vars, never from the process environment, '
    + `so the worker keeps the files' values. Add worker_vars = [${names.map((name) => JSON.stringify(name)).join(', ')}] to ${target}.`;
}

function uniqueByName(entries: ReadonlyArray<{ name: string; file: string }>): Array<{ name: string; file: string }> {
  const seen = new Map<string, { name: string; file: string }>();
  for (const entry of entries) if (!seen.has(entry.name)) seen.set(entry.name, entry);
  return [...seen.values()].sort((left, right) => compare(left.name, right.name));
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

