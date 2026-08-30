import type { JsonEnvelope, WtmError } from '@wtm/protocol';

export interface OutputOptions {
  json: boolean;
}

export function renderEnvelope(envelope: JsonEnvelope<unknown>, options: OutputOptions): string {
  if (options.json) return JSON.stringify(envelope);

  const lines = [`${envelope.command}: ${envelope.ok ? 'ok' : 'failed'}`];
  // A command that answers with no payload — every failure, and `stop` with nothing to stop —
  // used to print the word `null` on a line of its own, above the reason it actually failed.
  if (envelope.data !== null && envelope.data !== undefined) renderValue(envelope.data, lines, 0);
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
    const itemDepth = key === undefined ? depth : depth + 1;
    for (const item of value) renderItem(item, lines, itemDepth);
    return;
  }

  if (key !== undefined) lines.push(`${indentation}${key}:`);
  const childDepth = key === undefined ? depth : depth + 1;
  for (const [childKey, child] of Object.entries(value)) {
    renderValue(child, lines, childDepth, childKey);
  }
}

/**
 * One element of a list. The dash opens the element and the rest of it lines up underneath,
 * which is the only thing that separates two records: a list of endpoint leases used to print
 * as one indistinguishable run of fields, and a list of strings printed each field as `-:`.
 */
function renderItem(item: unknown, lines: string[], depth: number): void {
  const indentation = '  '.repeat(depth);
  if (item === null || typeof item !== 'object') {
    lines.push(`${indentation}- ${String(item)}`);
    return;
  }
  const nested: string[] = [];
  renderValue(item, nested, depth + 1);
  const first = nested[0];
  if (first === undefined) {
    lines.push(`${indentation}- none`);
    return;
  }
  lines.push(`${indentation}- ${first.trimStart()}`, ...nested.slice(1));
}

function renderIssues(label: string, issues: WtmError[], lines: string[]): void {
  if (issues.length === 0) return;
  lines.push(`${label}:`);
  for (const issue of issues) lines.push(`  [${issue.code}] ${issue.message}`);
}
