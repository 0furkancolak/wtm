import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/** The variable names alone, which is all a caller that must not see values should ask for. */
export async function readDeclaredNames(path: string): Promise<string[]> {
  return parseDeclarations(await readDeclarationFile(path), false).map(({ name }) => name);
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
