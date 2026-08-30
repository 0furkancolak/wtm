import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { builtInAdapters } from '../registry';
import { parseMakeTargets } from '../make';
import { createAdapterFixture } from './fixture';

const makeAdapter = builtInAdapters.find((adapter) => adapter.metadata().id === 'make');

describe('make target parsing', () => {
  it('reads plain targets and their self-documenting descriptions', () => {
    expect(parseMakeTargets([
      'build: ## Bundle the packages',
      '\t$(BUN) run build',
      'test:',
      '\tbun test',
    ].join('\n'))).toEqual([
      { name: 'build', description: 'Bundle the packages' },
      { name: 'test' },
    ]);
  });

  it('reads every target a single rule declares', () => {
    expect(parseMakeTargets('lint typecheck: deps\n\t@true\n').map((target) => target.name))
      .toEqual(['lint', 'typecheck']);
  });

  it('never mistakes an assignment for a rule', () => {
    expect(parseMakeTargets([
      'PREFIX ?= $(HOME)/.local',
      'BINARY := dist/sea/wtm',
      'FLAGS += -Wall',
      'export TOKEN = value',
      'run:',
      '\t@true',
    ].join('\n'))).toEqual([{ name: 'run' }]);
  });

  it('skips pattern rules, variable targets, and special targets', () => {
    expect(parseMakeTargets([
      '.PHONY: all clean',
      '.DEFAULT_GOAL := help',
      '%.o: %.c',
      '\t$(CC) -c $<',
      '$(BINARY): sources',
      '\t@true',
      'all:',
      '\t@true',
    ].join('\n'))).toEqual([{ name: 'all' }]);
  });

  it('ignores rule-shaped lines inside a define block', () => {
    expect(parseMakeTargets([
      'define template',
      'fake: not-a-real-target',
      'endef',
      'real:',
      '\t@true',
    ].join('\n'))).toEqual([{ name: 'real' }]);
  });

  it('keeps double-colon rules and drops comment lines', () => {
    expect(parseMakeTargets('# clean:\nclean:: ## Remove output\n\trm -rf dist\n'))
      .toEqual([{ name: 'clean', description: 'Remove output' }]);
  });

  it('bounds how many targets one Makefile contributes', () => {
    const source = Array.from({ length: 200 }, (_, index) => `target${index}:\n\t@true`).join('\n');
    expect(parseMakeTargets(source)).toHaveLength(64);
  });
});

describe('make adapter plan', () => {
  it('offers each declared target as its own task', async () => {
    const fixture = await createAdapterFixture({
      Makefile: 'dev: ## Start the dev server\n\tbun run dev\nbuild:\n\tbun run build\n',
    });
    try {
      expect((await makeAdapter?.plan(fixture.context))?.tasks).toEqual({
        make: { description: 'Run the default goal', run: ['make'], cwd: '{worktree.root}' },
        'make:dev': {
          description: 'Start the dev server',
          run: ['make', 'dev'],
          cwd: '{worktree.root}',
        },
        'make:build': { run: ['make', 'build'], cwd: '{worktree.root}' },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('prefers GNUmakefile over Makefile, as make itself does', async () => {
    const fixture = await createAdapterFixture({
      GNUmakefile: 'gnu:\n\t@true\n',
      Makefile: 'plain:\n\t@true\n',
    });
    try {
      expect(Object.keys((await makeAdapter?.plan(fixture.context))?.tasks ?? {}))
        .toEqual(['make', 'make:gnu']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('contributes nothing when neither the worktree nor the workspace has a makefile', async () => {
    const fixture = await createAdapterFixture();
    try {
      expect(Object.keys((await makeAdapter?.plan(fixture.context))?.tasks ?? {})).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('offers the workspace root makefile under its own namespace', async () => {
    const fixture = await createAdapterFixture({ Makefile: 'dev:\n\t@true\n' });
    try {
      await writeFile(join(fixture.context.workspace.root, 'Makefile'), 'up: ## Bring the stack up\n\t@true\n');
      const plan = await makeAdapter?.plan(fixture.context);

      expect(plan?.tasks['make:dev']).toEqual({ run: ['make', 'dev'], cwd: '{worktree.root}' });
      expect(plan?.tasks['workspace:up']).toEqual({
        description: 'Bring the stack up',
        run: ['make', 'up'],
        cwd: '{workspace.root}',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('detects a workspace root makefile from a worktree that has none', async () => {
    const fixture = await createAdapterFixture();
    try {
      await writeFile(join(fixture.context.workspace.root, 'Makefile'), 'up:\n\t@true\n');

      expect((await makeAdapter?.detect(fixture.context))?.detected).toBe(true);
      expect(Object.keys((await makeAdapter?.plan(fixture.context))?.tasks ?? {})).toEqual(['workspace:up']);
    } finally {
      await fixture.cleanup();
    }
  });
});
