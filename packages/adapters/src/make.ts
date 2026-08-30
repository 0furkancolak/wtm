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
    const tasks: Record<string, { description?: string; run: string[]; cwd: string }> = {};
    const makefile = await readMakefile(context.worktree.root);
    if (makefile !== null) {
      tasks.make = { description: 'Run the default goal', run: ['make'], cwd: '{worktree.root}' };
      for (const target of parseMakeTargets(makefile)) {
        tasks[`make:${target.name}`] = makeTask(target, '{worktree.root}');
      }
    }
    if (hasSeparateWorkspace(context)) {
      // Workspace targets keep their own namespace: they run at the root, across every
      // repository, and a repository's own `dev` is not the same work as the root's.
      for (const target of await readMakeTargets(context.workspace.root)) {
        tasks[`workspace:${target.name}`] = makeTask(target, '{workspace.root}');
      }
    }
    return { resources: [], actions: [], capabilities: {}, tasks };
  },
});

function makeTask(target: MakeTarget, cwd: string): { description?: string; run: string[]; cwd: string } {
  return {
    ...(target.description === undefined ? {} : { description: target.description }),
    run: ['make', target.name],
    cwd,
  };
}

function hasSeparateWorkspace(context: { workspace: { root: string }; worktree: { root: string } }): boolean {
  return context.workspace.root !== context.worktree.root;
}

/**
 * Reads the worktree's makefile and returns the targets it declares. The file is parsed,
 * never evaluated: running `make -p` to enumerate targets would execute the `$(shell …)`
 * expansions of a repository WTM has not been told to trust.
 */
export async function readMakeTargets(root: string): Promise<MakeTarget[]> {
  const contents = await readMakefile(root);
  return contents === null ? [] : parseMakeTargets(contents);
}

/** The contents of the makefile `make` itself would read in `root`, or null if there is none. */
export async function readMakefile(root: string): Promise<string | null> {
  for (const name of makefileNames) {
    try {
      return await readFile(join(root, name), 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

export function parseMakeTargets(contents: string): MakeTarget[] {
  const targets = new Map<string, MakeTarget>();
  let inDefine = false;
  for (const rawLine of contents.split(/\r?\n/)) {
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
