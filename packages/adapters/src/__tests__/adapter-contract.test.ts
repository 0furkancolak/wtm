import { describe, expect, it } from 'bun:test';
import {
  adapterMetadataSchema,
  adapterPlanSchema,
  detectionResultSchema,
  doctorCheckSchema,
} from '@wtm/protocol';
import { createAdapterFixture } from './fixture';
import { builtInAdapters } from '../registry';

const isolatedMutableResources: Record<string, string[]> = {
  bun: ['node_modules'],
  pnpm: ['node_modules'],
  npm: ['node_modules'],
  next: ['.next'],
  uv: ['.venv'],
  cargo: ['target'],
};

describe('built-in adapter contract', () => {
  it('validates every metadata, detect, plan, and doctor result with protocol schemas', async () => {
    const fixture = await createAdapterFixture();
    try {
      for (const adapter of builtInAdapters) {
        const detection = await adapter.detect(fixture.context);
        const plan = await adapter.plan(fixture.context);
        expect(() => adapterMetadataSchema.parse(adapter.metadata())).not.toThrow();
        expect(() => detectionResultSchema.parse(detection)).not.toThrow();
        expect(() => adapterPlanSchema.parse(plan)).not.toThrow();
        for (const check of await adapter.doctor(fixture.context)) {
          expect(() => doctorCheckSchema.parse(check)).not.toThrow();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps mutable outputs isolated and never proposes symlinks for them', async () => {
    const fixture = await createAdapterFixture();
    try {
      for (const adapter of builtInAdapters) {
        const metadata = adapter.metadata();
        const plan = await adapter.plan(fixture.context);
        const expectedPaths = isolatedMutableResources[metadata.id] ?? [];

        for (const path of expectedPaths) {
          expect(plan.resources).toContainEqual(expect.objectContaining({ path, policy: 'isolated' }));
          expect(plan.actions).not.toContainEqual(expect.objectContaining({ type: 'symlink', target: path }));
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('expresses framework dependencies and package-manager selection through capabilities', () => {
    const metadata = builtInAdapters.map((adapter) => adapter.metadata());
    const next = metadata.find(({ id }) => id === 'next');
    const packageManagers = metadata
      .filter(({ provides }) => provides.includes('javascript.package-manager'))
      .map(({ id }) => id);

    expect(next?.requires).toEqual(['javascript.package-manager']);
    expect(packageManagers).toEqual(['bun', 'pnpm', 'npm']);
  });

  it('does not mutate repository files during detection or planning', async () => {
    const fixture = await createAdapterFixture({
      'Makefile': 'all:\n\t@true\n',
      'bun.lock': '{"lockfileVersion": 1}\n',
      'next.config.mjs': 'export default {};\n',
      'uv.lock': 'version = 1\n',
      'Cargo.toml': '[package]\nname = "fixture"\n',
      'go.mod': 'module example.invalid/fixture\n',
      'compose.yaml': 'services: {}\n',
    });
    try {
      const before = await fixture.snapshot();
      for (const adapter of builtInAdapters) {
        await adapter.detect(fixture.context);
        await adapter.plan(fixture.context);
      }

      expect(await fixture.snapshot()).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('contributes Make and Compose runtime commands as controlled tasks', async () => {
    const fixture = await createAdapterFixture();
    try {
      const make = builtInAdapters.find((adapter) => adapter.metadata().id === 'make');
      const compose = builtInAdapters.find((adapter) => adapter.metadata().id === 'docker-compose');
      const makePlan = await make?.plan(fixture.context);
      const composePlan = await compose?.plan(fixture.context);

      expect(makePlan?.tasks).toEqual({
        make: { description: 'Run the default goal', run: ['make'], cwd: '{worktree.root}' },
      });
      expect(composePlan?.tasks).toEqual({
        'compose-up': {
          run: ['docker', 'compose', 'up'],
          cwd: '{worktree.root}',
          background: true,
          singleton: true,
        },
      });
      expect(composePlan?.actions).not.toContainEqual(
        expect.objectContaining({ type: 'exec', argv: ['docker', 'compose', 'up'] }),
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
