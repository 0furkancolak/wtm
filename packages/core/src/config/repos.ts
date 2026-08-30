import { basename, resolve } from 'node:path';
import { WtmConfigError, type RepoConfig, type WtmConfig } from './schema';

export interface RepoScopeInput {
  workspaceRoot: string;
  /** The repository's main working tree, which is what a `[repos.<name>]` entry names. */
  repoRoot: string;
}

export interface ResolvedRepoScope {
  name: string;
  config: RepoConfig;
}

/**
 * The `[repos.<name>]` entry that describes one repository of the workspace.
 *
 * An entry names its repository by `path`, relative to the workspace root; without one, the
 * table's own name is matched against the repository directory's name — which is what `wtm
 * init` writes, and what a person would have written by hand.
 */
export function resolveRepoScope(config: WtmConfig, input: RepoScopeInput): ResolvedRepoScope | undefined {
  const repos = config.repos;
  if (repos === undefined) return undefined;
  const repoRoot = resolve(input.repoRoot);
  const directory = basename(repoRoot);

  const matches = Object.entries(repos)
    .filter(([name, entry]) => entry.path === undefined
      ? name === directory
      : resolve(input.workspaceRoot, entry.path) === repoRoot)
    .sort(([left], [right]) => left.localeCompare(right));

  const first = matches[0];
  if (first === undefined) return undefined;
  if (matches.length > 1) {
    throw new WtmConfigError('Several [repos] entries name the same repository.', {
      repoRoot,
      entries: matches.map(([name]) => name),
      action: 'Keep one entry per repository, or give each a distinct path.',
    });
  }
  return { name: first[0], config: first[1] };
}

/** The variables that entry publishes, layered over the workspace's own `[environment]`. */
export function repoEnvironment(config: WtmConfig, input: RepoScopeInput): Record<string, string> | undefined {
  return resolveRepoScope(config, input)?.config.environment;
}
