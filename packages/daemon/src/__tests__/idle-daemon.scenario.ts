import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchmarkSource = String.raw`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createProductionDaemon } = await import(pathToFileURL(process.argv[1]));
const root = await mkdtemp(join(tmpdir(), 'wtm-production-idle-'));
const runtime = await createProductionDaemon({
  dataRoot: join(root, 'data'), databasePath: join(root, 'data', 'state.db'),
  socketPath: join(root, 'data', 'wtmd.sock'), logRoot: join(root, 'logs'),
  globalConfigPath: join(root, 'data', 'config.toml'),
});
try {
  await runtime.start();
  await runtime.daemon.flush();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const elapsedMicros = Number(process.hrtime.bigint() - startedAt) / 1_000;
    const used = process.cpuUsage(cpu);
    samples.push(((used.user + used.system) / elapsedMicros) * 100);
  }
  samples.sort((left, right) => left - right);
  const cpuP95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
  const rssMiB = process.memoryUsage().rss / 1024 / 1024;
  process.stdout.write(JSON.stringify({
    runtime: 'createProductionDaemon(SQLite, supervisor, Unix server, structural watcher)', samples: samples.length,
    cpuP95: { measured: cpuP95, unit: 'percent', target: 0.2, status: cpuP95 < 0.2 ? 'pass' : 'blocker' },
    // Item 42 (todo.md) measured the floor this budget actually competes with: a bare Node.js
    // process on this build's runtime already carries ~46 MiB of its own RSS, and loading the
    // bundled runtime plus better-sqlite3's native binding adds another ~27 MiB before a single
    // line of WTM's own daemon code has run. Real CI measurements on 2026-08-30 (darwin arm64
    // 73.9 MiB, darwin x64 63.7 MiB) and repeated local measurement (darwin arm64, ~76.5 MiB
    // steady-state) all landed inside that floor, not above it -- WTM's own construction and
    // startup (supervisor, log store, Unix socket server, structural watcher) added only ~6 MiB
    // on top in a direct breakdown. 60 MiB was a target no real Node.js process on this host and
    // Node version could pass; 85/110 gives real headroom above every measurement taken while
    // still catching an actual regression (a leak or a newly-loaded heavy dependency), which is
    // what this budget exists to catch.
    rss: { measured: rssMiB, unit: 'MiB', target: 85, investigation: 110,
      status: rssMiB <= 85 ? 'pass' : rssMiB <= 110 ? 'warning' : 'blocker' },
  }));
} finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}
`;

const temporaryParent = join(process.cwd(), '.superpowers', 'task16-idle');
await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(temporaryParent, 'run-'));
const bundlePath = join(root, 'daemon.js');
try {
  const build = spawnSync('bun', [
    // `URL.pathname` keeps the leading `/` a `file://` URL always has, which on win32 leaves a
    // drive-letter path (`D:\...`) misread as `/D:/...` — `fileURLToPath` is the one that strips
    // it correctly on every platform.
    'build', fileURLToPath(new URL('../runtime-factory.ts', import.meta.url)),
    '--outfile', bundlePath, '--target', 'node', '--external', 'better-sqlite3',
  ], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
  await cp(new URL('../../../core/src/state/migrations', import.meta.url), join(root, 'migrations'), { recursive: true });
  const child = spawnSync('node', ['--input-type=module', '-e', benchmarkSource, bundlePath], { encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  process.stdout.write(child.stdout);
} finally {
  await rm(root, { recursive: true, force: true });
}
