import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * The files a repository uses to show which variables it reads, with placeholder values it is
 * safe to commit. WTM reads values out of these — and only these.
 */
export const exampleDeclarationFiles = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
] as const;

/**
 * `.env` itself is read for variable *names* only. It is the file that holds the credentials,
 * and a tool that carries values out of it is a tool that leaks them into logs, into
 * `wtm.toml`, and into whatever reads either — so the reader below drops every value it finds
 * there before its caller can see one.
 */
export const declarationFiles = [...exampleDeclarationFiles, '.env'] as const;

/**
 * The checked-in, public half of `.env` some apps keep beside it: the `[vars]` and
 * `[env.<name>.vars]` tables a wrangler configuration uses, holding every value that is not a
 * secret, while `.env` keeps only the secrets. The app's own tooling copies the chosen table into
 * the process environment and fills only what the environment leaves empty, so a value WTM sets
 * wins over it, exactly as it wins over `.env`.
 *
 * It is read ahead of the example files: an app that has one tends to leave `.env.example`
 * holding names only, and this is where the values it documents actually live.
 */
export const publicVariablesFile = 'variables.toml';

/**
 * The `[env.<name>.vars]` tables that describe this machine. Any other named environment
 * (`staging`, `production`) describes somewhere else: its names are declarations, but its values
 * are never a local port or address.
 */
const localEnvironmentNames = ['development', 'dev', 'local'] as const;

/** `KEY=`, `export KEY=`, and the commented-out form an example file often uses. */
const declarationPattern = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
/** An example file is a few dozen lines; anything longer is not one, and is not read. */
const maxDeclarationBytes = 64 * 1024;

/**
 * The shapes a value may keep: a port number, or a URL on the loopback host. Nothing else
 * survives the reader, so a secret that happens to sit in an example file is dropped here
 * rather than somewhere further along where remembering to drop it is someone's job.
 */
const portValuePattern = /^\d{1,5}$/;
/**
 * A path may follow, but never a query string: `?token=...` is exactly how a credential ends
 * up inside a URL, and no detection here needs one.
 */
const urlPathPattern = '(?:\\/[A-Za-z0-9._~\\/-]*)?';
const loopbackUrlPattern = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d{1,5})?${urlPathPattern}$`, 'i');
/** A compose or Kubernetes hostname: a bare service name, optionally with a port and path. */
const serviceUrlPattern = new RegExp(`^https?://[a-z0-9][a-z0-9._-]*(?::\\d{1,5})?${urlPathPattern}$`, 'i');

export interface EnvDeclaration {
  name: string;
  /** The declared value, when it is one of the shapes above; `null` for everything else. */
  value: string | null;
  /** The file it was declared in, named the way the repository names it. */
  file: string;
}

/**
 * Every variable the repository at `root` declares, in the order first seen, with the values
 * that were safe to keep.
 */
export async function readEnvDeclarations(root: string): Promise<EnvDeclaration[]> {
  const declarations: EnvDeclaration[] = [];
  const seen = new Set<string>();
  for (const declaration of await readPublicVariables(join(root, publicVariablesFile))) {
    if (seen.has(declaration.name)) continue;
    seen.add(declaration.name);
    declarations.push({ ...declaration, file: publicVariablesFile });
  }
  for (const file of declarationFiles) {
    const keepValues = (exampleDeclarationFiles as readonly string[]).includes(file);
    for (const declaration of parseDeclarations(await readDeclarationFile(join(root, file)), keepValues)) {
      if (seen.has(declaration.name)) continue;
      seen.add(declaration.name);
      declarations.push({ ...declaration, file });
    }
  }
  return declarations;
}

/**
 * A `variables.toml`'s declarations: every name in `[vars]` and in each `[env.<name>.vars]`, in
 * file order, with the value kept only when it comes from `[vars]` or a local environment and
 * has one of the safe shapes. Public is not the same as safe to repeat -- such a file can hold a
 * connection string with a demo password in it -- so the same filter as an example file's
 * applies. A file that does not parse declares nothing.
 */
async function readPublicVariables(path: string): Promise<Array<Omit<EnvDeclaration, 'file'>>> {
  const text = await readDeclarationFile(path);
  if (text === '') return [];
  let document: unknown;
  try {
    document = parseToml(text);
  } catch {
    return [];
  }
  const tables: Array<{ vars: Record<string, unknown>; local: boolean }> = [];
  const top = recordAt(document, 'vars');
  if (top !== undefined) tables.push({ vars: top, local: true });
  const environments = recordAt(document, 'env') ?? {};
  for (const [name, environment] of Object.entries(environments)) {
    const vars = recordAt(environment, 'vars');
    if (vars !== undefined) tables.push({ vars, local: (localEnvironmentNames as readonly string[]).includes(name) });
  }
  // A local table's value outranks a remote table's name-only entry, whichever the file lists first.
  tables.sort((left, right) => Number(right.local) - Number(left.local));

  const declarations = new Map<string, Omit<EnvDeclaration, 'file'>>();
  const order: string[] = [];
  for (const { vars, local } of tables) {
    for (const [name, raw] of Object.entries(vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      // A list or table cannot become an environment variable, so it declares nothing.
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
      const value = local ? keptValue(String(raw)) : null;
      const existing = declarations.get(name);
      if (existing === undefined) {
        declarations.set(name, { name, value });
        order.push(name);
      } else if (existing.value === null && value !== null) {
        existing.value = value;
      }
    }
  }
  // File order, not table order: the reader of a detection report recognises it that way.
  const position = (name: string) => text.search(new RegExp(`^\\s*${name}\\s*=`, 'm'));
  return order.sort((left, right) => position(left) - position(right)).map((name) => declarations.get(name) as Omit<EnvDeclaration, 'file'>);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const next = (value as Record<string, unknown>)[key];
  return typeof next === 'object' && next !== null && !Array.isArray(next) ? next as Record<string, unknown> : undefined;
}

/** The variable names alone, which is all a caller that must not see values should ask for. */
export async function readDeclaredNames(path: string): Promise<string[]> {
  return parseDeclarations(await readDeclarationFile(path), false).map(({ name }) => name);
}

/** An assignment that is in force: `KEY=` or `export KEY=`, never the commented-out form. */
const definitionPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The names a dotenv-format file actually assigns, or `null` when there is no such file. Unlike
 * {@link readDeclaredNames}, a commented-out line does not count: the question is what a program
 * loading the file will see, not what the file documents. Values are never read.
 */
export async function readDefinedNames(path: string): Promise<string[] | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  if (contents.length > maxDeclarationBytes) return [];
  const names: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const name = definitionPattern.exec(line)?.[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

async function readDeclarationFile(path: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    // A repository that declares nothing is the normal case, not a failure worth reporting.
    return '';
  }
  return contents.length > maxDeclarationBytes ? '' : contents;
}

function parseDeclarations(contents: string, keepValues: boolean): Array<Omit<EnvDeclaration, 'file'>> {
  const declarations: Array<Omit<EnvDeclaration, 'file'>> = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = declarationPattern.exec(line);
    const name = match?.[1];
    if (name === undefined) continue;
    declarations.push({ name, value: keepValues ? keptValue(match?.[2] ?? '') : null });
  }
  return declarations;
}

/** Strips the quoting and the trailing comment, then keeps the value only if it is a safe shape. */
function keptValue(raw: string): string | null {
  const unquoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(raw.trim());
  const value = (unquoted?.[2] ?? raw.replace(/\s+#.*$/, '')).trim();
  if (value.length === 0) return null;
  if (portValuePattern.test(value)) return Number(value) >= 1 && Number(value) <= 65_535 ? value : null;
  return loopbackUrlPattern.test(value) || serviceUrlPattern.test(value) ? value : null;
}
