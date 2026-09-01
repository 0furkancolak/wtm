import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';

const cliEntry = fileURLToPath(new URL('../bin.ts', import.meta.url));

/**
 * Forces an error out of `runCli` that its own catch does not recognise. Commander writes the
 * version through the output hook, so a stdout that throws raises from inside `parseAsync`,
 * escapes the `CommanderError` branch, and reaches the entry point -- the same route any
 * unforeseen internal failure takes. The frames are written by hand because the frames that
 * reach a released binary's user name the machine that built it, not the machine running it.
 */
const throwingStdout = `data:text/javascript,${encodeURIComponent([
  "const write = process.stdout.write.bind(process.stdout);",
  "process.stdout.write = (chunk, ...rest) => {",
  "  if (typeof chunk === 'string' && chunk.includes('0.')) {",
  "    const error = new Error('The CLI could not write its output.');",
  "    error.stack = [",
  "      'Error: The CLI could not write its output.',",
  "      '    at run (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs:41337:19)',",
  "    ].join('\\n');",
  "    throw error;",
  "  }",
  "  return write(chunk, ...rest);",
  "};",
].join('\n'))}`;

describe('CLI entry point', () => {
  test('an unexpected failure escaping runCli is one line, not a trace', () => {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', '--import', throwingStdout, cliEntry, '--version'],
      { timeout: scenarioTimeoutMs, encoding: 'utf8', input: '' },
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain('/Users/runner');
      expect(stream).not.toContain('.cjs');
      expect(stream).not.toContain('    at ');
      expect(stream).not.toContain('triggerUncaughtException');
    }
    expect(result.stderr.trimEnd().split('\n')).toEqual(['The CLI could not write its output.']);
  }, scenarioTimeoutMs);

  test('a normal invocation is untouched by the catch-all', () => {
    const result = spawnSync('node', ['--import', 'tsx', cliEntry, '--version'], {
      timeout: scenarioTimeoutMs,
      encoding: 'utf8',
      input: '',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, scenarioTimeoutMs);
});
