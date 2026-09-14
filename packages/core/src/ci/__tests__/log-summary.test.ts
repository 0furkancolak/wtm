import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ciLogSummaryMaxBytes, maskCiSecrets, summarizeFailedJobLog } from '../log-summary';

const line = (text: string, second = 0) => `Validate darwin x64\tUNKNOWN STEP\t2026-09-14T11:07:${String(second % 60).padStart(2, '0')}.0000000Z ${text}`;

describe('summarizeFailedJobLog', () => {
  test('keeps the failure far from the end of a real-shaped log', () => {
    const summary = summarizeFailedJobLog(readFileSync(new URL('./fixtures/failed-job.log', import.meta.url), 'utf8'));
    expect(summary).toContain('runtime-factory.test.ts:37:61');
    expect(summary).toContain('(fail) runtime factory > starts');
    expect(summary).toContain('##[error]Process completed with exit code 1.');
    expect(summary).not.toContain('UNKNOWN STEP');
    expect(summary).not.toContain('2026-09-14T11:07');
    expect(summary).not.toContain('Cleaning up orphan processes');
    expect(summary).toContain('…');
  });

  // The name avoids the literal error marker: GitHub Actions turns any log line containing it into a
  // failure annotation, so CI would report this passing test as an error.
  test('takes the 20 lines before each error marker and merges overlapping windows', () => {
    const lines = Array.from({ length: 60 }, (_, index) => line(`step ${index}`, index));
    lines[30] = line('##[error]first', 30);
    lines[35] = line('##[error]second', 35);
    const summary = summarizeFailedJobLog(lines.join('\n')).split('\n');
    expect(summary[0]).toBe('step 10');
    expect(summary.at(-1)).toBe('##[error]second');
    expect(summary.filter((entry) => entry === '…')).toEqual([]);
  });

  test('falls back to the last 40 lines without any marker', () => {
    const summary = summarizeFailedJobLog(Array.from({ length: 100 }, (_, index) => line(`plain ${index}`, index)).join('\n')).split('\n');
    expect(summary).toHaveLength(40);
    expect(summary[0]).toBe('plain 60');
    expect(summary.at(-1)).toBe('plain 99');
  });

  test('removes ANSI sequences and keeps lines that have no gh prefix', () => {
    expect(summarizeFailedJobLog('\u001b[31merror:\u001b[0m boom')).toBe('error: boom');
  });

  test('caps at 8 KiB keeping the end', () => {
    const long = Array.from({ length: 40 }, (_, index) => line(`${'x'.repeat(400)} ${index}`, index)).join('\n');
    const summary = summarizeFailedJobLog(long);
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(ciLogSummaryMaxBytes);
    expect(summary.startsWith('…\n')).toBe(true);
    expect(summary.endsWith(' 39')).toBe(true);
  });
});

describe('maskCiSecrets', () => {
  test.each([
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token [masked]'],
    ['gho_abcdefghijklmnopqrstuvwxyz and ghs_abcdefghijklmnopqrstuvwxyz', '[masked] and [masked]'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '[masked]'],
    ['key AKIAABCDEFGHIJKLMNOP end', 'key [masked] end'],
    ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: Bearer [masked]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter', '[masked]\nafter'],
    ['***', '***'],
  ])('%s', (input, expected) => {
    expect(maskCiSecrets(input)).toBe(expected);
  });
});
