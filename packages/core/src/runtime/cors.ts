import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorsConfig } from '../config/schema';

/**
 * The files a repository uses to declare which variables it reads. They are read for their
 * variable *names* only: a real `.env` holds credentials, and WTM has no business carrying
 * those anywhere, so no value is ever parsed out of these files.
 */
export const corsDeclarationFiles = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
  '.env',
] as const;

/**
 * Names a CORS allowlist is conventionally published under, across the frameworks that read
 * one: `CORS_ORIGIN`, `CORS_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `ALLOWED_ORIGINS`, and the same
 * spellings behind a project prefix. Deliberately narrow — a variable WTM guesses wrong about
 * is a variable it overwrites for no reason.
 */
const corsVariablePattern = /^(?:[A-Z0-9]+(?:_[A-Z0-9]+)*_)?(?:CORS_(?:ALLOWED_)?ORIGINS?|ALLOWED?_ORIGINS?)$/;
/** `KEY=`, `export KEY=`, and the commented-out form an example file often uses. */
const declarationPattern = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** An example file is a few dozen lines; anything longer is not one, and is not read. */
const maxDeclarationBytes = 64 * 1024;

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

async function readDeclaredNames(path: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    // A repository that declares nothing is the normal case, not a failure worth reporting.
    return [];
  }
  if (contents.length > maxDeclarationBytes) return [];
  return contents
    .split(/\r?\n/)
    .map((line) => declarationPattern.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}
