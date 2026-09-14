export const ciLogSummaryMaxBytes = 8192;

const errorWindow = 20;
const fallbackLines = 40;
/** `gh run view --log-failed` prints `<job>\t<step>\t<timestamp> <text>` per line. */
const ghPrefix = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?)?/;
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const testFailure = /\(fail\)|FAIL |✗|error:/;

const secretPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[masked]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[masked]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[masked]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[masked]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [masked]'],
];

/** GitHub already masks registered secrets as `***`; this catches well-known token shapes too. */
export function maskCiSecrets(text: string): string {
  return secretPatterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

/**
 * A short excerpt of a failed job's log: each `##[error]` line with the 20 lines before it, and
 * every test-runner failure line, in log order; the last 40 lines when neither exists. The end of
 * such a log is usually post-job cleanup, so the tail alone rarely shows the failure.
 */
export function summarizeFailedJobLog(raw: string): string {
  const normalized = raw.split(/\r?\n/).map((entry) => entry.replace(ghPrefix, '').replace(ansi, ''));
  while (normalized.length > 0 && normalized.at(-1) === '') normalized.pop();
  const lines = maskCiSecrets(normalized.join('\n')).split('\n');
  const ranges: Array<[number, number]> = [];
  lines.forEach((text, index) => {
    if (text.includes('##[error]')) ranges.push([Math.max(0, index - errorWindow), index]);
    else if (testFailure.test(text)) ranges.push([index, index]);
  });
  let selected: string[];
  if (ranges.length === 0) {
    selected = lines.slice(-fallbackLines);
  } else {
    ranges.sort((left, right) => left[0] - right[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    selected = [];
    merged.forEach(([start, end], index) => {
      if (index > 0) selected.push('…');
      selected.push(...lines.slice(start, end + 1));
    });
  }
  return capKeepingEnd(selected.join('\n'));
}

function capKeepingEnd(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ciLogSummaryMaxBytes) return text;
  const marker = '…\n';
  const tail = bytes.subarray(bytes.length - (ciLogSummaryMaxBytes - Buffer.byteLength(marker))).toString('utf8');
  const newline = tail.indexOf('\n');
  const clean = newline >= 0 ? tail.slice(newline + 1) : tail.replace(/^�+/, '');
  return `${marker}${clean}`;
}
