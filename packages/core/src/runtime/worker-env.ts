import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readDefinedNames } from '../detect/declarations';

/**
 * Why a Cloudflare worker started with `wrangler dev` does not see what WTM sets.
 *
 * `wrangler dev` builds a worker's `env` from its own configuration's `vars` and from
 * `.dev.vars` (or, when there is none, `.env` files) -- never from the process environment it
 * was started with. A port or CORS allowlist WTM derived for this feature therefore reaches the
 * wrangler process and stops there, and the worker keeps whatever the file said. The one channel
 * that outranks both files is a `--var NAME:VALUE` on the command line, which is what a task's
 * `worker_vars` produces. `--env-file` is not one: given any, wrangler stops reading `.dev.vars`
 * altogether, secrets included.
 *
 * Everything here reads variable *names* only. `.dev.vars` is where a worker's secrets live.
 */

export interface WranglerDevCommand {
  /** `-c`/`--config`, as written: relative to the task's working directory. */
  configPath?: string;
  /** `-e`/`--env`: the wrangler environment whose `vars` and `.dev.vars.<env>` apply. */
  environment?: string;
  /** Names already passed as `--var NAME:...` in the command itself. */
  forwarded: string[];
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const wranglerProgram = /^wrangler(?:@\S*)?$/;
const shellWranglerDev = /(?:^|[\s;&|()/])wrangler(?:@\S*)?\s+dev(?=$|[\s;&|)])/;
const shellVarFlag = /--var[=\s]+["']?([A-Za-z_][A-Za-z0-9_]*):/g;

/**
 * The `wrangler dev` invocation inside a task's command, or `null` when it runs something else.
 * A shell string is matched as text and yields only its `--var` names: its other options are
 * whatever the shell makes of them, and guessing at quoting is how a report goes wrong.
 */
export function wranglerDevCommand(command: string | readonly string[]): WranglerDevCommand | null {
  if (typeof command === 'string') {
    if (!shellWranglerDev.test(command)) return null;
    return { forwarded: [...command.matchAll(shellVarFlag)].map((match) => match[1] as string) };
  }
  const program = command.findIndex((argument) => wranglerProgram.test(argument.slice(argument.lastIndexOf('/') + 1)));
  if (program === -1) return null;
  const subcommand = command.slice(program + 1).find((argument) => !argument.startsWith('-'));
  if (subcommand !== 'dev') return null;

  const found: WranglerDevCommand = { forwarded: [] };
  const rest = command.slice(command.indexOf('dev', program + 1) + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (argument === '--') break;
    const [flag, inline] = splitOption(argument);
    if (flag === '-c' || flag === '--config') {
      const value = inline ?? rest[++index];
      if (value !== undefined) found.configPath = value;
    } else if (flag === '-e' || flag === '--env') {
      const value = inline ?? rest[++index];
      if (value !== undefined) found.environment = value;
    } else if (flag === '--var') {
      // yargs reads an array option greedily: `--var A:1 B:2` is two pairs.
      const values = inline === undefined ? [] : [inline];
      while (inline === undefined && rest[index + 1] !== undefined && !(rest[index + 1] as string).startsWith('-')) {
        values.push(rest[++index] as string);
      }
      for (const value of values) {
        const name = value.slice(0, value.indexOf(':'));
        if (value.includes(':') && variableName.test(name)) found.forwarded.push(name);
      }
    }
  }
  return found;
}

function splitOption(argument: string): [string, string | undefined] {
  const equals = argument.indexOf('=');
  return argument.startsWith('-') && equals !== -1
    ? [argument.slice(0, equals), argument.slice(equals + 1)]
    : [argument, undefined];
}

export interface WorkerDefinitionInput {
  /** The task's resolved working directory. */
  cwd: string;
  configPath?: string;
  environment?: string;
}

/** The configuration file names wrangler looks for, in its own order. */
const wranglerConfigFiles = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;

/**
 * Every variable the worker gets from its own files, mapped to the file (relative to `cwd`)
 * that has the last word on it -- the same precedence wrangler applies: configuration `vars`
 * first, then `.dev.vars.<env>` or `.dev.vars` (only one of them), and only when neither
 * exists, the `.env` family. Absent or unreadable files contribute nothing.
 */
export async function readWorkerDefinitions(input: WorkerDefinitionInput): Promise<Record<string, string>> {
  const configFile = await findWranglerConfig(input);
  const configDir = configFile === undefined ? input.cwd : dirname(configFile);
  const definitions: Record<string, string> = {};
  const define = (names: readonly string[], file: string) => {
    for (const name of names) definitions[name] = relative(input.cwd, file) || file;
  };

  if (configFile !== undefined) define(await readConfigVarNames(configFile, input.environment), configFile);

  const devVarsFiles = [
    ...(input.environment === undefined ? [] : [join(configDir, `.dev.vars.${input.environment}`)]),
    join(configDir, '.dev.vars'),
  ];
  for (const file of devVarsFiles) {
    const names = await readDefinedNames(file);
    if (names === null) continue;
    define(names, file);
    return definitions;
  }

  const dotenvFiles = ['.env', '.env.local', ...(input.environment === undefined
    ? [] : [`.env.${input.environment}`, `.env.${input.environment}.local`])];
  for (const name of dotenvFiles) {
    const file = join(configDir, name);
    define(await readDefinedNames(file) ?? [], file);
  }
  return definitions;
}

/**
 * The wrangler configuration file a `wrangler dev` started in `cwd` reads, or `undefined` when
 * there is none -- in which case there is no worker here to report on.
 */
export async function findWranglerConfig(input: { cwd: string; configPath?: string }): Promise<string | undefined> {
  return await firstExisting(input.configPath === undefined
    ? wranglerConfigFiles.map((name) => join(input.cwd, name))
    : [resolve(input.cwd, input.configPath)]);
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/** The keys of the `vars` table in force: a wrangler environment does not inherit the top level's. */
async function readConfigVarNames(file: string, environment: string | undefined): Promise<string[]> {
  let parsed: unknown;
  try {
    const text = await readFile(file, 'utf8');
    parsed = file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const scope = environment === undefined ? parsed : objectAt(objectAt(parsed, 'env'), environment);
  const vars = objectAt(scope, 'vars');
  return vars === undefined ? [] : Object.keys(vars);
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const next = (value as Record<string, unknown>)[key];
  return typeof next === 'object' && next !== null && !Array.isArray(next) ? next as Record<string, unknown> : undefined;
}

/** JSON with comments and trailing commas, as wrangler.jsonc allows, made into plain JSON. */
function stripJsonc(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      output += text.slice(start, index + 1);
      index += 1;
    } else if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (character === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next += 1;
      if (text[next] !== '}' && text[next] !== ']') output += character;
      index += 1;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
}

export interface WorkerEnvironmentInput {
  /** Every variable WTM sets for the task, by name. */
  environmentNames: readonly string[];
  /** Names the command hands the worker as `--var`, `worker_vars` included. */
  forwarded: readonly string[];
  /** What {@link readWorkerDefinitions} found. */
  definitions: Record<string, string>;
}

export interface WorkerEnvironmentReport {
  /** WTM variables the worker receives. */
  forwarded: string[];
  /**
   * WTM variables the worker also defines in its own files. The worker sees the file's value,
   * not WTM's, and nothing says so -- this is the list worth warning about.
   */
  shadowed: Array<{ name: string; file: string }>;
  /** WTM variables the worker never sees, but that nothing in its files claims either. */
  unreached: string[];
}

export function analyzeWorkerEnvironment(input: WorkerEnvironmentInput): WorkerEnvironmentReport {
  const forwarded = new Set(input.forwarded);
  const names = [...new Set(input.environmentNames)].sort(compareNames);
  return {
    forwarded: names.filter((name) => forwarded.has(name)),
    shadowed: names
      .filter((name) => !forwarded.has(name) && Object.hasOwn(input.definitions, name))
      .map((name) => ({ name, file: input.definitions[name] as string })),
    unreached: names.filter((name) => !forwarded.has(name) && !Object.hasOwn(input.definitions, name)),
  };
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
