import { describe, expect, test } from 'bun:test';
import { renderEnvelope } from '../output';

const envelope = (data: unknown, ok = true) => ({
  schemaVersion: 1 as const,
  ok,
  command: 'status',
  data,
  warnings: [],
  errors: [],
});

describe('renderEnvelope, human output', () => {
  test('a list of records separates one record from the next', () => {
    const rendered = renderEnvelope(envelope({
      leases: [{ name: 'api', port: 4001 }, { name: 'client', port: 4002 }],
    }) as never, { json: false });
    expect(rendered).toBe([
      'status: ok',
      'leases:',
      '  - name: api',
      '    port: 4001',
      '  - name: client',
      '    port: 4002',
    ].join('\n'));
  });

  test('a list of plain values is written as a list, not as a key called dash', () => {
    const rendered = renderEnvelope(envelope({ argv: ['make', 'dev'] }) as never, { json: false });
    expect(rendered).toBe(['status: ok', 'argv:', '  - make', '  - dev'].join('\n'));
  });

  test('an empty payload says only what happened', () => {
    const rendered = renderEnvelope({
      schemaVersion: 1,
      ok: false,
      command: 'run',
      data: null,
      warnings: [],
      errors: [{ code: 'WTM_CONFIG_INVALID', message: 'Unknown task: nope', severity: 'error' }],
    } as never, { json: false });
    expect(rendered).toBe([
      'run: failed',
      'errors:',
      '  [WTM_CONFIG_INVALID] Unknown task: nope',
    ].join('\n'));
  });

  test('an empty list is named rather than left out', () => {
    expect(renderEnvelope(envelope({ processes: [] }) as never, { json: false }))
      .toBe(['status: ok', 'processes: none'].join('\n'));
  });

  test('nested records keep their indentation under the dash', () => {
    const rendered = renderEnvelope(envelope({
      workspaces: [{ workspace: { name: 'lab' }, leases: [{ port: 4000 }] }],
    }) as never, { json: false });
    expect(rendered).toBe([
      'status: ok',
      'workspaces:',
      '  - workspace:',
      '      name: lab',
      '    leases:',
      '      - port: 4000',
    ].join('\n'));
  });

  test('JSON output is untouched', () => {
    const value = envelope({ a: 1 });
    expect(renderEnvelope(value as never, { json: true })).toBe(JSON.stringify(value));
  });
});
