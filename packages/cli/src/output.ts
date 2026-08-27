import type { JsonEnvelope, WtmError } from '@wtm/protocol';

export interface OutputOptions {
  json: boolean;
}

export function renderEnvelope(envelope: JsonEnvelope<unknown>, options: OutputOptions): string {
  if (options.json) return JSON.stringify(envelope);

  const lines = [`${envelope.command}: ${envelope.ok ? 'ok' : 'failed'}`];
  renderValue(envelope.data, lines, 0);
  renderIssues('warnings', envelope.warnings, lines);
  renderIssues('errors', envelope.errors, lines);
  return lines.join('\n');
}

function renderValue(value: unknown, lines: string[], depth: number, key?: string): void {
  const indentation = '  '.repeat(depth);
  if (value === null || typeof value !== 'object') {
    lines.push(`${indentation}${key === undefined ? '' : `${key}: `}${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (key !== undefined) lines.push(`${indentation}${key}: none`);
      return;
    }
    if (key !== undefined) lines.push(`${indentation}${key}:`);
    for (const item of value) renderValue(item, lines, depth + 1, '-');
    return;
  }

  if (key !== undefined && key !== '-') lines.push(`${indentation}${key}:`);
  const childDepth = key === undefined ? depth : depth + 1;
  for (const [childKey, child] of Object.entries(value)) {
    renderValue(child, lines, childDepth, childKey);
  }
}

function renderIssues(label: string, issues: WtmError[], lines: string[]): void {
  if (issues.length === 0) return;
  lines.push(`${label}:`);
  for (const issue of issues) lines.push(`  [${issue.code}] ${issue.message}`);
}
