import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { relative as posixRelative, resolve as posixResolve, sep as posixSep } from 'node:path/posix';
import { relative as win32Relative, resolve as win32Resolve, sep as win32Sep } from 'node:path/win32';
import { parse } from 'smol-toml';
import { parseWtmConfig, resolveTemplate, type TemplateContext, type WtmConfig } from '../../packages/core/src/index';

/**
 * todo.md item 32: the copyable configurations under `examples/` must not depend needlessly on a
 * Unix shell or on macOS-shaped paths. These checks run the real `@wtm/core` schema and template
 * resolver against every published example so a regression — a shell string reintroduced without
 * `shell = true`, a hard-coded `/Users/...`, a `cwd` that walks outside the worktree it was given
 * — fails here instead of surfacing on someone else's machine.
 */
const root = new URL('../../', import.meta.url);

/** Mirrors the checklist in todo.md item 32; a directory added there without a matching entry
 * here should fail loudly rather than silently skip validation. */
const exampleDirs = [
  'minimal', 'multi-repo', 'bun-monorepo', 'docker-compose', 'polyglot',
  'nextjs', 'nextjs-hono', 'python-uv', 'rust', 'go',
] as const;

interface LoadedExample {
  readonly dir: string;
  readonly path: string;
  readonly text: string;
  readonly config: WtmConfig;
}

async function loadExample(dir: string): Promise<LoadedExample> {
  const path = `examples/${dir}/wtm.toml`;
  const text = await readFile(new URL(path, root), 'utf8');
  return { dir, path, text, config: parseWtmConfig(parse(text), path) };
}

/** A command in argv form, or the single string form a shell-required task is allowed to use. */
type TaskCommand = string | string[];

function taskCommands(task: { run?: TaskCommand | undefined; main?: TaskCommand | undefined; worktree?: TaskCommand | undefined }): TaskCommand[] {
  return [task.run, task.main, task.worktree].filter((command): command is TaskCommand => command !== undefined);
}

/** Patterns that tie a configuration to one developer's machine rather than to `wtm.toml`'s own
 * template variables. Matched against the raw TOML text so nothing — `cwd`, `env`, a resource
 * `source`, a comment left over from a real path — slips past field-by-field inspection. */
const hardcodedPathPatterns: { name: string; pattern: RegExp }[] = [
  { name: '/tmp', pattern: /\/tmp(?:[/"']|$)/m },
  { name: '/Users/', pattern: /\/Users\// },
  { name: '/home/', pattern: /\/home\// },
  { name: '$HOME', pattern: /\$HOME/ },
  { name: '~/', pattern: /(?:^|[\s"'=])~\// },
  { name: 'C:\\', pattern: /C:\\/ },
];

/** Every hard-coded-path violation the raw config text contains, by name. Pure so the synthetic
 * negative-fixture test below can prove it actually fires before we trust it on the real files. */
function findHardcodedPaths(text: string): string[] {
  return hardcodedPathPatterns.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

/** Task names whose command is a shell string without `shell = true`, or an argv array with
 * `shell = true` — the second is already schema-invalid, but a config that instead used a plain
 * shell string to reach a single external command instead of the equivalent argv array is exactly
 * the "shell not required" violation item 32 calls out. */
function findUnnecessaryShellUsage(config: WtmConfig): string[] {
  const offenders: string[] = [];
  for (const [taskName, task] of Object.entries(config.tasks ?? {})) {
    for (const command of taskCommands(task)) {
      if (typeof command === 'string' && task.shell !== true) offenders.push(taskName);
      if (Array.isArray(command) && task.shell === true) offenders.push(taskName);
    }
  }
  return offenders;
}

const shellScriptExtension = /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd)$/i;

/** Missing-script and script-instead-of-argv violations, by description.
 *
 * Any argv token naming a script file must exist. A script invoked directly, as `argv[0]` with
 * no interpreter ahead of it, only runs on an OS that honors its shebang or registered file
 * association — item 32 asks for the underlying command to be called directly as an argv array
 * instead, unless the task is already documented as shell-required. A script named only as an
 * *argument* to an explicit interpreter (`["bash", "scripts/setup.sh"]`) is not this violation:
 * that is itself the "platform-specific example" item 32 allows for a genuinely shell-required
 * task — it still has to exist, but it does not have to be inlined as argv.
 */
function findScriptViolations(config: WtmConfig, exampleDir: URL): string[] {
  const violations: string[] = [];
  for (const [taskName, task] of Object.entries(config.tasks ?? {})) {
    for (const command of taskCommands(task)) {
      const argv = typeof command === 'string' ? command.split(/\s+/) : command;
      const scriptTokens = argv.filter((token) => shellScriptExtension.test(token));
      for (const script of scriptTokens) {
        if (!existsSync(new URL(script, exampleDir))) {
          violations.push(`task ${taskName} references missing script ${script}`);
        }
      }
      const first = argv[0];
      if (first !== undefined && shellScriptExtension.test(first) && task.shell !== true) {
        violations.push(`task ${taskName} execs ${first} directly; call the underlying command as an argv array, or invoke it through an explicit interpreter and document the POSIX/PowerShell variants`);
      }
    }
  }
  return violations;
}

const rootVariables = ['workspace', 'repo', 'main', 'worktree'] as const;
type RootVariable = (typeof rootVariables)[number];

/** Which `{<name>.root}` template a `cwd` is anchored to — whichever one appears first in the
 * string — or `undefined` for a `cwd` that names no WTM root at all, which is itself the
 * violation a hard-coded/relative path would produce. */
function anchorRoot(template: string): RootVariable | undefined {
  let found: { name: RootVariable; index: number } | undefined;
  for (const name of rootVariables) {
    const index = template.indexOf(`{${name}.root}`);
    if (index !== -1 && (found === undefined || index < found.index)) found = { name, index };
  }
  return found?.name;
}

function fakeContext(style: 'posix' | 'win32'): TemplateContext {
  const workspaceRoot = style === 'posix' ? '/home/dev/projects/example' : 'C:\\Users\\dev\\projects\\example';
  const sepChar = style === 'posix' ? '/' : '\\';
  return {
    workspace: { root: workspaceRoot, name: 'example' },
    repo: { root: `${workspaceRoot}${sepChar}repo`, name: 'repo' },
    main: { root: `${workspaceRoot}${sepChar}repo` },
    worktree: { root: `${workspaceRoot}${sepChar}repo-feature` },
    id: 3,
    key: 'repo:3',
    slug: 'repo-feature',
    branch: 'feat/examples',
    branchSlug: 'feat-examples',
    ports: {},
    cors: {},
    env: {},
  };
}

function rootOf(context: TemplateContext, variable: RootVariable): string {
  const root = context[variable]?.root;
  if (root === undefined) throw new Error(`fake context is missing ${variable}.root`);
  return root;
}

/** Whether `candidate` is `root` itself or a path inside it, using one path flavor's own
 * `resolve`/`relative`/`sep` throughout — the Windows check must never fall back to POSIX
 * semantics (or vice versa) partway through, or it would validate the wrong platform. */
function staysInside(
  flavor: { resolve: (...parts: string[]) => string; relative: (from: string, to: string) => string; sep: string },
  root: string,
  candidate: string,
): boolean {
  const child = flavor.relative(flavor.resolve(root), flavor.resolve(candidate));
  return child === '' || (!child.startsWith(`..${flavor.sep}`) && child !== '..');
}

const posixFlavor = { resolve: posixResolve, relative: posixRelative, sep: posixSep };
const win32Flavor = { resolve: win32Resolve, relative: win32Relative, sep: win32Sep };

/** Every `cwd` (explicit or defaulted to `{worktree.root}`) that either names no WTM root
 * template, or resolves outside the root it claims to be anchored to, on POSIX and on Windows. */
function findOutOfBoundsCwds(config: WtmConfig): string[] {
  const violations: string[] = [];
  for (const [taskName, task] of Object.entries(config.tasks ?? {})) {
    const template = task.cwd ?? '{worktree.root}';
    const variable = anchorRoot(template);
    if (variable === undefined) {
      violations.push(`task ${taskName} cwd "${template}" names no {workspace.root}/{worktree.root}/{repo.root}/{main.root} template`);
      continue;
    }
    for (const [label, context, flavor] of [
      ['POSIX', fakeContext('posix'), posixFlavor],
      ['Windows', fakeContext('win32'), win32Flavor],
    ] as const) {
      const resolvedCwd = resolveTemplate(template, context);
      if (!staysInside(flavor, rootOf(context, variable), resolvedCwd)) {
        violations.push(`task ${taskName} cwd "${template}" resolves outside its ${variable}.root on ${label}: ${resolvedCwd}`);
      }
    }
  }
  return violations;
}

describe('published examples stay portable across shells and platforms (todo item 32)', () => {
  test('the checklist covers every directory under examples/', async () => {
    const entries = await readdir(new URL('examples/', root), { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(directories).toEqual([...exampleDirs].sort());
  });

  for (const dir of exampleDirs) {
    test(`examples/${dir}/wtm.toml has no hard-coded /tmp, /Users, /home, $HOME, ~/, or C:\\ path`, async () => {
      const { text, path } = await loadExample(dir);
      expect(findHardcodedPaths(text), `${path} hard-codes a machine-specific path`).toEqual([]);
    });

    test(`examples/${dir}/wtm.toml tasks use argv arrays unless a task is explicitly shell = true`, async () => {
      const { config, path } = await loadExample(dir);
      expect(findUnnecessaryShellUsage(config), `${path} uses a shell string without declaring shell = true`).toEqual([]);
      // None of the published examples need a shell feature (piping, chaining, sourcing) today —
      // if that ever changes, item 32 requires the README to show POSIX and PowerShell variants
      // rather than inventing per-platform config syntax that does not exist in the schema.
      for (const task of Object.values(config.tasks ?? {})) expect(task.shell).not.toBe(true);
    });

    test(`examples/${dir}/wtm.toml has no shell script standing in for an argv command`, async () => {
      const { config, path } = await loadExample(dir);
      const exampleDir = new URL(`examples/${dir}/`, root);
      expect(findScriptViolations(config, exampleDir), path).toEqual([]);
    });

    test(`examples/${dir}/wtm.toml task cwd stays inside its declared root on POSIX and on Windows`, async () => {
      const { config, path } = await loadExample(dir);
      expect(findOutOfBoundsCwds(config), path).toEqual([]);
    });
  }
});

describe('the portability checks themselves catch real violations', () => {
  /**
   * None of the checked-in examples have ever contained a shell string, a hard-coded path, or an
   * out-of-bounds `cwd` (they were published portable from their first commit — see
   * `git log --follow -p -- examples/`), so there is no historical "before" state in this repo to
   * demonstrate a red-to-green transition against. These fixtures stand in for that: they exercise
   * the same pure functions the tests above run against the real files, against configurations
   * built to contain exactly the violations item 32 lists, so a change that quietly breaks a check
   * (for example, a pattern that stops matching) fails here instead of only ever seeing clean input.
   */
  test('findHardcodedPaths flags /tmp, /Users, /home, $HOME, ~/, and C:\\', () => {
    expect(findHardcodedPaths('cwd = "/tmp/build"')).toEqual(['/tmp']);
    expect(findHardcodedPaths('source = "/Users/dev/project/.env"')).toEqual(['/Users/']);
    expect(findHardcodedPaths('source = "/home/dev/project/.env"')).toEqual(['/home/']);
    expect(findHardcodedPaths('cwd = "$HOME/project"')).toEqual(['$HOME']);
    expect(findHardcodedPaths('cwd = "~/project"')).toEqual(['~/']);
    expect(findHardcodedPaths('cwd = "C:\\\\Users\\\\dev\\\\project"')).toEqual(['C:\\']);
    expect(findHardcodedPaths('run = ["npm", "test"]\ncwd = "{worktree.root}"')).toEqual([]);
  });

  test('findUnnecessaryShellUsage flags a shell string task not marked shell = true', () => {
    const shelled: WtmConfig = { tasks: { legacy: { run: 'make dev', shell: true } } };
    const portable: WtmConfig = { tasks: { test: { run: ['npm', 'test'] } } };
    expect(findUnnecessaryShellUsage(shelled)).toEqual([]);
    expect(findUnnecessaryShellUsage(portable)).toEqual([]);
    // A task built the same way parseWtmConfig would reject can still be constructed by hand here
    // (this test bypasses the schema on purpose) to prove the function itself, not just the
    // schema, would catch a string command with shell left unset.
    const unmarked = { tasks: { legacy: { run: 'make dev' } } } as unknown as WtmConfig;
    expect(findUnnecessaryShellUsage(unmarked)).toEqual(['legacy']);
  });

  test('findScriptViolations flags a missing script and a script used where argv would do', async () => {
    const exampleDir = new URL('examples/minimal/', root);
    const missing: WtmConfig = { tasks: { setup: { run: ['scripts/does-not-exist.sh'], shell: false } } };
    expect(findScriptViolations(missing, exampleDir)).toEqual([
      'task setup references missing script scripts/does-not-exist.sh',
      'task setup execs scripts/does-not-exist.sh directly; call the underlying command as an argv array, or invoke it through an explicit interpreter and document the POSIX/PowerShell variants',
    ]);
    const existingUnshelled: WtmConfig = { tasks: { setup: { run: ['wtm.toml'] } } };
    expect(findScriptViolations(existingUnshelled, exampleDir)).toEqual([]); // wtm.toml is not a script extension
    const shelled: WtmConfig = { tasks: { setup: { run: 'bash scripts/does-not-exist.sh', shell: true } } };
    expect(findScriptViolations(shelled, exampleDir)).toEqual([
      'task setup references missing script scripts/does-not-exist.sh',
    ]);
  });

  test('findOutOfBoundsCwds flags a cwd with no root template and one that escapes its root', () => {
    const noRoot: WtmConfig = { tasks: { test: { run: ['npm', 'test'], cwd: '/tmp/build' } } };
    const withRoot: WtmConfig = { tasks: { test: { run: ['npm', 'test'], cwd: '{worktree.root}' } } };
    const escaping: WtmConfig = { tasks: { test: { run: ['npm', 'test'], cwd: '{worktree.root}/../../../etc' } } };

    expect(findOutOfBoundsCwds(noRoot)).toEqual([
      'task test cwd "/tmp/build" names no {workspace.root}/{worktree.root}/{repo.root}/{main.root} template',
    ]);
    expect(findOutOfBoundsCwds(withRoot)).toEqual([]);
    const escapingViolations = findOutOfBoundsCwds(escaping);
    expect(escapingViolations).toHaveLength(2); // once for POSIX, once for Windows
    expect(escapingViolations[0]).toContain('POSIX');
    expect(escapingViolations[1]).toContain('Windows');
  });
});
