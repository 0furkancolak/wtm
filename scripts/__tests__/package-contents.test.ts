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
  // The standalone executable embeds a whole Node runtime; shipping it inside the npm package
  // would multiply the download for consumers who already have Node.
  for (const excluded of ['dist/sea/wtm', 'dist/release/SHA256SUMS', 'dist/release/wtm-darwin-arm64.tar.gz'])
    expect(files).not.toContain(excluded);
  expect(files.filter((path) => path.endsWith('.tar.gz'))).toEqual([]);
  // `bin` and `main` both resolve inside dist/cli, which is bundled; the other outputs are build
  // byproducts, and the superpowers directory is this project's own planning ledger.
  for (const directory of ['dist/protocol/', 'dist/core/', 'dist/adapters/', 'dist/daemon/', 'docs/superpowers/'])
    expect(files.filter((path) => path.startsWith(directory))).toEqual([]);
  // One field of the manifest is public; the dependency and script blocks are not. The
  // identifier itself appears in adapter source that reads a project's own package.json,
  // so the guard looks for the JSON shape a bundled manifest would take.
  const bundle = readFileSync('dist/cli/bin.js', 'utf8');
  for (const manifestKey of ['"devDependencies"', '"dependencies"', '"scripts"', '"trustedDependencies"'])
    expect(bundle).not.toContain(manifestKey);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.dependencies.commander).toBe('14.0.2');
  // `os` is a promise to npm, and it is the one field in this manifest that nothing else checks:
  // `npm pack` does not enforce it, so a wrong value is silent here and `EBADPLATFORM` for the
  // person installing. It is pinned to the platforms CI actually runs, which is what makes it a
  // claim the build can check rather than an intention. Adding a platform here without adding its
  // job below is the failure this is here to stop.
  expect(manifest.os).toEqual(['darwin', 'linux']);
  const ci = Bun.YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: { validate: { strategy: { matrix: { include: { platform: string }[] } } } };
  };
  const validated = [...new Set(ci.jobs.validate.strategy.matrix.include.map(({ platform }) => platform))];
  expect(validated.sort()).toEqual([...manifest.os].sort());
  const thirdParty = readFileSync('THIRD_PARTY_LICENSES.md', 'utf8');
  for (const copyright of [
    'Copyright (c) 2011 TJ Holowaychuk',
    'Copyright (c) 2025 Colin McDonnell',
    'Copyright (c) Squirrel Chat et al., All rights reserved.',
  ]) expect(thirdParty).toContain(copyright);
}, 30_000);
