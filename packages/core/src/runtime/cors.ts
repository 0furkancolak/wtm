import { join } from 'node:path';
import { declarationFiles, readDeclaredNames } from '../detect/declarations';
import type { CorsConfig } from '../config/schema';

/**
 * The files a repository uses to declare which variables it reads. They are read for their
 * variable *names* only: a real `.env` holds credentials, and WTM has no business carrying
 * those anywhere, so no value is ever parsed out of these files.
 */
export const corsDeclarationFiles = declarationFiles;

/**
 * Names a CORS allowlist is conventionally published under, across the frameworks that read
 * one: `CORS_ORIGIN`, `CORS_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `ALLOWED_ORIGINS`, and the same
 * spellings behind a project prefix. Deliberately narrow — a variable WTM guesses wrong about
 * is a variable it overwrites for no reason.
 */
export const corsVariablePattern = /^(?:[A-Z0-9]+(?:_[A-Z0-9]+)*_)?(?:CORS_(?:ALLOWED_)?ORIGINS?|ALLOWED?_ORIGINS?)$/;

export interface CorsResolutionInput {
  cors?: CorsConfig;
  /** The worktree whose declaration files are read. */
  root: string;
  /** Origins WTM allocated for this feature, in configuration order. */
  origins: readonly string[];
}

export interface ResolvedCors {
  /** The allowlist, as a single comma-separated value. */
  value: string;
  /** The variables it is published under. Empty when nothing declared one. */
  variables: string[];
}

/**
 * Works out which variable this repository publishes its CORS allowlist under, and what the
 * allowlist should contain for this feature.
 *
 * A feature checked out across a web repository and an API repository runs both on ports WTM
 * chose, so neither side can know the other's origin ahead of time and the allowlist has to be
 * written by hand on every branch. This reads the variable name the repository already
 * declares and fills it in, which is the whole of the manual step.
 */
export async function resolveCors(input: CorsResolutionInput): Promise<ResolvedCors> {
  const origins = [...input.origins, ...(input.cors?.origins ?? [])];
  const value = [...new Set(origins)].join(',');
  if (input.cors?.enabled === false || value === '') return { value, variables: [] };
  const variables = input.cors?.env ?? await detectCorsVariables(input.root);
  return { value, variables };
}

/** The CORS variables the repository's own example files declare, in the order first seen. */
export async function detectCorsVariables(root: string): Promise<string[]> {
  const found = new Set<string>();
  for (const file of corsDeclarationFiles) {
    for (const name of await readDeclaredNames(join(root, file))) {
      if (corsVariablePattern.test(name)) found.add(name);
    }
  }
  return [...found];
}
