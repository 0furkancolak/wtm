import { describe, expect, it } from 'bun:test';
import { jsonEnvelopeSchema } from './json-envelope.js';
import type { JsonEnvelope } from './json-envelope.js';

// A failed envelope must always carry a structured error for consumers.
// @ts-expect-error Failure envelopes cannot have an empty errors array.
const invalidFailure: JsonEnvelope<{}> = {
  schemaVersion: 1,
  ok: false,
  command: 'status',
  data: {},
  warnings: [],
  errors: [],
};
void invalidFailure;

describe('jsonEnvelopeSchema', () => {
  it('rejects an envelope without schemaVersion', () => {
    expect(() =>
      jsonEnvelopeSchema.parse({ ok: true, command: 'status', data: {} }),
    ).toThrow();
  });

  it('requires errors when an operation fails', () => {
    expect(() =>
      jsonEnvelopeSchema.parse({
        schemaVersion: 1,
        ok: false,
        command: 'status',
        data: {},
        warnings: [],
        errors: [],
      }),
    ).toThrow();
  });

  it('accepts the documented successful envelope shape', () => {
    expect(
      jsonEnvelopeSchema.parse({
        schemaVersion: 1,
        ok: true,
        command: 'status',
        scope: { mode: 'local', workspaceId: 'workspace-1' },
        data: { worktrees: [] },
        warnings: [],
        errors: [],
      }),
    ).toMatchObject({ schemaVersion: 1, ok: true, command: 'status' });
  });
});
