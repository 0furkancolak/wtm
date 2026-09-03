import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runInternalMode } from '../internal';
import { daemonProgramArguments, runCli } from '../main';
import { runScenario } from '../../../testkit/src/scenario-child';

const cliEntry = fileURLToPath(new URL('../bin.ts', import.meta.url));
const publicGraphProbe = `data:text/javascript,${encodeURIComponent([
  "import { createRequire } from 'node:module';",
  'const require = createRequire(process.execPath);',
  "process.on('exit', () => {",
  "  const loaded = Object.keys(require.cache)",
  "    .filter((key) => key.includes('better-sqlite3') || key.includes('commander'));",
  '  process.stderr.write(`WTM_PUBLIC_GRAPH ${loaded.length}\\n`);',
  '});',
].join('\n'))}`;

function publicGraphModulesLoadedBy(argv: readonly string[]): number {
  const result = runScenario(
    'node',
    ['--import', 'tsx', '--import', publicGraphProbe, cliEntry, ...argv],
    { input: '' },
  );
  const match = /WTM_PUBLIC_GRAPH (\d+)/.exec(result.stderr);
  if (match === null) throw new Error(`probe did not report: ${result.stderr}`);
  return Number(match[1]);
}

describe('internal CLI dispatch', () => {
  test('keeps internal modes out of public help', async () => {
    let stdout = '';
    const exitCode = await runCli(['--help'], {
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('__wtm_internal_anchor');
    expect(stdout).not.toContain('__wtm_internal_adapter');
  });

  const malformedArgv = [
    ['__wtm_internal_anchor'],
    ['__wtm_internal_anchor', 'not-a-marker'],
    ['__wtm_internal_anchor', 'a'.repeat(64), 'extra'],
    ['__wtm_internal_adapter'],
    ['__wtm_internal_adapter', '2', 'adapter.mjs'],
    ['__wtm_internal_adapter', '3.5', 'adapter.mjs'],
    ['__wtm_internal_adapter', '3', '../adapter.mjs'],
    ['__wtm_internal_adapter', '3', 'adapter.mjs', 'extra'],
  ];
  for (const argv of malformedArgv) {
    test(`rejects malformed private argv without throwing: ${JSON.stringify(argv)}`, async () => {
      await expect(runInternalMode(argv)).resolves.toBeGreaterThan(0);
    });
  }

  test('returns null for public argv without constructing a private mode', async () => {
    await expect(runInternalMode(['status'])).resolves.toBeNull();
  });

  test('runs a private mode without loading the public CLI module graph', () => {
    expect(publicGraphModulesLoadedBy(['__wtm_internal_anchor', 'a'.repeat(64)])).toBe(0);
    expect(publicGraphModulesLoadedBy(['--version'])).toBeGreaterThan(0);
  });
});

describe('runtime-aware daemon argv', () => {
  test('appends daemon serve after an npm CLI prefix', () => {
    expect(daemonProgramArguments({ executable: '/opt/node', prefixArgs: ['/opt/wtm/bin.js'] }))
      .toEqual(['/opt/node', '/opt/wtm/bin.js', 'daemon', 'serve']);
  });

  test('appends daemon serve directly for a SEA executable', () => {
    expect(daemonProgramArguments({ executable: '/opt/wtm', prefixArgs: [] }))
      .toEqual(['/opt/wtm', 'daemon', 'serve']);
  });
});
