import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineBuiltInAdapter, detectMarkers } from './built-in';

/** GNU make reads the first of these that exists, and so does this adapter. */
export const makefileNames = ['GNUmakefile', 'makefile', 'Makefile'] as const;

/**
 * Detection reports the marker it matched, and a case-insensitive filesystem matches every
 * spelling, so evidence is looked up in the order a reader expects to see named back.
 */
const detectionMarkers = ['Makefile', 'makefile', 'GNUmakefile'] as const;

/**
 * A target name reaches `make` as an argument and a WTM task as part of its name, so only
 * plain names are surfaced. Pattern rules, variable references, and the dot-prefixed
 * special targets (`.PHONY`, `.DEFAULT_GOAL`, …) never name work a person would run.
 */
const targetName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** A rule line, as distinct from `NAME := value`, a recipe line, or a conditional. */
const ruleLine = /^([^\t#=][^#=]*?)::?(?!=)(?:\s(.*))?$/;
/** The self-documenting convention: `target: deps ## what it does`. */
const inlineDescription = /##\s*(.+?)\s*$/;
/** A Makefile can declare hundreds of targets; a plan stays readable well before that. */
const maxTargets = 64;

export interface MakeTarget {
  name: string;
  description?: string;
}

export const makeAdapter = defineBuiltInAdapter({
  metadata: {
    id: 'make',
    name: 'Make',
    version: '1.2.0',
    kind: 'task-runner',
    provides: ['make.task-runner'],
  },
  detect: async (context) => {
    const worktree = await detectMarkers(context.worktree.root, [...detectionMarkers]);
    if (worktree.detected || !hasSeparateWorkspace(context)) return worktree;
    // A root holding several repositories often keeps the commands that span them in its own
    // Makefile, and nothing else there marks it as a project. Without this, that Makefile is
    // reachable from no worktree at all.
    return await detectMarkers(context.workspace.root, [...detectionMarkers]);
  },
  plan: async (context) => {
    const tasks: Record<string, AdapterMakeTask> = {};
    const makefile = await locateMakefile(context.worktree.root);
    if (makefile !== null) {
      tasks.make = { description: 'Run the default goal', run: ['make'], cwd: '{worktree.root}' };
      for (const target of parseMakeTargets(makefile.contents)) {
        tasks[`make:${target.name}`] = makeTask(target, '{worktree.root}');
      }
    }
    if (hasSeparateWorkspace(context)) {
      const workspaceMakefile = await locateMakefile(context.workspace.root);
      if (workspaceMakefile !== null) {
        for (const target of parseMakeTargets(workspaceMakefile.contents)) {
          // Workspace targets keep their own namespace: they run at the root, across every
          // repository, and a repository's own `dev` is not the same work as the root's.
          tasks[`workspace:${target.name}`] = makeTask(target, '{workspace.root}');
          // The "here" family runs the very same root target, but with the worktree — not the
          // workspace root — as `cwd`. This is what closes item 48: a root `dev` that shells out
          // to a per-repository command (`cd api && npm run dev`) resolves that path against the
          // wrong root when it isn't asked to run from inside the worktree it's meant to serve.
          tasks[`workspace-here:${target.name}`] = makeWorkspaceHereTask(target, workspaceMakefile.name);
        }
      }
    }
    return { resources: [], actions: [], capabilities: {}, tasks };
  },
});

interface AdapterMakeTask {
  description?: string;
  run: string[];
  cwd: string;
  env?: Record<string, string>;
}

function makeTask(target: MakeTarget, cwd: string): AdapterMakeTask {
  return {
    ...(target.description === undefined ? {} : { description: target.description }),
    run: ['make', target.name],
    cwd,
  };
}

/**
 * Runs a root-Makefile target with the worktree as `cwd` instead of the workspace root, via
 * `make -f <workspace makefile> <target>` rather than copying or symlinking the file. `-f` takes
 * an explicit path so `make`'s own file resolution (which only ever looks in `cwd`) never runs:
 * without it, a worktree that also has its own Makefile would silently shadow the root one.
 *
 * Only `WTM_WORKTREE_ROOT`/`WTM_WORKSPACE_ROOT` are injected (K5) — a Makefile that breaks on a
 * relative path (`$(ROOT_DIR)`, `../.cache/state`) has exactly these two variables to rewrite
 * itself in terms of; WTM does not guess at anything more specific.
 */
function makeWorkspaceHereTask(target: MakeTarget, makefileName: string): AdapterMakeTask {
  return {
    ...(target.description === undefined ? {} : { description: target.description }),
    run: ['make', '-f', `{workspace.root}/${makefileName}`, target.name],
    cwd: '{worktree.root}',
    env: { WTM_WORKTREE_ROOT: '{worktree.root}', WTM_WORKSPACE_ROOT: '{workspace.root}' },
  };
}

function hasSeparateWorkspace(context: { workspace: { root: string }; worktree: { root: string } }): boolean {
  return context.workspace.root !== context.worktree.root;
}

/**
 * Which of `makefileNames` `make` itself would read in `root`, and its contents — or null if
 * none exists. The filename is kept alongside the contents because `workspace-here:<target>`
 * needs it to build an explicit `-f` path rather than relying on `make`'s own cwd-relative file
 * resolution.
 */
async function locateMakefile(root: string): Promise<{ name: string; contents: string } | null> {
  for (const name of makefileNames) {
    try {
      return { name, contents: await readFile(join(root, name), 'utf8') };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * GNU Make joins a line ending in `\` with the one after it (the pair is replaced by a single
 * space) before it ever parses a rule -- so a rule can spread its *target* list across lines,
 * not just its prerequisite list:
 * ```
 * foo bar \
 *     baz: dep
 * ```
 * defines three targets. Splitting on raw newlines without this join first turns that into two
 * independent lines -- "foo bar \" (no colon, not a rule) and "    baz: dep" (a rule of its own)
 * -- silently dropping `foo` and `bar`. A continuation split only in the *prerequisite* list
 * already worked before this, since the target/colon sits on the rule's first physical line.
 */
function joinLineContinuations(contents: string): string {
  return contents.replace(/\\\r?\n/g, ' ');
}

export function parseMakeTargets(contents: string): MakeTarget[] {
  const targets = new Map<string, MakeTarget>();
  let inDefine = false;
  for (const rawLine of joinLineContinuations(contents).split(/\r?\n/)) {
    // A recipe line belongs to the shell, not to make's own grammar.
    if (rawLine.startsWith('\t')) continue;
    const line = rawLine.trim();
    if (inDefine) {
      if (/^endef\b/.test(line)) inDefine = false;
      continue;
    }
    if (/^define\b/.test(line)) { inDefine = true; continue; }
    if (line === '' || line.startsWith('#')) continue;

    const rule = ruleLine.exec(line);
    if (rule === null) continue;
    const description = inlineDescription.exec(rule[2] ?? '')?.[1];
    for (const candidate of (rule[1] ?? '').trim().split(/\s+/)) {
      if (!targetName.test(candidate) || targets.has(candidate)) continue;
      targets.set(candidate, description === undefined ? { name: candidate } : { name: candidate, description });
      if (targets.size >= maxTargets) return [...targets.values()];
    }
  }
  return [...targets.values()];
}
