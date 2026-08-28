import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('the public npm package contains runtime bundles, migrations, docs, license, and the agent skill', () => {
  const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8' });
  expect(build.status, build.stderr || build.stdout).toBe(0);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr || packed.stdout).toBe(0);
  const files = (JSON.parse(packed.stdout)[0].files as Array<{ path: string }>).map(({ path }) => path);
  for (const required of [
    'LICENSE', 'THIRD_PARTY_LICENSES.md', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
    'dist/cli/bin.js', 'dist/cli/index.js',
    'dist/cli/migrations/001-initial.sql', 'dist/cli/skills/wtm/SKILL.md',
  ]) expect(files).toContain(required);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.dependencies.commander).toBe('14.0.2');
  const thirdParty = readFileSync('THIRD_PARTY_LICENSES.md', 'utf8');
  for (const copyright of [
    'Copyright (c) 2011 TJ Holowaychuk',
    'Copyright (c) 2025 Colin McDonnell',
    'Copyright (c) Squirrel Chat et al., All rights reserved.',
  ]) expect(thirdParty).toContain(copyright);
}, 30_000);
