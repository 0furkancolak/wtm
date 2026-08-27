import { expect, it } from 'bun:test';
import { createAdapterFixture } from './fixture';
import { detectBuiltInAdapters } from '../registry';

it('surfaces multiple JavaScript lockfiles as deterministic capability ambiguity', async () => {
  const fixture = await createAdapterFixture({
    'bun.lock': '{"lockfileVersion": 1}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'package-lock.json': '{"lockfileVersion": 3}\n',
  });
  try {
    const first = await detectBuiltInAdapters(fixture.context);
    const second = await detectBuiltInAdapters(fixture.context);

    expect(first.detected.map(({ metadata }) => metadata.id)).toEqual(['bun', 'pnpm', 'npm']);
    expect(first.active).toEqual([]);
    expect(first.findings).toEqual([
      {
        code: 'ADAPTER_DETECTION_AMBIGUOUS',
        message: 'Capability javascript.package-manager has multiple detected providers: bun, pnpm, npm.',
        severity: 'error',
        context: {
          capability: 'javascript.package-manager',
          providers: ['bun', 'pnpm', 'npm'],
        },
      },
    ]);
    expect(second.findings).toEqual(first.findings);
  } finally {
    await fixture.cleanup();
  }
});

it('deactivates Next.js when its required package-manager capability is missing', async () => {
  const fixture = await createAdapterFixture({
    'next.config.mjs': 'export default {};\n',
  });
  try {
    const graph = await detectBuiltInAdapters(fixture.context);

    expect(graph.detected.map(({ metadata }) => metadata.id)).toEqual(['next']);
    expect(graph.active).toEqual([]);
    expect(graph.findings).toEqual([
      {
        code: 'ADAPTER_PLAN_CONFLICT',
        message: 'Adapter next requires active capability javascript.package-manager.',
        severity: 'error',
        context: { adapter: 'next', capability: 'javascript.package-manager' },
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it('keeps Next.js active when exactly one package-manager provider is active', async () => {
  const fixture = await createAdapterFixture({
    'bun.lock': '{"lockfileVersion": 1}\n',
    'next.config.mjs': 'export default {};\n',
  });
  try {
    const graph = await detectBuiltInAdapters(fixture.context);

    expect(graph.active.map(({ metadata }) => metadata.id)).toEqual(['bun', 'next']);
    expect(graph.findings).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

it('deactivates Next.js after ambiguous package-manager providers are disabled', async () => {
  const fixture = await createAdapterFixture({
    'bun.lock': '{"lockfileVersion": 1}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'next.config.mjs': 'export default {};\n',
  });
  try {
    const graph = await detectBuiltInAdapters(fixture.context);

    expect(graph.detected.map(({ metadata }) => metadata.id)).toEqual(['bun', 'pnpm', 'next']);
    expect(graph.active).toEqual([]);
    expect(graph.findings).toEqual([
      {
        code: 'ADAPTER_DETECTION_AMBIGUOUS',
        message: 'Capability javascript.package-manager has multiple detected providers: bun, pnpm.',
        severity: 'error',
        context: {
          capability: 'javascript.package-manager',
          providers: ['bun', 'pnpm'],
        },
      },
      {
        code: 'ADAPTER_PLAN_CONFLICT',
        message: 'Adapter next requires active capability javascript.package-manager.',
        severity: 'error',
        context: { adapter: 'next', capability: 'javascript.package-manager' },
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});
