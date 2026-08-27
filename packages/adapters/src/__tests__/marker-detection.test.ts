import { describe, expect, it } from 'bun:test';
import { createAdapterFixture } from './fixture';
import { detectBuiltInAdapters } from '../registry';

const markerCases = [
  { id: 'make', marker: 'Makefile', contents: 'all:\n\t@true\n' },
  { id: 'bun', marker: 'bun.lock', contents: '{"lockfileVersion": 1}\n' },
  { id: 'pnpm', marker: 'pnpm-lock.yaml', contents: 'lockfileVersion: 9\n' },
  { id: 'npm', marker: 'package-lock.json', contents: '{"lockfileVersion": 3}\n' },
  { id: 'next', marker: 'next.config.mjs', contents: 'export default {};\n' },
  { id: 'uv', marker: 'uv.lock', contents: 'version = 1\n' },
  { id: 'cargo', marker: 'Cargo.toml', contents: '[package]\nname = "fixture"\n' },
  { id: 'go', marker: 'go.mod', contents: 'module example.invalid/fixture\n' },
  { id: 'docker-compose', marker: 'compose.yaml', contents: 'services: {}\n' },
] as const;

describe('built-in marker detection', () => {
  for (const markerCase of markerCases) {
    it(`detects ${markerCase.id} from ${markerCase.marker}`, async () => {
      const fixture = await createAdapterFixture({ [markerCase.marker]: markerCase.contents });
      try {
        const graph = await detectBuiltInAdapters(fixture.context);

        expect(graph.detected.map(({ metadata }) => metadata.id)).toEqual([markerCase.id]);
        expect(graph.detected[0]?.detection.evidence).toEqual([{ kind: 'file', value: markerCase.marker }]);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it('detects Python pip and virtualenv fallback evidence without an uv lockfile', async () => {
    const fixture = await createAdapterFixture({
      'requirements.txt': 'httpx==0.28.1\n',
      '.venv/pyvenv.cfg': 'home = /usr/bin\n',
    });
    try {
      const graph = await detectBuiltInAdapters(fixture.context);
      const uv = graph.detected.find(({ metadata }) => metadata.id === 'uv');

      expect(uv?.detection).toEqual({
        detected: true,
        confidence: 0.6,
        evidence: [
          { kind: 'file', value: 'requirements.txt' },
          { kind: 'file', value: '.venv/pyvenv.cfg' },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('detects Next.js from a validated package.json dependency when no config file exists', async () => {
    const fixture = await createAdapterFixture({
      'package.json': '{"dependencies":{"next":"16.1.0"}}\n',
    });
    try {
      const graph = await detectBuiltInAdapters(fixture.context);
      const next = graph.detected.find(({ metadata }) => metadata.id === 'next');

      expect(next?.detection.evidence).toEqual([{ kind: 'package-json-dependency', value: 'next' }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not use malformed package.json data for Next.js detection', async () => {
    const fixture = await createAdapterFixture({ 'package.json': '{not-json}\n' });
    try {
      const graph = await detectBuiltInAdapters(fixture.context);

      expect(graph.detected.some(({ metadata }) => metadata.id === 'next')).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores marker-shaped directories when detecting package managers', async () => {
    const fixture = await createAdapterFixture({
      'bun.lock': '{"lockfileVersion": 1}\n',
      'package-lock.json': null,
    });
    try {
      const graph = await detectBuiltInAdapters(fixture.context);

      expect(graph.detected.map(({ metadata }) => metadata.id)).toEqual(['bun']);
      expect(graph.active.map(({ metadata }) => metadata.id)).toEqual(['bun']);
      expect(graph.findings).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('detects uv configuration and Go workspaces from their native markers', async () => {
    const fixture = await createAdapterFixture({
      'pyproject.toml': '[project]\nname = "fixture"\n[tool.uv]\nmanaged = true\n',
      'go.work': 'go 1.24\nuse ./service\n',
    });
    try {
      const graph = await detectBuiltInAdapters(fixture.context);

      expect(graph.detected.map(({ metadata }) => metadata.id)).toEqual(['uv', 'go']);
      expect(graph.detected.map(({ detection }) => detection.evidence)).toEqual([
        [{ kind: 'file', value: 'pyproject.toml' }],
        [{ kind: 'file', value: 'go.work' }],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('activates a polyglot graph in deterministic registry order', async () => {
    const fixture = await createAdapterFixture(Object.fromEntries(
      markerCases
        .filter(({ id }) => id !== 'pnpm' && id !== 'npm')
        .map(({ marker, contents }) => [marker, contents]),
    ));
    try {
      const graph = await detectBuiltInAdapters(fixture.context);

      expect(graph.findings).toEqual([]);
      expect(graph.active.map(({ metadata }) => metadata.id)).toEqual([
        'make', 'bun', 'next', 'uv', 'cargo', 'go', 'docker-compose',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
